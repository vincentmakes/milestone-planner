"""
The metric engine (app/services/metrics.py): FACT_CASES, the calendar, periods.

``FACT_CASES`` is the engine's contract: each case is ``(name, facts, query,
expected)`` where ``expected`` holds the rows as ``((label, ...), value)``,
and optionally ``total``, ``unit``, ``warnings``, ``note``, ``truncated`` and
``period``. Dates sit in March 2026 unless a case says otherwise (2 March
2026 is a Monday; March has 22 weekdays).
"""

import json
import random
from datetime import date, timedelta
from typing import Any

import pytest

from app.schemas.dashboard import MetricQuery, WidgetIn
from app.services import metrics
from app.services.dashboard_seed import (
    BASE_DASHBOARDS,
    DEMO_EXTRA_WIDGETS,
    base_dashboard_rows,
    capacity_dashboard_rows,
)
from app.services.metrics import (
    AbsenceSpan,
    BookingFact,
    CapacityFact,
    ClosureSpan,
    EquipmentAvailabilityFact,
    EquipmentBookingFact,
    EquipmentInfo,
    Facts,
    FieldInfo,
    MetricError,
    OptionInfo,
    PhaseFact,
    ProjectFact,
    TagInfo,
    TeamInfo,
    Viewer,
    WorkingCalendar,
    aggregate,
    buckets,
    clip_to_card,
    expand_holidays,
    resolve_period,
    working_days,
)

TODAY = date(2026, 10, 23)
FULL = Viewer(
    frozenset({"views.staff", "views.equipment", "views.archived", "absences.view_others"})
)
MARCH = {"from": "2026-03-01", "to": "2026-03-31"}


def d(text: str) -> date:
    return date.fromisoformat(text)


def project(project_id: int = 1, **overrides: Any) -> ProjectFact:
    values: dict[str, Any] = {
        "id": project_id,
        "name": f"Project {project_id}",
        "site_id": 1,
        "site_name": None,
        "archived": False,
        "start": d("2026-01-01"),
        "end": d("2026-12-31"),
        "customer": None,
        "pm_id": None,
        "pm_name": None,
        "confirmed": False,
        "volume": None,
    }
    values.update(overrides)
    if "site_name" not in overrides and values["site_id"] is not None:
        values["site_name"] = f"Site {values['site_id']}"
    return ProjectFact(**values)


def booking(
    booking_id: int,
    start: str,
    end: str,
    *,
    project_id: int = 1,
    person: int = 1,
    allocation: int = 100,
    level: str = "project",
    team_ids: tuple[int, ...] = (),
    phase_type: str | None = None,
) -> BookingFact:
    return BookingFact(
        id=booking_id,
        level=level,
        project_id=project_id,
        person_id=person,
        person_name=PERSONS.get(person, f"Person {person}"),
        team_ids=team_ids,
        allocation=allocation,
        start=d(start),
        end=d(end),
        phase_type=phase_type,
    )


def card_booking(
    booking_id: int, own: tuple[str, str] | None, card: tuple[str, str], **kwargs: Any
) -> BookingFact | None:
    """A phase booking as the loader builds it: effective dates clipped to the card."""
    clipped = clip_to_card(
        d(own[0]) if own else None, d(own[1]) if own else None, d(card[0]), d(card[1])
    )
    if clipped is None:
        return None
    return booking(
        booking_id, clipped[0].isoformat(), clipped[1].isoformat(), level="phase", **kwargs
    )


PERSONS = {1: "Ann", 2: "Bob", 3: "Cid"}
# An HPLC at site 1, a mass spectrometer at both sites, an inactive oven
# without a type and a rig whose type is blank.
EQUIPMENT = {
    1: EquipmentInfo(1, "HPLC A", "HPLC", (1,), True),
    2: EquipmentInfo(2, "Mass spec", "MS", (1, 2), True),
    3: EquipmentInfo(3, "Old oven", None, (1,), False),
    4: EquipmentInfo(4, "Rig", "  ", (1,), True),
}


def facts(
    projects: list[ProjectFact] | None = None,
    bookings: list[BookingFact | None] | None = None,
    phases: list[PhaseFact] | None = None,
    holidays: dict[int, list[date]] | None = None,
    extent: tuple[date, date] | None = None,
    capacity: list[CapacityFact] | None = None,
    equipment_bookings: list[EquipmentBookingFact] | None = None,
    availability: list[EquipmentAvailabilityFact] | None = None,
    milestones: list[PhaseFact] | None = None,
) -> Facts:
    return Facts(
        projects={p.id: p for p in (projects if projects is not None else [project()])},
        phases=phases or [],
        bookings=[b for b in (bookings or []) if b is not None],
        holidays=holidays or {},
        persons=dict(PERSONS),
        teams={
            10: TeamInfo(10, "Alpha", "#111111", 1),
            11: TeamInfo(11, "Beta", None, 1),
        },
        fields={
            30: FieldInfo(30, "Type", "select", 0),
            31: FieldInfo(31, "Areas", "multiselect", 1),
            32: FieldInfo(32, "Internal", "toggle", 2),
            33: FieldInfo(33, "Notes", "text", 3),
        },
        options={
            300: OptionInfo(300, 30, "Internal", "#aaaaaa", 0),
            301: OptionInfo(301, 30, "Customer", "#bbbbbb", 1),
            310: OptionInfo(310, 31, "North", "#cccccc", 0),
            311: OptionInfo(311, 31, "South", "#dddddd", 1),
        },
        tags={
            20: TagInfo(20, "Red", "#ff0000", 0),
            21: TagInfo(21, "Blue", "#0000ff", 1),
            22: TagInfo(22, "Green", "#00ff00", 2),
        },
        sites={1: "Site 1", 2: "Site 2"},
        today=TODAY,
        extents={"exclude": extent},
        capacity={fact.person_id: fact for fact in capacity or []},
        equipment=dict(EQUIPMENT),
        equipment_bookings=equipment_bookings or [],
        equipment_availability=availability or [],
        milestones=milestones or [],
    )


def q(
    measure: str,
    dimensions: list[dict[str, Any]] | None = None,
    period: dict[str, str] | None = None,
    **extra: Any,
) -> MetricQuery:
    filters = {"period": period or MARCH, **extra.pop("filters", {})}
    return MetricQuery.model_validate(
        {"measure": measure, "dimensions": dimensions or [], "filters": filters, **extra}
    )


SITE = [{"kind": "site"}]
CONFIRMED = {"kind": "confirmed"}
TWO_SITES = [
    project(1, confirmed=True),
    project(2),
    project(3, site_id=2, confirmed=True),
]
TWO_SITE_BOOKINGS = [
    booking(1, "2026-03-02", "2026-03-06", project_id=1),
    booking(2, "2026-03-02", "2026-03-06", project_id=2, allocation=50),
    booking(3, "2026-03-02", "2026-03-06", project_id=3),
]

FACT_CASES: list[tuple[str, Facts, MetricQuery, dict[str, Any]]] = [
    (
        "allocation weighting",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06"),
                booking(2, "2026-03-09", "2026-03-13", allocation=50),
            ]
        ),
        q("booked_days"),
        {"rows": [((), 7.5)], "total": 7.5, "unit": "days"},
    ),
    (
        "booked weeks are booked days / 5",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06"),
                booking(2, "2026-03-09", "2026-03-13", allocation=50),
            ]
        ),
        q("booked_weeks"),
        {"rows": [((), 1.5)], "total": 1.5, "unit": "weeks"},
    ),
    (
        "weekend excluded",
        facts(bookings=[booking(1, "2026-03-06", "2026-03-09")]),
        q("booked_days"),
        {"rows": [((), 2)]},
    ),
    (
        "single-day holiday excluded",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06")], holidays={1: [d("2026-03-04")]}),
        q("booked_days"),
        {"rows": [((), 4)]},
    ),
    (
        "multi-day holiday excluded on every weekday it covers",
        facts(
            bookings=[booking(1, "2026-03-02", "2026-03-13")],
            holidays=expand_holidays(
                [(1, d("2026-03-05"), d("2026-03-10"))], (d("2026-03-01"), d("2026-03-31"))
            ),
        ),
        q("booked_days"),
        {"rows": [((), 6)]},
    ),
    (
        "another site's holiday does not count",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06")], holidays={2: [d("2026-03-04")]}),
        q("booked_days"),
        {"rows": [((), 5)]},
    ),
    (
        "site-less project: weekends only",
        facts(
            projects=[project(1, site_id=None)],
            bookings=[booking(1, "2026-03-02", "2026-03-06")],
            holidays={1: [d("2026-03-04")]},
        ),
        q("booked_days", SITE),
        {"rows": [(("No site",), 5)]},
    ),
    (
        "linked, unlinked and legacy-outside rows clipped to the card",
        facts(
            bookings=[
                # Linked: the whole card (10 weekdays).
                card_booking(1, None, ("2026-03-02", "2026-03-13")),
                # Unlinked segment inside the card: 2 days.
                card_booking(2, ("2026-03-09", "2026-03-10"), ("2026-03-02", "2026-03-13")),
                # Legacy segment partly before the card: clipped to 2-3 March.
                card_booking(3, ("2026-02-23", "2026-03-03"), ("2026-03-02", "2026-03-13")),
                # Legacy segment wholly outside: dropped.
                card_booking(4, ("2026-04-01", "2026-04-03"), ("2026-03-02", "2026-03-13")),
            ]
        ),
        q("booked_days"),
        {"rows": [((), 14)]},
    ),
    (
        "clipped rows still count once each",
        facts(
            bookings=[
                card_booking(1, None, ("2026-03-02", "2026-03-13")),
                card_booking(2, ("2026-03-09", "2026-03-10"), ("2026-03-02", "2026-03-13")),
                card_booking(3, ("2026-02-23", "2026-03-03"), ("2026-03-02", "2026-03-13")),
                card_booking(4, ("2026-04-01", "2026-04-03"), ("2026-03-02", "2026-03-13")),
            ]
        ),
        q("booking_count"),
        {"rows": [((), 3)], "unit": "count"},
    ),
    (
        "the period clips a span",
        facts(bookings=[booking(1, "2026-02-23", "2026-03-03")]),
        q("booked_days"),
        {"rows": [((), 2)]},
    ),
    (
        "month buckets, empty month zero-filled",
        facts(bookings=[booking(1, "2026-01-26", "2026-02-06")]),
        q(
            "booked_days",
            [{"kind": "period", "grain": "month"}],
            {"from": "2026-01-01", "to": "2026-03-31"},
        ),
        {
            "rows": [(("Jan 2026",), 5), (("Feb 2026",), 5), (("Mar 2026",), 0)],
            "keys": [["2026-01"], ["2026-02"], ["2026-03"]],
            "total": 10,
        },
    ),
    (
        "quarter boundary",
        facts(bookings=[booking(1, "2026-03-30", "2026-04-03")]),
        q(
            "booked_days",
            [{"kind": "period", "grain": "quarter"}],
            {"from": "2026-01-01", "to": "2026-06-30"},
        ),
        {"rows": [(("Q1 2026",), 2), (("Q2 2026",), 3)], "keys": [["2026-Q1"], ["2026-Q2"]]},
    ),
    (
        "year boundary, buckets clamped to the period",
        facts(
            projects=[project(1, start=d("2025-01-01"))],
            bookings=[booking(1, "2025-12-29", "2026-01-02")],
        ),
        q(
            "booked_days",
            [{"kind": "period", "grain": "year"}],
            {"from": "2025-12-01", "to": "2026-01-31"},
        ),
        {"rows": [(("2025",), 3), (("2026",), 2)], "keys": [["2025"], ["2026"]]},
    ),
    (
        "ISO weeks: 1-3 January 2027 belong to 2026-W53",
        facts(
            projects=[project(1, end=d("2027-12-31"))],
            bookings=[booking(1, "2026-12-30", "2027-01-05")],
        ),
        q(
            "booked_days",
            [{"kind": "period", "grain": "week"}],
            {"from": "2026-12-28", "to": "2027-01-10"},
        ),
        {
            "rows": [(("W53 2026",), 3), (("W01 2027",), 2)],
            "keys": [["2026-W53"], ["2027-W01"]],
        },
    ),
    (
        "two dimensions",
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", [{"kind": "site"}, CONFIRMED]),
        {
            "rows": [
                (("Site 1", "Confirmed"), 5),
                (("Site 1", "Not confirmed"), 2.5),
                (("Site 2", "Confirmed"), 5),
            ],
            "keys": [[1, True], [1, False], [2, True]],
            "total": 12.5,
        },
    ),
    (
        "percent of total",
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", SITE, percent_of="total"),
        {"rows": [(("Site 1",), 60), (("Site 2",), 40)], "total": 100, "unit": "percent"},
    ),
    (
        "percent of the first dimension",
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", [{"kind": "site"}, CONFIRMED], percent_of="first_dimension"),
        {
            "rows": [
                (("Site 1", "Confirmed"), 66.67),
                (("Site 1", "Not confirmed"), 33.33),
                (("Site 2", "Confirmed"), 100),
            ],
            "unit": "percent",
        },
    ),
    (
        "top N + Other, distinct recomputation",
        facts(
            projects=[
                project(1, tag_ids=(20, 22)),
                project(2, tag_ids=(21,)),
                project(3, tag_ids=(21,)),
            ],
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", project_id=1),
                booking(2, "2026-03-02", "2026-03-06", project_id=2),
                booking(3, "2026-03-02", "2026-03-06", project_id=3),
                booking(4, "2026-03-09", "2026-03-13", project_id=2),
            ],
        ),
        q("booking_count", [{"kind": "tag"}], top_n=1),
        # Red and Green both hold booking 1: Other counts it once, the total too.
        {
            "rows": [(("Blue",), 3), (("Other",), 1)],
            "keys": [[21], ["__other__"]],
            "total": 4,
            "note": "A booking of a project with several tags counts in each",
        },
    ),
    (
        "top N keeps everything when there are few values",
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", SITE, top_n=5),
        {"rows": [(("Site 1",), 7.5), (("Site 2",), 5)]},
    ),
    (
        "top N on two dimensions keeps the second split in Other",
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", [{"kind": "project"}, CONFIRMED], top_n=1),
        {
            "rows": [
                (("Project 1", "Confirmed"), 5),
                (("Other", "Confirmed"), 5),
                (("Other", "Not confirmed"), 2.5),
            ],
            "total": 12.5,
        },
    ),
    (
        "a booking in two teams counts in each, once in the total",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", team_ids=(10, 11)),
                booking(2, "2026-03-09", "2026-03-13", person=2),
            ]
        ),
        q("booked_days", [{"kind": "team"}]),
        {
            "rows": [(("Alpha",), 5), (("Beta",), 5), (("No team",), 5)],
            "keys": [[10], [11], [None]],
            "total": 10,
            "note": "A booking in several teams counts in each",
        },
    ),
    (
        "people booked are distinct",
        facts(
            projects=[project(1), project(2)],
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", project_id=1),
                booking(2, "2026-03-09", "2026-03-13", project_id=2),
                booking(3, "2026-03-09", "2026-03-13", project_id=2, person=2),
            ],
        ),
        q("people_booked", [{"kind": "project"}]),
        {"rows": [(("Project 1",), 1), (("Project 2",), 2)], "total": 2, "unit": "people"},
    ),
    (
        "archived projects are excluded by default",
        facts(projects=[project(1, archived=True), project(2)]),
        q("project_count"),
        {"rows": [((), 1)], "unit": "projects"},
    ),
    (
        "archived: include",
        facts(projects=[project(1, archived=True), project(2)]),
        q("project_count", filters={"archived": "include"}),
        {"rows": [((), 2)]},
    ),
    (
        "archived: only",
        facts(projects=[project(1, archived=True), project(2)]),
        q("project_count", [{"kind": "project"}], filters={"archived": "only"}),
        {"rows": [(("Project 1",), 1)]},
    ),
    (
        "project weeks are prorated per bucket",
        facts(projects=[project(1, start=d("2026-01-26"), end=d("2026-02-06"))]),
        q(
            "project_weeks",
            [{"kind": "period", "grain": "month"}],
            {"from": "2026-01-01", "to": "2026-03-31"},
        ),
        {"rows": [(("Jan 2026",), 1), (("Feb 2026",), 1), (("Mar 2026",), 0)], "total": 2},
    ),
    (
        "project count: a project counts in every bucket it touches",
        facts(projects=[project(1, start=d("2026-01-26"), end=d("2026-02-06"))]),
        q(
            "project_count",
            [{"kind": "period", "grain": "month"}],
            {"from": "2026-01-01", "to": "2026-03-31"},
        ),
        {"rows": [(("Jan 2026",), 1), (("Feb 2026",), 1), (("Mar 2026",), 0)], "total": 1},
    ),
    (
        "project outside the period is not counted",
        facts(projects=[project(1, start=d("2026-05-01"), end=d("2026-06-30")), project(2)]),
        q("project_count"),
        {"rows": [((), 1)]},
    ),
    (
        "volume once per project",
        facts(
            projects=[
                project(1, volume=100.0, tag_ids=(20, 21)),
                project(2, volume=50.0, tag_ids=(21,)),
                project(3, volume=None),
            ]
        ),
        q("project_volume", [{"kind": "tag"}]),
        {
            "rows": [(("Blue",), 150), (("Red",), 100), (("No tag",), 0)],
            "total": 150,
            "unit": "volume",
            "note": "A project with several tags counts in each",
        },
    ),
    (
        "empty result",
        facts(),
        q("booked_days", SITE),
        {"rows": [], "total": 0},
    ),
    (
        "no dimension, nothing booked",
        facts(),
        q("booked_weeks"),
        {"rows": [((), 0)], "total": 0},
    ),
    (
        "all: the extent of the facts",
        facts(extent=(d("2026-01-05"), d("2026-02-27"))),
        MetricQuery.model_validate(
            {"measure": "project_count", "filters": {"period": {"relative": "all"}}}
        ),
        {"rows": [((), 1)], "truncated": False, "period": ("2026-01-05", "2026-02-27")},
    ),
    (
        "all: cut to the five years ending with the extent's end",
        facts(extent=(d("2015-01-01"), d("2026-12-31"))),
        MetricQuery.model_validate(
            {"measure": "project_count", "filters": {"period": {"relative": "all"}}}
        ),
        {
            "rows": [((), 1)],
            "truncated": True,
            "period": ((d("2026-12-31") - timedelta(days=1825)).isoformat(), "2026-12-31"),
        },
    ),
    (
        "empty buckets: no manager, no customer",
        facts(projects=[project(1, site_id=None, customer="  ")]),
        q(
            "project_count",
            [{"kind": "project_manager"}, {"kind": "customer"}],
        ),
        {"rows": [(("No manager", "No customer"), 1)], "keys": [[None, None]]},
    ),
    (
        "empty buckets: no tag, no project team",
        facts(),
        q("project_count", [{"kind": "tag"}, {"kind": "project_team"}]),
        {"rows": [(("No tag", "No team"), 1)]},
    ),
    (
        "empty buckets: no site",
        facts(projects=[project(1, site_id=None)]),
        q("project_count", SITE),
        {"rows": [(("No site",), 1)]},
    ),
    (
        "empty buckets: field not set, no team, no phase",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06")]),
        q("booking_count", [{"kind": "field", "field_id": 30}, {"kind": "phase_type"}]),
        {"rows": [(("Not set", "No phase"), 1)]},
    ),
    (
        "empty buckets: no team for the person",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06")]),
        q("booking_count", [{"kind": "team"}]),
        {"rows": [(("No team",), 1)]},
    ),
    (
        "named buckets: manager, customer, person",
        facts(
            projects=[project(1, pm_id=2, pm_name="Bob", customer="Acme")],
            bookings=[booking(1, "2026-03-02", "2026-03-06", person=3)],
        ),
        q("booking_count", [{"kind": "project_manager"}, {"kind": "person"}]),
        {"rows": [(("Bob", "Cid"), 1)], "keys": [[2, 3]]},
    ),
    (
        "customer and project team names",
        facts(projects=[project(1, customer="Acme", team_ids=(10,))]),
        q("project_count", [{"kind": "customer"}, {"kind": "project_team"}]),
        {"rows": [(("Acme", "Alpha"), 1)], "keys": [["Acme", 10]]},
    ),
    (
        "stale ids are dropped with a warning",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06", team_ids=(10,))]),
        q(
            "booked_days",
            filters={
                "site_ids": [97],
                "team_ids": [10, 99],
                "project_team_ids": [93],
                "person_ids": [98],
                "project_ids": [96],
                "project_manager_ids": [94],
                "tag_ids": [95],
                "field_options": {"30": [999], "88": [1]},
            },
        ),
        {
            "rows": [((), 5)],
            "warnings": [
                "Site 97 no longer exists",
                "Team 99 no longer exists",
                "Team 93 no longer exists",
                "Person 98 no longer exists",
                "Project 96 no longer exists",
                "Person 94 no longer exists",
                "Tag 95 no longer exists",
                "Item 999 no longer exists",
                "Project field 88 no longer exists",
            ],
        },
    ),
    (
        "an item of another field is stale for this one",
        facts(),
        q("project_count", filters={"field_options": {"30": [310]}}),
        {"rows": [((), 1)], "warnings": ["Item 310 no longer exists"]},
    ),
    (
        "select field: items in item order with their colour",
        facts(
            projects=[
                project(1, field_values={30: 301}),
                project(2, field_values={30: 300}),
                project(3),
            ]
        ),
        q("project_count", [{"kind": "field", "field_id": 30}]),
        {
            "rows": [(("Internal",), 1), (("Customer",), 1), (("Not set",), 1)],
            "colors": [["#aaaaaa"], ["#bbbbbb"], [None]],
        },
    ),
    (
        "multiselect field: counted in each item, with a note",
        facts(projects=[project(1, field_values={31: [310, 311]}), project(2)]),
        q("project_count", [{"kind": "field", "field_id": 31}]),
        {
            "rows": [(("North",), 1), (("South",), 1), (("Not set",), 1)],
            "total": 2,
            "note": 'A project with several "Areas" items counts in each',
        },
    ),
    (
        "toggle field: Yes before No",
        facts(
            projects=[
                project(1, field_values={32: False}),
                project(2, field_values={32: True}),
            ]
        ),
        q("project_count", [{"kind": "field", "field_id": 32}]),
        {"rows": [(("Yes",), 1), (("No",), 1)], "keys": [[True], [False]]},
    ),
    (
        "filters: tags, confirmed, field items, project teams",
        facts(
            projects=[
                project(1, tag_ids=(20,), confirmed=True, field_values={30: 300}, team_ids=(10,)),
                project(2, tag_ids=(20,), confirmed=True, field_values={30: 301}, team_ids=(10,)),
                project(3, tag_ids=(21,), confirmed=True, field_values={30: 300}, team_ids=(10,)),
                project(4, tag_ids=(20,), confirmed=False, field_values={30: 300}, team_ids=(10,)),
                project(5, tag_ids=(20,), confirmed=True, field_values={30: 300}),
            ]
        ),
        q(
            "project_count",
            [{"kind": "project"}],
            filters={
                "tag_ids": [20],
                "confirmed": True,
                "field_options": {"30": [300]},
                "project_team_ids": [10],
            },
        ),
        {"rows": [(("Project 1",), 1)]},
    ),
    (
        "filters: sites, projects, managers",
        facts(
            projects=[
                project(1, pm_id=2),
                project(2, pm_id=2, site_id=2),
                project(3, pm_id=3),
            ]
        ),
        q(
            "project_count",
            [{"kind": "project"}],
            filters={"site_ids": [1], "project_ids": [1, 3], "project_manager_ids": [2]},
        ),
        {"rows": [(("Project 1",), 1)]},
    ),
    (
        "filters: the person's teams and people",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", team_ids=(10,)),
                booking(2, "2026-03-02", "2026-03-06", person=2, team_ids=(10,)),
                booking(3, "2026-03-02", "2026-03-06", person=3, team_ids=(11,)),
            ]
        ),
        q("booking_count", [{"kind": "person"}], filters={"team_ids": [10], "person_ids": [2, 3]}),
        {"rows": [(("Bob",), 1)]},
    ),
    (
        "phases: count by type, milestones are one day",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Build", d("2026-03-16"), d("2026-04-30")),
                PhaseFact(3, 1, "Gate", d("2026-03-31"), d("2026-03-31"), is_milestone=True),
                PhaseFact(4, 1, "Late", d("2026-05-01"), d("2026-05-31")),
            ]
        ),
        q("phase_count", [{"kind": "phase_type"}]),
        {
            "rows": [(("Build",), 1), (("Design",), 1), (("Gate",), 1)],
            "unit": "phases",
            "total": 3,
        },
    ),
    (
        "phase weeks are prorated, a weekday milestone is a fifth of a week",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(3, 1, "Gate", d("2026-03-31"), d("2026-03-31"), is_milestone=True),
            ]
        ),
        q("phase_weeks", [{"kind": "phase_type"}]),
        {"rows": [(("Design",), 2), (("Gate",), 0.2)], "total": 2.2, "unit": "weeks"},
    ),
    (
        "phases by status, in board order",
        facts(
            phases=[
                PhaseFact(1, 1, "A", d("2026-03-02"), d("2026-03-06"), False, "done"),
                PhaseFact(2, 1, "B", d("2026-03-02"), d("2026-03-06"), False, "blocked"),
                PhaseFact(3, 1, "C", d("2026-03-02"), d("2026-03-06")),
                PhaseFact(4, 1, "D", d("2026-03-02"), d("2026-03-06"), False, "in_progress"),
                PhaseFact(5, 1, "E", d("2026-03-09"), d("2026-03-13"), False, "done"),
            ]
        ),
        q("phase_count", [{"kind": "status"}]),
        {
            "rows": [(("To do",), 1), (("In progress",), 1), (("Blocked",), 1), (("Done",), 2)],
            "keys": [["todo"], ["in_progress"], ["blocked"], ["done"]],
            "total": 5,
        },
    ),
    (
        "phases due are filed by their end date, once; a milestone on its date",
        facts(
            phases=[
                PhaseFact(1, 1, "Span", d("2026-02-02"), d("2026-04-15")),
                PhaseFact(2, 1, "Short", d("2026-02-02"), d("2026-02-20")),
                PhaseFact(3, 1, "Gate", d("2026-03-10"), d("2026-03-10"), is_milestone=True),
                # Due after the period: not due in it.
                PhaseFact(4, 1, "Later", d("2026-03-02"), d("2026-05-04")),
            ]
        ),
        q(
            "phases_due",
            [{"kind": "period", "grain": "month"}],
            {"from": "2026-02-01", "to": "2026-04-30"},
        ),
        {
            "rows": [(("Feb 2026",), 1), (("Mar 2026",), 1), (("Apr 2026",), 1)],
            "total": 3,
            "unit": "phases",
        },
    ),
    (
        "phases overdue: due before today and not done",
        facts(
            phases=[
                PhaseFact(1, 1, "Late", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Finished", d("2026-03-02"), d("2026-03-13"), False, "done"),
                PhaseFact(3, 1, "Future", d("2026-10-01"), d("2026-11-30")),
                PhaseFact(4, 1, "Yesterday", d("2026-10-01"), d("2026-10-22"), False, "blocked"),
                # Due today (2026-10-23) is not overdue yet.
                PhaseFact(5, 1, "Today", d("2026-10-01"), d("2026-10-23")),
                PhaseFact(6, 1, "Gate", d("2026-06-01"), d("2026-06-01"), True, "in_progress"),
            ]
        ),
        q("phases_overdue", [{"kind": "status"}], {"from": "2026-01-01", "to": "2026-12-31"}),
        {
            "rows": [(("To do",), 1), (("In progress",), 1), (("Blocked",), 1)],
            "total": 3,
            "unit": "phases",
        },
    ),
    (
        "milestones: only",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Gate", d("2026-03-20"), d("2026-03-20"), is_milestone=True),
            ]
        ),
        q("phase_count", [{"kind": "phase_type"}], filters={"milestones": "only"}),
        {"rows": [(("Gate",), 1)], "total": 1},
    ),
    (
        "milestones: exclude",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Gate", d("2026-03-20"), d("2026-03-20"), is_milestone=True),
            ]
        ),
        q("phase_weeks", [{"kind": "phase_type"}], filters={"milestones": "exclude"}),
        {"rows": [(("Design",), 2)], "total": 2},
    ),
    (
        "milestones: only, on phases due",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Gate", d("2026-03-20"), d("2026-03-20"), is_milestone=True),
                PhaseFact(3, 1, "Gate", d("2026-04-20"), d("2026-04-20"), is_milestone=True),
            ]
        ),
        q("phases_due", filters={"milestones": "only"}),
        {"rows": [((), 1)], "total": 1},
    ),
    (
        "a milestone below a phase is due on its date, in its month (ids apart from phases')",
        facts(
            phases=[PhaseFact(1, 1, "Design", d("2026-02-02"), d("2026-03-13"))],
            # Subphase 1: the same id as phase 1, counted on its own.
            milestones=[PhaseFact(1, 1, "Design", d("2026-04-10"), d("2026-04-10"), True)],
        ),
        q(
            "phases_due",
            [{"kind": "period", "grain": "month"}],
            {"from": "2026-02-01", "to": "2026-04-30"},
        ),
        {"rows": [(("Feb 2026",), 0), (("Mar 2026",), 1), (("Apr 2026",), 1)], "total": 2},
    ),
    (
        "a late milestone below a phase is overdue unless done; by its top phase's type",
        facts(
            phases=[PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13"), False, "done")],
            milestones=[
                PhaseFact(5, 1, "Design", d("2026-06-01"), d("2026-06-01"), True, "blocked"),
                PhaseFact(6, 1, "Build", d("2026-06-02"), d("2026-06-02"), True, "done"),
                PhaseFact(7, 1, "Build", d("2026-11-02"), d("2026-11-02"), True),
            ],
        ),
        q(
            "phases_overdue",
            [{"kind": "phase_type"}, {"kind": "status"}],
            {"from": "2026-01-01", "to": "2026-12-31"},
        ),
        {"rows": [(("Design", "Blocked"), 1)], "total": 1},
    ),
    (
        "milestones: only, on phases due, counts the milestones below a phase too",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Gate", d("2026-03-20"), d("2026-03-20"), is_milestone=True),
            ],
            milestones=[PhaseFact(3, 1, "Design", d("2026-03-25"), d("2026-03-25"), True)],
        ),
        q("phases_due", filters={"milestones": "only"}),
        {"rows": [((), 2)], "total": 2},
    ),
    (
        "milestones: exclude, on phases due, leaves the milestones below a phase out",
        facts(
            phases=[PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13"))],
            milestones=[PhaseFact(3, 1, "Design", d("2026-03-25"), d("2026-03-25"), True)],
        ),
        q("phases_due", filters={"milestones": "exclude"}),
        {"rows": [((), 1)], "total": 1},
    ),
    (
        "Phases count top-level phases only, milestones: only included",
        facts(
            phases=[
                PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-13")),
                PhaseFact(2, 1, "Gate", d("2026-03-20"), d("2026-03-20"), is_milestone=True),
            ],
            milestones=[PhaseFact(3, 1, "Design", d("2026-03-25"), d("2026-03-25"), True)],
        ),
        q("phase_count", filters={"milestones": "only"}),
        {"rows": [((), 1)], "total": 1},
    ),
    (
        "Phases and Phase weeks never read the milestones below a phase",
        facts(milestones=[PhaseFact(3, 1, "Design", d("2026-03-25"), d("2026-03-25"), True)]),
        q("phase_weeks"),
        {"rows": [((), 0)], "total": 0},
    ),
    (
        "an unknown stored status sorts after Done",
        facts(phases=[PhaseFact(1, 1, "A", d("2026-03-02"), d("2026-03-06"), False, "odd")]),
        q("phases_due", [{"kind": "status"}]),
        {"rows": [(("odd",), 1)]},
    ),
    (
        "booking phase type",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", level="phase", phase_type="Design"),
                booking(2, "2026-03-09", "2026-03-13", level="subphase", phase_type="Design"),
            ]
        ),
        q("booked_weeks", [{"kind": "phase_type"}]),
        {"rows": [(("Design",), 2)]},
    ),
    (
        "a booking whose project is out of scope is ignored",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06", project_id=9)]),
        q("booked_days"),
        {"rows": [((), 0)]},
    ),
]

# --- The capacity family (round 3, Task 2) ---------------------------------------
# A person's capacity is built like the loader builds it (``person_off_days``
# over March 2026, the teams of ``facts()``: Alpha and Beta at site 1).

MARCH_DAYS = (d("2026-03-01"), d("2026-03-31"))
FACT_TEAM_SITES = {10: 1, 11: 1}


def absence(start: str, end: str, description: str | None = None, unavailable: bool = True):
    return AbsenceSpan(d(start), d(end), description, unavailable)


def closure(start: str, end: str, sites: tuple[int, ...] = (1,), teams: tuple[int, ...] = ()):
    return ClosureSpan(d(start), d(end), sites, teams)


def person_capacity(
    person: int = 1,
    *,
    sites: tuple[int, ...] = (1,),
    teams: tuple[int, ...] = (),
    max_capacity: int = 100,
    holidays: dict[int, list[date]] | None = None,
    absences: tuple[AbsenceSpan, ...] = (),
    closures: tuple[ClosureSpan, ...] = (),
) -> CapacityFact:
    off_days = metrics.person_off_days(
        MARCH_DAYS, sites, teams, holidays or {}, absences, closures, FACT_TEAM_SITES
    )
    return CapacityFact(
        person, PERSONS.get(person, f"Person {person}"), sites, teams, max_capacity, off_days
    )


PERSON = [{"kind": "person"}]
TEAM = [{"kind": "team"}]
WEEKS = [{"kind": "period", "grain": "week"}]
MONTHS = [{"kind": "period", "grain": "month"}]
ON_LEAVE = (absence("2026-03-01", "2026-03-31"),)
TWO_SITE_HOLIDAY = {2: [d("2026-03-04")]}

CAPACITY_CASES: list[tuple[str, Facts, MetricQuery, dict[str, Any]]] = [
    (
        "utilisation: booked 10 of March's 22 weekdays",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-13")], capacity=[person_capacity()]),
        q("utilisation"),
        {"rows": [((), 45.45)], "total": 45.45, "unit": "percent"},
    ),
    (
        "capacity days: every weekday of the period",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-13")], capacity=[person_capacity()]),
        q("capacity_days"),
        {"rows": [((), 22)], "total": 22, "unit": "days"},
    ),
    (
        "available days: capacity less booked",
        facts(bookings=[booking(1, "2026-03-02", "2026-03-13")], capacity=[person_capacity()]),
        q("available_days"),
        {"rows": [((), 12)], "total": 12, "unit": "days"},
    ),
    (
        "a 50 % person has half the capacity",
        facts(capacity=[person_capacity(max_capacity=50)]),
        q("capacity_days"),
        {"rows": [((), 11)]},
    ),
    (
        "an unavailable absence week subtracts, a Home Office week does not",
        facts(
            capacity=[
                person_capacity(
                    absences=(
                        absence("2026-03-09", "2026-03-13", "Holidays"),
                        absence("2026-03-16", "2026-03-20", "Home office", unavailable=False),
                    )
                )
            ]
        ),
        q("capacity_days"),
        {"rows": [((), 17)]},
    ),
    (
        "a recurring [R:1,3] absence takes March's Mondays and Wednesdays",
        facts(
            capacity=[
                person_capacity(absences=(absence("2026-02-01", "2026-04-30", "[R:1,3] Course"),))
            ]
        ),
        q("capacity_days"),
        {"rows": [((), 13)]},  # 22 - (5 Mondays + 4 Wednesdays)
    ),
    (
        "a whole-site closure of three weekdays subtracts",
        facts(capacity=[person_capacity(closures=(closure("2026-03-25", "2026-03-27"),))]),
        q("capacity_days"),
        {"rows": [((), 19)]},
    ),
    (
        "a team-limited closure subtracts for its members only",
        facts(
            capacity=[
                person_capacity(
                    1, teams=(10,), closures=(closure("2026-03-25", "2026-03-27", teams=(10,)),)
                ),
                person_capacity(
                    2, teams=(11,), closures=(closure("2026-03-25", "2026-03-27", teams=(10,)),)
                ),
            ]
        ),
        q("capacity_days", PERSON),
        {"rows": [(("Ann",), 19), (("Bob",), 22)], "total": 41},
    ),
    (
        "a holiday at one of a two-site person's sites: once in the total, in both rows",
        facts(
            holidays=TWO_SITE_HOLIDAY,
            capacity=[person_capacity(sites=(1, 2), holidays=TWO_SITE_HOLIDAY)],
        ),
        q("capacity_days", SITE),
        {
            "rows": [(("Site 1",), 21), (("Site 2",), 21)],
            "total": 21,
            "note": "A person at several sites counts in each",
        },
    ),
    (
        "utilisation by site reads the person's sites on both sides",
        facts(
            holidays=TWO_SITE_HOLIDAY,
            bookings=[booking(1, "2026-03-02", "2026-03-13")],  # project at site 1
            capacity=[person_capacity(sites=(1, 2), holidays=TWO_SITE_HOLIDAY)],
        ),
        q("utilisation", SITE),
        {
            "rows": [(("Site 1",), 47.62), (("Site 2",), 47.62)],  # 10 / 21
            "total": 47.62,
            "note": "A person at several sites counts in each",
        },
    ),
    (
        "a booked person without a capacity is ignored on both sides",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06"),
                booking(2, "2026-03-02", "2026-03-06", person=2),
            ],
            capacity=[person_capacity(1)],
        ),
        q("utilisation", PERSON),
        {"rows": [(("Ann",), 22.73)], "total": 22.73},
    ),
    (
        "a zero-capacity week with booked time is empty, without it 0",
        facts(
            bookings=[booking(1, "2026-03-09", "2026-03-13")],
            capacity=[person_capacity(absences=ON_LEAVE)],
        ),
        q("utilisation", WEEKS),
        {
            "rows": [
                (("W09 2026",), 0.0),
                (("W10 2026",), 0.0),
                (("W11 2026",), None),
                (("W12 2026",), 0.0),
                (("W13 2026",), 0.0),
                (("W14 2026",), 0.0),
            ],
            "total": None,
        },
    ),
    (
        "nothing booked and no capacity: 0",
        facts(capacity=[person_capacity(absences=ON_LEAVE)]),
        q("utilisation"),
        {"rows": [((), 0.0)], "total": 0.0},
    ),
    (
        "available days go negative when booked over capacity",
        facts(
            bookings=[booking(1, "2026-03-02", "2026-03-31")],
            capacity=[person_capacity(max_capacity=50)],
        ),
        q("available_days"),
        {"rows": [((), -11)], "total": -11},
    ),
    (
        "people over capacity by team",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-31"),
                booking(2, "2026-03-02", "2026-03-06", allocation=50),  # 24.5 > 22
                booking(3, "2026-03-02", "2026-03-13", person=2, allocation=50),  # 5 < 22
            ],
            capacity=[person_capacity(1, teams=(10,)), person_capacity(2, teams=(11,))],
        ),
        q("people_over_capacity", TEAM),
        {"rows": [(("Alpha",), 1), (("Beta",), 0)], "total": 1, "unit": "people"},
    ),
    (
        "people over capacity by month: the total is per person over the period",
        facts(
            bookings=[
                # Ann: over in February (30 / 20) and March (33 / 22).
                booking(1, "2026-02-02", "2026-03-31"),
                booking(2, "2026-02-02", "2026-03-31", allocation=50),
                # Bob: over in February (22.5 / 20), not over the two months.
                booking(3, "2026-02-02", "2026-02-27", person=2),
                booking(4, "2026-02-02", "2026-02-06", person=2, allocation=50),
            ],
            capacity=[person_capacity(1), person_capacity(2)],
        ),
        q("people_over_capacity", MONTHS, {"from": "2026-02-01", "to": "2026-03-31"}),
        {"rows": [(("Feb 2026",), 2), (("Mar 2026",), 1)], "total": 1},
    ),
    (
        "booked time without a capacity is over capacity",
        facts(
            bookings=[booking(1, "2026-03-02", "2026-03-06")],
            capacity=[person_capacity(absences=ON_LEAVE)],
        ),
        q("people_over_capacity"),
        {"rows": [((), 1)], "total": 1},
    ),
    (
        "archived projects' bookings are left out by default",
        facts(
            projects=[project(1), project(2, archived=True)],
            bookings=[booking(1, "2026-03-02", "2026-03-06", project_id=2)],
            capacity=[person_capacity()],
        ),
        q("utilisation"),
        {"rows": [((), 0.0)], "total": 0.0},
    ),
    (
        "archived: include counts them",
        facts(
            projects=[project(1), project(2, archived=True)],
            bookings=[booking(1, "2026-03-02", "2026-03-06", project_id=2)],
            capacity=[person_capacity()],
        ),
        q("utilisation", filters={"archived": "include"}),
        {"rows": [((), 22.73)], "total": 22.73},
    ),
    (
        "archived: only counts nothing else",
        facts(
            projects=[project(1), project(2, archived=True)],
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", project_id=2),
                booking(2, "2026-03-02", "2026-03-13", project_id=1),
            ],
            capacity=[person_capacity()],
        ),
        q("available_days", filters={"archived": "only"}),
        {"rows": [((), 17)], "total": 17},
    ),
    (
        "top N ranks utilisation by the ratio",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-17"),  # Ann 12 / 22
                booking(2, "2026-03-02", "2026-03-13", person=2),  # Bob 10 / 11
                booking(3, "2026-03-02", "2026-03-16", person=3),  # Cid 11 / 22
            ],
            capacity=[person_capacity(1), person_capacity(2, max_capacity=50), person_capacity(3)],
        ),
        q("utilisation", PERSON, top_n=2),
        {
            "rows": [(("Ann",), 54.55), (("Bob",), 90.91), (("Other",), 50.0)],
            "total": 60.0,  # 33 / 55
        },
    ),
    (
        "the Sites filter matches the person's sites, not the project's",
        facts(
            projects=[project(1), project(3, site_id=2)],
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", project_id=3),  # Ann, a site-2 project
                booking(2, "2026-03-02", "2026-03-06", person=2),  # Bob, at site 2
            ],
            capacity=[person_capacity(1, sites=(1,)), person_capacity(2, sites=(2,))],
        ),
        q("utilisation", PERSON, filters={"site_ids": [1]}),
        {"rows": [(("Ann",), 22.73)], "total": 22.73},
    ),
    (
        "the Teams filter matches the person's teams, not the booking's",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06", team_ids=(11,)),
                booking(2, "2026-03-02", "2026-03-06", person=2, team_ids=(10,)),
            ],
            capacity=[person_capacity(1, teams=(10,)), person_capacity(2, teams=(11,))],
        ),
        q("utilisation", PERSON, filters={"team_ids": [11]}),
        {"rows": [(("Bob",), 22.73)], "total": 22.73},
    ),
    (
        "the People filter keeps those people on both sides",
        facts(
            bookings=[
                booking(1, "2026-03-02", "2026-03-06"),
                booking(2, "2026-03-02", "2026-03-13", person=2),
            ],
            capacity=[person_capacity(1), person_capacity(2)],
        ),
        q("available_days", filters={"person_ids": [2]}),
        {"rows": [((), 12)], "total": 12},
    ),
    (
        "a person in two teams counts in each, one in none under No team",
        facts(capacity=[person_capacity(1, teams=(10, 11)), person_capacity(2)]),
        q("capacity_days", TEAM),
        {
            "rows": [(("Alpha",), 22), (("Beta",), 22), (("No team",), 22)],
            "total": 44,
            "note": "A person in several teams counts in each",
        },
    ),
    (
        "capacity by month adds up",
        facts(capacity=[person_capacity()]),
        q("capacity_days", MONTHS, {"from": "2026-02-01", "to": "2026-03-31"}),
        {"rows": [(("Feb 2026",), 20), (("Mar 2026",), 22)], "total": 42},
    ),
    (
        "capacity days as a share of the total",
        facts(capacity=[person_capacity(1), person_capacity(2, max_capacity=50)]),
        q("capacity_days", PERSON, percent_of="total"),
        {"rows": [(("Ann",), 66.67), (("Bob",), 33.33)], "total": 100.0, "unit": "percent"},
    ),
]
FACT_CASES += CAPACITY_CASES

# --- The equipment family (round 3, Task 3) --------------------------------------
# Availability is built like the loader builds it (``equipment_off_days`` over
# March 2026); March has 22 weekdays.


def used(booking_id: int, start: str, end: str, *, equipment: int = 1, project_id: int = 1):
    return EquipmentBookingFact(booking_id, project_id, equipment, d(start), d(end))


def available(
    equipment_id: int = 1,
    *,
    holidays: dict[int, list[date]] | None = None,
    blocks: tuple[tuple[str, str], ...] = (),
    period: tuple[date, date] = MARCH_DAYS,
) -> EquipmentAvailabilityFact:
    sites = EQUIPMENT[equipment_id].site_ids
    off_days = metrics.equipment_off_days(
        period, sites, holidays or {}, [(d(first), d(last)) for first, last in blocks]
    )
    return EquipmentAvailabilityFact(equipment_id, sites, off_days)


BY_EQUIPMENT = [{"kind": "equipment"}]
BY_TYPE = [{"kind": "equipment_type"}]
FIRST_WEEK = used(1, "2026-03-02", "2026-03-06")
SPRING = {"from": "2026-03-01", "to": "2026-04-30"}

EQUIPMENT_CASES: list[tuple[str, Facts, MetricQuery, dict[str, Any]]] = [
    (
        "equipment booked days: whole days of the project site's calendar",
        facts(
            projects=TWO_SITES,
            holidays={1: [d("2026-03-04")]},
            equipment_bookings=[
                used(1, "2026-03-02", "2026-03-06"),
                used(2, "2026-03-02", "2026-03-06", equipment=2, project_id=3),
            ],
        ),
        q("equipment_booked_days", SITE),
        {"rows": [(("Site 1",), 4), (("Site 2",), 5)], "total": 9, "unit": "days"},
    ),
    (
        "equipment booked days by equipment",
        facts(
            equipment_bookings=[
                FIRST_WEEK,
                used(2, "2026-03-09", "2026-03-10", equipment=2),
                used(3, "2026-03-16", "2026-03-20"),
            ]
        ),
        q("equipment_booked_days", BY_EQUIPMENT),
        {"rows": [(("HPLC A",), 10), (("Mass spec",), 2)], "total": 12, "keys": [[1], [2]]},
    ),
    (
        "two overlapping bookings of one instrument add up",
        facts(
            equipment_bookings=[
                used(1, "2026-03-02", "2026-03-13"),
                used(2, "2026-03-02", "2026-03-13"),
            ],
            availability=[available()],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 90.91)], "total": 90.91, "unit": "percent"},  # 20 / 22
    ),
    (
        "a double booking reads over 100 %",
        facts(
            equipment_bookings=[
                used(1, "2026-03-02", "2026-03-13"),
                used(2, "2026-03-02", "2026-03-17"),
            ],
            availability=[available(blocks=(("2026-03-30", "2026-03-31"),))],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 110.0)], "total": 110.0},  # 22 / 20
    ),
    (
        "a booking by a project outside the visible sites is not in the numerator",
        facts(
            # Project 9 is not in scope (the loader cuts bookings to the
            # projects of the visible sites): only booking 1 counts.
            equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-13", project_id=9)],
            availability=[available()],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 22.73)], "total": 22.73},  # 5 / 22
    ),
    (
        "a block of two weekdays leaves 20 available days",
        facts(
            equipment_bookings=[FIRST_WEEK],
            availability=[available(blocks=(("2026-03-14", "2026-03-17"),))],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 25.0)]},  # 5 / 20
    ),
    (
        "bookings by equipment type: no type and a blank type read No type",
        facts(
            equipment_bookings=[
                FIRST_WEEK,
                used(2, "2026-03-02", "2026-03-06", equipment=2),
                used(3, "2026-03-02", "2026-03-06", equipment=3),
                used(4, "2026-03-02", "2026-03-06", equipment=4),
            ]
        ),
        q("equipment_booking_count", BY_TYPE),
        {
            "rows": [(("HPLC",), 1), (("MS",), 1), (("No type",), 2)],
            "total": 4,
            "unit": "count",
            "keys": [["HPLC"], ["MS"], [None]],
        },
    ),
    (
        "utilisation by site: a two-site equipment in both rows, once in the total",
        facts(
            holidays=TWO_SITE_HOLIDAY,
            equipment_bookings=[used(1, "2026-03-02", "2026-03-13", equipment=2)],
            availability=[available(2, holidays=TWO_SITE_HOLIDAY)],
        ),
        q("equipment_utilisation", SITE),
        {
            "rows": [(("Site 1",), 47.62), (("Site 2",), 47.62)],  # 10 / 21
            "total": 47.62,
            "note": "Equipment at several sites counts in each",
        },
    ),
    (
        "equipment booked counts each instrument once",
        facts(
            projects=[project(1), project(2)],
            equipment_bookings=[
                FIRST_WEEK,
                used(2, "2026-03-09", "2026-03-13", project_id=2),
                used(3, "2026-03-09", "2026-03-13", equipment=2),
            ],
        ),
        q("equipment_booked", [{"kind": "project"}]),
        {"rows": [(("Project 1",), 2), (("Project 2",), 1)], "total": 2, "unit": "equipment"},
    ),
    (
        "a booking of a project with two tags counts in both tag rows",
        facts(projects=[project(1, tag_ids=(20, 21))], equipment_bookings=[FIRST_WEEK]),
        q("equipment_booking_count", [{"kind": "tag"}]),
        {
            "rows": [(("Blue",), 1), (("Red",), 1)],
            "total": 1,
            "note": "An equipment booking of a project with several tags counts in each",
        },
    ),
    (
        "the Equipment filter on a booking measure",
        facts(equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", equipment=2)]),
        q("equipment_booked_days", filters={"equipment_ids": [2]}),
        {"rows": [((), 2)]},
    ),
    (
        "the project filters apply to equipment booking measures",
        facts(
            projects=[project(1), project(2, confirmed=True)],
            equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", project_id=2)],
        ),
        q("equipment_booking_count", filters={"project_ids": [2], "confirmed": True}),
        {"rows": [((), 1)]},
    ),
    (
        "the Equipment types filter on a booking measure",
        facts(equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", equipment=2)]),
        q("equipment_booked_days", filters={"equipment_types": ["HPLC"]}),
        {"rows": [((), 5)]},
    ),
    (
        "the Equipment filter on utilisation applies to both sides",
        facts(
            equipment_bookings=[FIRST_WEEK, used(2, "2026-03-02", "2026-03-13", equipment=2)],
            availability=[available(1), available(2)],
        ),
        q("equipment_utilisation", filters={"equipment_ids": [1]}),
        {"rows": [((), 22.73)]},  # 5 / 22
    ),
    (
        "the Equipment types filter on utilisation applies to both sides",
        facts(
            equipment_bookings=[FIRST_WEEK, used(2, "2026-03-02", "2026-03-13", equipment=2)],
            availability=[available(1), available(2)],
        ),
        q("equipment_utilisation", filters={"equipment_types": ["MS"]}),
        {"rows": [((), 45.45)]},  # 10 / 22
    ),
    (
        "a stale equipment id and an unknown type (case-sensitive) warn",
        facts(equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", equipment=2)]),
        q(
            "equipment_booked_days",
            filters={"equipment_ids": [1, 99], "equipment_types": ["HPLC", "hplc"]},
        ),
        {
            "rows": [((), 5)],
            "warnings": ["Equipment 99 no longer exists", "Equipment type hplc no longer exists"],
        },
    ),
    (
        "a booking of inactive equipment counts in booked days",
        facts(equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", equipment=3)]),
        q("equipment_booked_days"),
        {"rows": [((), 7)]},
    ),
    (
        "but not in utilisation: inactive equipment has no availability",
        facts(
            equipment_bookings=[FIRST_WEEK, used(2, "2026-03-09", "2026-03-10", equipment=3)],
            availability=[available(1)],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 22.73)]},  # 5 / 22
    ),
    (
        "utilisation's Sites filter is the equipment's site, not the project's",
        facts(
            projects=TWO_SITES,
            equipment_bookings=[used(1, "2026-03-02", "2026-03-06", project_id=3)],
            availability=[available(1)],
        ),
        q("equipment_utilisation", filters={"site_ids": [1]}),
        {"rows": [((), 22.73)]},
    ),
    (
        "utilisation at the project's site leaves another site's equipment out",
        facts(
            projects=TWO_SITES,
            equipment_bookings=[used(1, "2026-03-02", "2026-03-06", project_id=3)],
            availability=[available(1), available(2)],
        ),
        q("equipment_utilisation", filters={"site_ids": [2]}),
        {"rows": [((), 0.0)]},  # only the unbooked mass spectrometer is at site 2
    ),
    (
        "booked days' Sites filter is the project's site",
        facts(
            projects=TWO_SITES,
            equipment_bookings=[used(1, "2026-03-02", "2026-03-06", project_id=3)],
        ),
        q("equipment_booked_days", filters={"site_ids": [2]}),
        {"rows": [((), 5)]},
    ),
    (
        "booked time on equipment with no available day has no utilisation",
        facts(
            equipment_bookings=[FIRST_WEEK],
            availability=[available(blocks=(("2026-03-01", "2026-03-31"),))],
        ),
        q("equipment_utilisation"),
        {"rows": [((), None)], "total": None},
    ),
    (
        "utilisation by type: unbooked equipment reads 0",
        facts(equipment_bookings=[FIRST_WEEK], availability=[available(1), available(2)]),
        q("equipment_utilisation", BY_TYPE),
        {"rows": [(("HPLC",), 22.73), (("MS",), 0.0)], "total": 11.36},  # 5 / 44
    ),
    (
        "archived projects' bookings stay out of utilisation by default",
        facts(
            projects=[project(1, archived=True)],
            equipment_bookings=[FIRST_WEEK],
            availability=[available(1)],
        ),
        q("equipment_utilisation"),
        {"rows": [((), 0.0)]},
    ),
    (
        "archived projects' bookings count with archived: include",
        facts(
            projects=[project(1, archived=True)],
            equipment_bookings=[FIRST_WEEK],
            availability=[available(1)],
        ),
        q("equipment_utilisation", filters={"archived": "include"}),
        {"rows": [((), 22.73)]},
    ),
    (
        "utilisation per month on both sides",
        facts(
            equipment_bookings=[used(1, "2026-03-30", "2026-04-03")],
            availability=[available(1, period=(d("2026-03-01"), d("2026-04-30")))],
        ),
        q("equipment_utilisation", MONTHS, period=SPRING),
        {
            "rows": [(("Mar 2026",), 9.09), (("Apr 2026",), 13.64)],  # 2 / 22, 3 / 22
            "total": 11.36,
        },
    ),
]
FACT_CASES += EQUIPMENT_CASES


@pytest.mark.parametrize(
    ("name", "case_facts", "query", "expected"),
    FACT_CASES,
    ids=[case[0] for case in FACT_CASES],
)
def test_fact_cases(name, case_facts, query, expected):
    result = aggregate(case_facts, query, viewer=FULL).to_dict()
    rows = [(tuple(k["label"] for k in row["keys"]), row["value"]) for row in result["rows"]]
    assert rows == expected["rows"], name
    if "keys" in expected:
        assert [[k["key"] for k in row["keys"]] for row in result["rows"]] == expected["keys"]
    if "colors" in expected:
        assert [[k.get("color") for k in row["keys"]] for row in result["rows"]] == expected[
            "colors"
        ]
    for field in ("total", "unit", "truncated"):
        if field in expected:
            assert result[field] == expected[field], field
    assert result["warnings"] == expected.get("warnings", [])
    assert result.get("note") == expected.get("note")
    if "period" in expected:
        assert (result["period"]["from"], result["period"]["to"]) == expected["period"]


def test_result_shape():
    result = aggregate(
        facts(projects=TWO_SITES, bookings=TWO_SITE_BOOKINGS),
        q("booked_days", [{"kind": "site"}, CONFIRMED]),
        viewer=FULL,
    ).to_dict()
    assert result["dimensions"] == [
        {"kind": "site", "label": "Site"},
        {"kind": "confirmed", "label": "Confirmed"},
    ]
    assert result["rows"][0] == {
        "keys": [{"key": 1, "label": "Site 1"}, {"key": True, "label": "Confirmed"}],
        "value": 5,
    }
    assert result["period"] == {"from": "2026-03-01", "to": "2026-03-31"}
    assert "note" not in result


def test_counts_are_ints_and_amounts_round_to_two_decimals():
    result = aggregate(
        facts(bookings=[booking(1, "2026-03-02", "2026-03-04", allocation=33)]),
        q("booked_weeks"),
        viewer=FULL,
    )
    assert result.total == 0.2  # 0.33 x 3 / 5 = 0.198
    count = aggregate(facts(), q("project_count"), viewer=FULL)
    assert count.total == 1 and isinstance(count.total, int)


def test_dimension_labels_name_the_field_and_the_grain():
    result = aggregate(
        facts(),
        q(
            "project_count",
            [{"kind": "field", "field_id": 30}, {"kind": "period", "grain": "month"}],
        ),
        viewer=FULL,
    )
    assert result.dimensions == [
        {"kind": "field", "label": "Type"},
        {"kind": "period", "label": "Month"},
    ]


@pytest.mark.parametrize(
    ("viewer", "query", "message"),
    [
        (
            Viewer(frozenset({"views.equipment", "views.archived"})),
            {"measure": "booked_days", "dimensions": [{"kind": "person"}]},
            "This widget needs the Staff & Calendar view permission",
        ),
        (
            Viewer(frozenset({"views.staff", "views.equipment"})),
            {"measure": "project_count", "filters": {"archived": "only"}},
            "This widget needs the Archived view permission",
        ),
    ],
)
def test_missing_permission_is_an_error(viewer, query, message):
    with pytest.raises(MetricError) as caught:
        aggregate(facts(), MetricQuery.model_validate(query), viewer=viewer)
    assert caught.value.message == message


def test_people_booked_without_a_person_dimension_needs_no_staff_view():
    viewer = Viewer(frozenset())
    result = aggregate(
        facts(bookings=[booking(1, "2026-03-02", "2026-03-06")]), q("people_booked"), viewer=viewer
    )
    assert result.total == 1


def test_deleted_field_dimension_is_an_error():
    with pytest.raises(MetricError, match="no longer exists"):
        aggregate(facts(), q("project_count", [{"kind": "field", "field_id": 77}]), viewer=FULL)


def test_text_field_cannot_be_a_dimension():
    with pytest.raises(MetricError, match='"Notes" cannot be used as a dimension'):
        aggregate(facts(), q("project_count", [{"kind": "field", "field_id": 33}]), viewer=FULL)


# --- Calendar ----------------------------------------------------------------


def brute_force(a: date, b: date, holidays: set[date]) -> int:
    count = 0
    day = a
    while day <= b:
        if day.weekday() < 5 and day not in holidays:
            count += 1
        day += timedelta(days=1)
    return count


def test_working_days_matches_a_day_loop_on_random_ranges():
    rng = random.Random(20261023)
    origin = date(2024, 1, 1)
    for _ in range(200):
        a = origin + timedelta(days=rng.randrange(0, 900))
        b = a + timedelta(days=rng.randrange(-3, 400))
        holidays = {origin + timedelta(days=rng.randrange(0, 1300)) for _ in range(30)}
        weekday_holidays = sorted(h for h in holidays if h.weekday() < 5)
        assert working_days(a, b, weekday_holidays) == brute_force(a, b, holidays), (a, b)


def test_working_calendar_per_site():
    calendar = WorkingCalendar({1: [d("2026-03-04")]})
    assert calendar.days(1, d("2026-03-02"), d("2026-03-06")) == 4
    assert calendar.days(2, d("2026-03-02"), d("2026-03-06")) == 5
    assert calendar.days(None, d("2026-03-02"), d("2026-03-06")) == 5
    assert calendar.days(1, d("2026-03-06"), d("2026-03-02")) == 0


def test_expand_holidays_keeps_weekdays_inside_the_period_once():
    rows = [
        (1, d("2026-03-05"), d("2026-03-10")),
        (1, d("2026-03-09"), None),  # duplicate day
        (1, d("2026-02-27"), d("2026-03-02")),  # partly before the period
        (2, d("2026-03-07"), None),  # a Saturday
    ]
    assert expand_holidays(rows, (d("2026-03-01"), d("2026-03-31"))) == {
        1: [d("2026-03-02"), d("2026-03-05"), d("2026-03-06"), d("2026-03-09"), d("2026-03-10")]
    }


def test_clip_to_card():
    card = (d("2026-03-02"), d("2026-03-13"))
    assert clip_to_card(None, None, *card) == card
    assert clip_to_card(d("2026-03-09"), d("2026-03-10"), *card) == (
        d("2026-03-09"),
        d("2026-03-10"),
    )
    assert clip_to_card(d("2026-02-20"), d("2026-03-03"), *card) == (
        d("2026-03-02"),
        d("2026-03-03"),
    )
    assert clip_to_card(d("2026-03-12"), d("2026-03-20"), *card) == (
        d("2026-03-12"),
        d("2026-03-13"),
    )
    assert clip_to_card(d("2026-04-01"), d("2026-04-03"), *card) is None


# --- Periods and buckets -----------------------------------------------------

PERIOD_CASES = [
    # (today, relative, from, to)
    ("2026-01-15", "this_year", "2026-01-01", "2026-12-31"),
    ("2026-01-15", "last_year", "2025-01-01", "2025-12-31"),
    ("2026-01-15", "this_quarter", "2026-01-01", "2026-03-31"),
    ("2026-01-15", "last_quarter", "2025-10-01", "2025-12-31"),
    ("2026-01-15", "last_12_months", "2025-02-01", "2026-01-31"),
    ("2026-05-31", "this_year", "2026-01-01", "2026-12-31"),
    ("2026-05-31", "last_year", "2025-01-01", "2025-12-31"),
    ("2026-05-31", "this_quarter", "2026-04-01", "2026-06-30"),
    ("2026-05-31", "last_quarter", "2026-01-01", "2026-03-31"),
    ("2026-05-31", "last_12_months", "2025-06-01", "2026-05-31"),
    ("2024-12-31", "this_year", "2024-01-01", "2024-12-31"),
    ("2024-12-31", "last_year", "2023-01-01", "2023-12-31"),
    ("2024-12-31", "this_quarter", "2024-10-01", "2024-12-31"),
    ("2024-12-31", "last_quarter", "2024-07-01", "2024-09-30"),
    ("2024-12-31", "last_12_months", "2024-01-01", "2024-12-31"),
    # Forward periods and the month periods, at year / quarter / month edges.
    ("2026-12-15", "next_quarter", "2027-01-01", "2027-03-31"),
    ("2026-12-15", "next_year", "2027-01-01", "2027-12-31"),
    ("2026-12-15", "next_month", "2027-01-01", "2027-01-31"),
    ("2026-12-15", "this_month", "2026-12-01", "2026-12-31"),
    ("2026-12-15", "next_12_months", "2026-12-01", "2027-11-30"),
    ("2026-01-10", "last_month", "2025-12-01", "2025-12-31"),
    ("2026-01-10", "last_quarter", "2025-10-01", "2025-12-31"),
    ("2026-01-10", "next_quarter", "2026-04-01", "2026-06-30"),
    ("2026-01-10", "this_month", "2026-01-01", "2026-01-31"),
    ("2026-01-10", "next_12_months", "2026-01-01", "2026-12-31"),
    ("2026-10-23", "next_12_months", "2026-10-01", "2027-09-30"),
    ("2026-10-23", "last_12_months", "2025-11-01", "2026-10-31"),
    ("2026-10-23", "next_month", "2026-11-01", "2026-11-30"),
    ("2026-10-23", "last_month", "2026-09-01", "2026-09-30"),
    ("2024-02-10", "this_month", "2024-02-01", "2024-02-29"),
    ("2024-01-31", "next_month", "2024-02-01", "2024-02-29"),
    ("2024-03-31", "last_month", "2024-02-01", "2024-02-29"),
    ("2024-12-31", "next_year", "2025-01-01", "2025-12-31"),
]


@pytest.mark.parametrize(("today", "relative", "first", "last"), PERIOD_CASES)
def test_resolve_relative_period(today, relative, first, last):
    spec = MetricQuery.model_validate(
        {"measure": "booked_days", "filters": {"period": {"relative": relative}}}
    ).filters.period
    assert resolve_period(spec, d(today)) == (d(first), d(last), False)


@pytest.mark.parametrize("today", ["2026-01-15", "2026-05-31", "2024-12-31"])
def test_resolve_all(today):
    spec = MetricQuery.model_validate(
        {"measure": "booked_days", "filters": {"period": {"relative": "all"}}}
    ).filters.period
    now = d(today)
    five_years = timedelta(days=1825)
    year_ahead = now + timedelta(days=365)
    # No project: today.
    assert resolve_period(spec, now) == (now, now, False)
    # A short extent is kept as it is.
    assert resolve_period(spec, now, (d("2023-01-01"), d("2027-06-30"))) == (
        d("2023-01-01"),
        d("2027-06-30"),
        False,
    )
    # Long and past-heavy: the five years ending a year from now...
    high = min(d("2027-06-30"), year_ahead)
    assert resolve_period(spec, now, (d("2010-01-01"), d("2027-06-30"))) == (
        high - five_years,
        high,
        True,
    )
    # ... or at the extent's end when that comes sooner.
    soon = now + timedelta(days=30)
    assert resolve_period(spec, now, (d("2010-01-01"), soon)) == (soon - five_years, soon, True)
    # Long and future-heavy: the end is cut a year from now, the start five years before.
    assert resolve_period(spec, now, (d("2020-01-01"), d("2040-12-31"))) == (
        year_ahead - five_years,
        year_ahead,
        True,
    )
    # Every project more than a year ahead: the first five years of the extent.
    start = now + timedelta(days=400)
    assert resolve_period(spec, now, (start, start + timedelta(days=3000))) == (
        start,
        start + five_years,
        True,
    )


def test_resolve_absolute_period():
    spec = q("booked_days", period={"from": "2026-02-01", "to": "2026-02-28"}).filters.period
    assert resolve_period(spec, TODAY) == (d("2026-02-01"), d("2026-02-28"), False)


def test_buckets():
    assert [b.key for b in buckets("month", d("2026-11-15"), d("2027-01-10"))] == [
        "2026-11",
        "2026-12",
        "2027-01",
    ]
    first, *_, last = buckets("week", d("2026-12-30"), d("2027-01-12"))
    assert (first.key, first.label, first.start) == ("2026-W53", "W53 2026", d("2026-12-30"))
    assert (last.key, last.end) == ("2027-W02", d("2027-01-12"))
    quarters = buckets("quarter", d("2026-02-10"), d("2026-08-01"))
    assert [(b.key, b.start, b.end) for b in quarters] == [
        ("2026-Q1", d("2026-02-10"), d("2026-03-31")),
        ("2026-Q2", d("2026-04-01"), d("2026-06-30")),
        ("2026-Q3", d("2026-07-01"), d("2026-08-01")),
    ]
    assert buckets("year", d("2026-03-01"), d("2026-02-01")) == []


def test_unknown_grain_and_period_are_errors():
    with pytest.raises(MetricError):
        buckets("decade", d("2026-01-01"), d("2026-01-02"))

    class Spec:
        relative = "next_century"

    with pytest.raises(MetricError):
        resolve_period(Spec(), TODAY)


# --- The seed ----------------------------------------------------------------


def _seed_rows() -> list[dict]:
    """Every seeded widget: both base dashboards with the demo's field widgets,
    plus the demo-only gauge."""
    rows = [
        w for _, widgets in base_dashboard_rows({"Project type": 1, "Area": 2}) for w in widgets
    ]
    return [*rows, capacity_dashboard_rows(with_gauge=True)[1][0]]


def test_every_seed_widget_parses_and_passes_the_matrix():
    rows = _seed_rows()
    assert len(rows) == (
        sum(len(d["widgets"]) for d in BASE_DASHBOARDS) + len(DEMO_EXTRA_WIDGETS) + 1
    )
    for row in rows:
        widget = WidgetIn.model_validate(
            {
                "kind": row["kind"],
                "title": row["title"],
                "query": json.loads(row["query"]),
                "options": json.loads(row["options"]),
                "layout": json.loads(row["layout"]),
                "sort_order": row["sort_order"],
            }
        )
        for dimension in widget.query.dimensions:
            assert metrics.matrix_error(widget.query.measure, dimension.kind) is None


def test_every_seed_widget_aggregates():
    seed_facts = facts(
        projects=[project(1, field_values={1: 300}, team_ids=(10,), confirmed=True)],
        bookings=[booking(1, "2026-03-02", "2026-03-06", team_ids=(10,))],
    )
    seed_facts.fields[1] = FieldInfo(1, "Project type", "select")
    seed_facts.fields[2] = FieldInfo(2, "Area", "multiselect")
    seed_facts.options[300] = OptionInfo(300, 1, "Internal", "#aaaaaa")
    for row in _seed_rows():
        query = MetricQuery.model_validate(json.loads(row["query"]))
        result = aggregate(seed_facts, query, viewer=FULL)
        assert result.warnings == []


def test_calendar_edges():
    assert metrics.weekday_count(d("2026-03-06"), d("2026-03-02")) == 0
    assert metrics.weekday_count(d("2026-03-07"), d("2026-03-08")) == 0
    # A subphase whose parent chain is broken or loops has no top phase.
    assert metrics._top_phase(5, {}) is None
    assert metrics._top_phase(5, {5: (6, "subphase"), 6: (5, "subphase")}) is None
    assert metrics._top_phase(5, {5: (6, "subphase"), 6: (9, "phase")}) == 9


def test_field_filter_ignores_values_that_are_not_items():
    query = q("project_count", filters={"field_options": {"30": [300]}})
    odd = facts(
        projects=[project(1, field_values={30: "text"}), project(2, field_values={30: True})]
    )
    assert aggregate(odd, query, viewer=FULL).total == 0


# --- The query spec ------------------------------------------------------------

LAYOUT = {
    "lg": {"x": 0, "y": 0, "w": 6, "h": 4},
    "md": {"x": 0, "y": 0, "w": 8, "h": 4},
    "sm": {"x": 0, "y": 0, "w": 4, "h": 4},
}

SPEC_REFUSALS = [
    (
        {"dimensions": [{"kind": "site"}, {"kind": "tag"}, {"kind": "project"}]},
        "A widget can be broken down by two dimensions at most",
    ),
    ({"dimensions": [{"kind": "site"}, {"kind": "site"}]}, "The two dimensions must be different"),
    (
        {"dimensions": [{"kind": "site"}], "percent_of": "first_dimension"},
        "A percentage of the first dimension needs two dimensions",
    ),
    ({"percent_of": "total"}, "A percentage needs a dimension"),
    ({"top_n": 3}, "Top N needs a dimension"),
    (
        {"dimensions": [{"kind": "period", "grain": "month"}], "top_n": 3},
        "Top N cannot be used when the first dimension is the period",
    ),
    (
        {"filters": {"period": {"from": "2026-03-02", "to": "2026-03-01"}}},
        "A period cannot end before it starts",
    ),
    (
        {"filters": {"period": {"from": "2021-01-01", "to": "2026-01-01"}}},
        "A period can cover at most five years",
    ),
    ({"measure": "project_count", "dimensions": [{"kind": "team"}]}, None),
    (
        {"dimensions": [{"kind": "field", "field_id": 30}, {"kind": "field", "field_id": 30}]},
        "The two dimensions must be different",
    ),
    (
        {"measure": "project_count", "filters": {"team_ids": [10]}},
        "The Teams filter does not apply to projects",
    ),
    (
        {"measure": "phase_weeks", "filters": {"person_ids": [2]}},
        "The People filter does not apply to phase weeks",
    ),
]


@pytest.mark.parametrize(("body", "message"), SPEC_REFUSALS)
def test_spec_refusals(body, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate({"measure": "booked_days", **body})
    if message is not None:
        assert caught.value.errors()[0]["msg"] == message


def test_spec_accepts_two_fields_and_booking_only_filters_where_they_apply():
    two_fields = MetricQuery.model_validate(
        {
            "measure": "project_count",
            "dimensions": [{"kind": "field", "field_id": 30}, {"kind": "field", "field_id": 31}],
        }
    )
    assert [d.field_id for d in two_fields.dimensions] == [30, 31]
    booked = MetricQuery.model_validate(
        {"measure": "booked_weeks", "filters": {"team_ids": [10], "person_ids": [2]}}
    )
    assert booked.filters.team_ids == [10]
    # Empty lists are no filter: a project measure accepts them.
    empty = MetricQuery.model_validate(
        {"measure": "project_count", "filters": {"team_ids": [], "person_ids": []}}
    )
    assert empty.filters.person_ids == []


FAMILY_FILTER_REFUSALS = [
    # One per family: a filter its facts do not carry.
    (
        {"measure": "booked_days", "filters": {"milestones": "only"}},
        "The Milestones filter does not apply to booked days",
    ),
    (
        {"measure": "booking_count", "filters": {"equipment_types": ["HPLC"]}},
        "The Equipment types filter does not apply to bookings",
    ),
    (
        {"measure": "project_count", "filters": {"person_ids": [1]}},
        "The People filter does not apply to projects",
    ),
    (
        {"measure": "project_volume", "filters": {"milestones": "exclude"}},
        "The Milestones filter does not apply to project volume",
    ),
    (
        {"measure": "phase_count", "filters": {"equipment_ids": [4]}},
        "The Equipment filter does not apply to phases",
    ),
    (
        {"measure": "phase_weeks", "filters": {"team_ids": [10]}},
        "The Teams filter does not apply to phase weeks",
    ),
]


@pytest.mark.parametrize(("body", "message"), FAMILY_FILTER_REFUSALS)
def test_filters_that_do_not_apply_to_the_family_are_refused(body, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == message


@pytest.mark.parametrize("measure", metrics.MEASURES)
def test_default_filter_values_are_accepted_everywhere(measure):
    query = MetricQuery.model_validate(
        {
            "measure": measure,
            "filters": {
                "milestones": "include",
                "archived": "exclude",
                "equipment_ids": [],
                "equipment_types": None,
                "person_ids": [],
                "team_ids": None,
                "field_options": {},
                "period": {"relative": "next_12_months"},
            },
        }
    )
    assert query.filters.milestones == "include"
    assert all(metrics.filter_error(measure, key) is None for key in ("archived", "period"))


def test_phase_measures_take_the_milestones_filter():
    query = MetricQuery.model_validate(
        {"measure": "phase_count", "filters": {"milestones": "only"}}
    )
    assert query.filters.milestones == "only"
    assert not metrics.filter_given(
        MetricQuery.model_validate({"measure": "phase_count"}).filters, "milestones"
    )


def test_equipment_filter_bounds():
    from pydantic import ValidationError

    for types in ([""], ["x" * 101], ["t"] * 101):
        with pytest.raises(ValidationError):
            MetricQuery.model_validate(
                {"measure": "booked_days", "filters": {"equipment_types": types}}
            )
    with pytest.raises(ValidationError):
        MetricQuery.model_validate({"measure": "phase_count", "filters": {"milestones": "some"}})


def test_percent_of_a_percentage_measure_is_refused(monkeypatch):
    from pydantic import ValidationError

    # The refusal machinery on borrowed measures (the real ones: below).
    monkeypatch.setattr(metrics, "NO_PERCENT_MEASURES", frozenset({"phase_weeks", "booked_days"}))
    monkeypatch.setitem(metrics.NO_PERCENT_MESSAGES, "booked_days", "Booked days cannot be one")
    body = {"measure": "phase_weeks", "dimensions": [{"kind": "site"}], "percent_of": "total"}
    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == "Phase weeks is already a percentage"
    assert metrics.percent_error("booked_days") == "Booked days cannot be one"
    assert metrics.percent_error("project_count") is None
    # Without percent_of the measure is accepted.
    MetricQuery.model_validate({**body, "percent_of": None})


@pytest.mark.parametrize(
    ("query", "keys", "needed"),
    [
        # A dimension.
        ({"measure": "booked_days", "dimensions": [{"kind": "person"}]}, set(), "views.staff"),
        # A given filter.
        ({"measure": "booked_days", "filters": {"person_ids": [1]}}, set(), "views.staff"),
        ({"measure": "booked_days", "filters": {"person_ids": []}}, set(), None),
        # The archived mode, checked last.
        ({"measure": "project_count", "filters": {"archived": "include"}}, set(), "views.archived"),
        (
            {
                "measure": "booked_days",
                "dimensions": [{"kind": "person"}],
                "filters": {"archived": "only"},
            },
            {"views.staff"},
            "views.archived",
        ),
        ({"measure": "project_count", "filters": {"archived": "only"}}, {"views.archived"}, None),
    ],
)
def test_missing_permission_in_order(query, keys, needed):
    viewer = Viewer(frozenset(keys))
    assert metrics.missing_permission(MetricQuery.model_validate(query), viewer) == needed


def test_missing_permission_for_a_measure_family_and_an_equipment_filter(monkeypatch):
    # The machinery on a borrowed family (the capacity family's own need: below).
    monkeypatch.setitem(metrics.MEASURE_NEEDS, "booking", "views.equipment")
    query = MetricQuery.model_validate(
        {"measure": "booked_days", "dimensions": [{"kind": "person"}]}
    )
    assert metrics.missing_permission(query, Viewer(frozenset())) == "views.equipment"
    assert (
        metrics.missing_permission(query, Viewer(frozenset({"views.equipment"}))) == "views.staff"
    )
    with pytest.raises(MetricError) as caught:
        aggregate(facts(), query, viewer=Viewer(frozenset({"views.staff"})))
    assert caught.value.message == "This widget needs the Equipment view permission"
    # A filter need on a borrowed filter (the equipment filters' own: below).
    monkeypatch.setitem(metrics.FILTER_NEEDS, "site_ids", "views.equipment")
    monkeypatch.delitem(metrics.MEASURE_NEEDS, "booking")
    sited = MetricQuery.model_validate({"measure": "project_count", "filters": {"site_ids": [1]}})
    assert metrics.missing_permission(sited, Viewer(frozenset())) == "views.equipment"


@pytest.mark.parametrize(
    ("query", "needed"),
    [
        # Per person, a capacity shows the person's absence days.
        ({"measure": "utilisation", "dimensions": [{"kind": "person"}]}, "absences.view_others"),
        (
            {
                "measure": "capacity_days",
                "dimensions": [{"kind": "period", "grain": "week"}, {"kind": "person"}],
            },
            "absences.view_others",
        ),
        ({"measure": "available_days", "filters": {"person_ids": [1]}}, "absences.view_others"),
        ({"measure": "people_over_capacity", "filters": {"person_ids": []}}, None),
        # The aggregates need the Staff view alone.
        ({"measure": "utilisation", "dimensions": [{"kind": "team"}]}, None),
        ({"measure": "capacity_days", "dimensions": [{"kind": "site"}]}, None),
        ({"measure": "utilisation", "dimensions": [{"kind": "period", "grain": "month"}]}, None),
        # Other families: the person dimension and filter need the Staff view only.
        ({"measure": "booked_days", "dimensions": [{"kind": "person"}]}, None),
        ({"measure": "booked_days", "filters": {"person_ids": [1]}}, None),
    ],
)
def test_capacity_per_person_needs_the_absences_permission(query, needed):
    viewer = Viewer(frozenset({"views.staff"}))
    parsed = MetricQuery.model_validate(query)
    assert metrics.missing_permission(parsed, viewer) == needed
    full = Viewer(frozenset({"views.staff", "absences.view_others"}))
    assert metrics.missing_permission(parsed, full) is None


def test_the_absences_refusal_names_the_permission():
    query = MetricQuery.model_validate(
        {"measure": "utilisation", "dimensions": [{"kind": "person"}]}
    )
    with pytest.raises(MetricError) as caught:
        aggregate(
            facts(capacity=[person_capacity()]), query, viewer=Viewer(frozenset({"views.staff"}))
        )
    assert caught.value.message == "This widget needs the Absences permission"
    # Without the Staff view, the family's own need is asked first.
    assert (
        metrics.missing_permission(query, Viewer(frozenset({"absences.view_others"})))
        == "views.staff"
    )
    assert (
        metrics.permission_message("views.staff")
        == "This widget needs the Staff & Calendar view permission"
    )


def test_viewer_has_its_keys():
    viewer = Viewer(frozenset({"views.staff"}))
    assert viewer.has("views.staff") and not viewer.has("views.equipment")


# --- Composite plumbing (round 3, Task 1) ----------------------------------------
# The machinery on a monkeypatched composite over two families (booked days /
# project weeks), which no public measure combines; the capacity composites
# are pinned by CAPACITY_CASES.


@pytest.fixture
def ratio_test(monkeypatch):
    """A composite ``ratio_test`` = booked days / project weeks x 100."""
    seen: list[dict[Any, tuple[float, float]]] = []

    def rule(num: float, den: float, subjects: dict[Any, tuple[float, float]]) -> float | None:
        seen.append(subjects)
        return metrics.ratio_percent(num, den)

    monkeypatch.setitem(metrics.COMPOSITES, "ratio_test", ("booked_days", "project_weeks"))
    monkeypatch.setitem(metrics.COMPOSITE_RULES, "ratio_test", rule)
    monkeypatch.setitem(metrics.FAMILY, "ratio_test", "booking")
    monkeypatch.setitem(metrics.UNITS, "ratio_test", "percent")
    monkeypatch.setitem(metrics.MEASURE_LABELS, "ratio_test", "Ratio test")
    monkeypatch.setattr(metrics, "FLOAT_MEASURES", frozenset({"ratio_test"}))
    return seen


def ratio_query(dimensions: list[dict[str, Any]], period: dict[str, str] = MARCH, **extra: Any):
    return q("booked_days", dimensions, period, **extra).model_copy(
        update={"measure": "ratio_test"}
    )


RATIO_PROJECTS = [
    project(1, end=d("2026-03-31")),
    project(2, end=d("2026-03-31")),
    project(3, end=d("2026-03-31")),
    # Ends in February: no project weeks in March, yet booked in March.
    project(4, start=d("2026-02-01"), end=d("2026-02-28")),
]
RATIO_BOOKINGS = [
    booking(1, "2026-03-02", "2026-03-06", project_id=1),
    booking(2, "2026-03-02", "2026-03-06", project_id=2, allocation=50, person=2),
    booking(3, "2026-03-02", "2026-03-06", project_id=4),
]


def test_composite_runs_both_sides_and_keeps_none_for_a_ratio_over_nothing(ratio_test):
    result = aggregate(
        facts(projects=RATIO_PROJECTS, bookings=RATIO_BOOKINGS),
        ratio_query([{"kind": "project"}]),
        viewer=FULL,
    ).to_dict()
    # March: 22 working days -> 4.4 project weeks per project.
    assert [(r["keys"][0]["label"], r["value"]) for r in result["rows"]] == [
        ("Project 1", 113.64),  # 5 / 4.4
        ("Project 2", 56.82),  # 2.5 / 4.4
        ("Project 3", 0.0),  # nothing booked
        ("Project 4", None),  # booked, no weeks
    ]
    assert result["total"] == 94.7  # 12.5 / 13.2
    assert result["unit"] == "percent"
    # The total's fold (the first call) gets the subjects: the person on the
    # booking side, None on the project side.
    total_subjects = ratio_test[0]
    assert set(total_subjects) == {1, 2, None}
    assert total_subjects[1] == (10.0, 0.0) and total_subjects[2] == (2.5, 0.0)
    assert total_subjects[None] == (0.0, pytest.approx(13.2))


def test_composite_total_is_none_when_only_the_numerator_has_facts(ratio_test):
    result = aggregate(
        facts(projects=[RATIO_PROJECTS[3]], bookings=[RATIO_BOOKINGS[2]]),
        ratio_query([]),
        viewer=FULL,
    ).to_dict()
    assert result["rows"] == [{"keys": [], "value": None}]
    assert result["total"] is None


def test_composite_top_n_ranks_by_the_ratio_with_none_last(ratio_test):
    result = aggregate(
        facts(projects=RATIO_PROJECTS, bookings=RATIO_BOOKINGS),
        ratio_query([{"kind": "project"}], top_n=2),
        viewer=FULL,
    ).to_dict()
    # Project 3 (0 %) and Project 4 (None) fold into Other: 5 / 4.4.
    assert [(r["keys"][0]["label"], r["value"]) for r in result["rows"]] == [
        ("Project 1", 113.64),
        ("Project 2", 56.82),
        ("Other", 113.64),
    ]
    assert metrics._rank(None) > metrics._rank(0.0) > metrics._rank(5.0)


def test_composite_empty_period_buckets_stay_zero(ratio_test):
    result = aggregate(
        facts(projects=RATIO_PROJECTS[:1], bookings=RATIO_BOOKINGS[:1]),
        ratio_query(
            [{"kind": "period", "grain": "month"}], {"from": "2026-03-01", "to": "2026-04-30"}
        ),
        viewer=FULL,
    ).to_dict()
    assert [(r["keys"][0]["label"], r["value"]) for r in result["rows"]] == [
        ("Mar 2026", 113.64),
        ("Apr 2026", 0.0),
    ]


def test_out_of_scope_phases_and_weekend_amounts_add_nothing():
    stray = facts(
        phases=[PhaseFact(1, 9, "Orphan", d("2026-03-02"), d("2026-03-06"))],
        bookings=[booking(1, "2026-03-07", "2026-03-08")],  # a weekend
    )
    assert aggregate(stray, q("phases_due"), viewer=FULL).total == 0
    assert aggregate(stray, q("booked_days"), viewer=FULL).total == 0
    assert metrics.filter_given(q("booked_days").filters, "period")


def test_ratio_percent_rule():
    assert metrics.ratio_percent(5, 0) is None
    assert metrics.ratio_percent(0, 0) == 0.0
    assert metrics.ratio_percent(1, 4) == 25.0


def test_unknown_measures_and_families_are_errors(monkeypatch):
    item = metrics._Item("project", 1, project(), d("2026-03-02"), d("2026-03-06"))
    calendar = WorkingCalendar({})
    with pytest.raises(MetricError, match="Unknown measure"):
        metrics._amount("nothing", item, calendar, d("2026-03-02"), d("2026-03-06"))
    with pytest.raises(MetricError, match="Unknown measure"):
        metrics._combine("nothing", [])
    monkeypatch.setitem(metrics.COMPOSITES, "no_rule", ("booked_days", "project_weeks"))
    with pytest.raises(MetricError, match="Unknown measure"):
        metrics._combine("no_rule", [])
    monkeypatch.setitem(metrics.FAMILY, "orphan", "nowhere")
    with pytest.raises(MetricError, match="Unknown measure family"):
        list(metrics._items(facts(), "orphan", metrics._Filters(archived="exclude"), "nowhere"))
    assert metrics._subject("project_count", item) is None


def test_notes_name_the_family():
    team = metrics._Dimension("team", "Team")
    site = metrics._Dimension("site", "Site")
    tag = metrics._Dimension("tag", "Tag")
    assert metrics._note(team, "booking") == "A booking in several teams counts in each"
    assert metrics._note(tag, "project") == "A project with several tags counts in each"
    assert metrics._note(tag, "phase") == "A phase of a project with several tags counts in each"
    assert metrics._note(team, "capacity") == "A person in several teams counts in each"
    assert metrics._note(site, "capacity") == "A person at several sites counts in each"
    assert metrics._note(site, "equipment") == "Equipment at several sites counts in each"
    assert (
        metrics._note(site, "booking")
        == 'A booking of a project with several "Site" items counts in each'
    )


def test_spec_accepts_the_longest_period_and_defaults():
    query = MetricQuery.model_validate(
        {
            "measure": "booked_days",
            "filters": {"period": {"from": "2021-01-02", "to": "2026-01-01"}},
        }
    )
    assert (query.filters.period.to - query.filters.period.from_).days + 1 == 1826
    default = MetricQuery.model_validate({"measure": "booked_days"})
    assert default.filters.archived == "exclude"
    assert default.filters.period.relative == "this_year"


@pytest.mark.parametrize(
    ("widget", "message"),
    [
        ({"title": "   "}, "A widget needs a title"),
        (
            {"layout": {**LAYOUT, "lg": {"x": 8, "y": 0, "w": 6, "h": 4}}},
            "The widget does not fit the lg grid of 12 columns",
        ),
        ({"options": {"colour": "red"}}, None),
        ({"kind": "radar"}, None),
        ({"options": {"kpi_bucket": "x" * 201}}, None),
        ({"layout": {**LAYOUT, "lg": {"x": 0, "y": 10001, "w": 6, "h": 4}}}, None),
        ({"layout": {**LAYOUT, "md": {"x": 0, "y": 0, "w": 8, "h": 41}}}, None),
    ],
)
def test_widget_refusals(widget, message):
    from pydantic import ValidationError

    body = {"kind": "bar", "title": "T", "query": {"measure": "booked_days"}, "layout": LAYOUT}
    with pytest.raises(ValidationError) as caught:
        WidgetIn.model_validate({**body, **widget})
    if message is not None:
        assert caught.value.errors()[0]["msg"] == message


def test_widget_bounds_accept_their_limits():
    widget = WidgetIn.model_validate(
        {
            "kind": "kpi",
            "title": "T",
            "query": {"measure": "booked_days"},
            "options": {"kpi_bucket": "x" * 200},
            "layout": {**LAYOUT, "lg": {"x": 0, "y": 10000, "w": 6, "h": 40}},
        }
    )
    assert widget.layout.lg.h == 40
    assert widget.options.kpi_bucket == "x" * 200


def test_dashboard_body_names_the_failing_widget():
    from pydantic import ValidationError

    from app.schemas.dashboard import DashboardIn

    good = {"kind": "kpi", "title": "Ok", "query": {"measure": "booked_days"}, "layout": LAYOUT}
    bad = {**good, "title": "Per week", "query": {"measure": "people_booked", "dimensions": [
        {"kind": "period", "grain": "week"}]}}  # fmt: skip
    with pytest.raises(ValidationError) as caught:
        DashboardIn.model_validate({"name": "D", "widgets": [good, bad]})
    assert caught.value.errors()[0]["msg"] == (
        '"Per week": People booked cannot be broken down by period'
    )
    untitled = {key: value for key, value in bad.items() if key != "title"}
    with pytest.raises(ValidationError) as caught:
        DashboardIn.model_validate({"name": "D", "widgets": [good, untitled]})
    assert caught.value.errors()[0]["msg"].startswith("Widget 2: ")
    with pytest.raises(ValidationError) as caught:
        DashboardIn.model_validate({"name": "  ", "widgets": []})
    assert caught.value.errors()[0]["msg"] == "A dashboard needs a name"
    with pytest.raises(ValidationError) as caught:
        DashboardIn.model_validate({"name": "D", "widgets": "nope"})
    assert caught.value.errors()[0]["msg"].startswith("A widget: ")


def test_all_uses_the_extent_of_the_query_archived_mode():
    both = facts(projects=[project(1), project(2, archived=True, start=d("2024-01-01"))])
    both.extents = {
        "exclude": (d("2026-01-01"), d("2026-12-31")),
        "include": (d("2024-01-01"), d("2026-12-31")),
    }

    def period_of(archived: str) -> dict[str, str]:
        query = MetricQuery.model_validate(
            {
                "measure": "project_count",
                "filters": {"archived": archived, "period": {"relative": "all"}},
            }
        )
        return aggregate(both, query, viewer=FULL).to_dict()["period"]

    assert period_of("exclude") == {"from": "2026-01-01", "to": "2026-12-31"}
    assert period_of("include") == {"from": "2024-01-01", "to": "2026-12-31"}
    # A mode without an extent (no project in scope): today.
    assert period_of("only") == {"from": TODAY.isoformat(), "to": TODAY.isoformat()}


# --- Capacity calendar (round 3, Task 2) -----------------------------------------

TEAM_SITES = {10: 1, 11: 1, 12: 2, 13: None}
# (event sites, event teams, person sites, person teams, applies): the rule of
# ``getClosureOn`` in frontend/src/utils/siteClosure.ts.
CLOSURE_CASES = [
    ((1,), (), (1,), (), True),  # whole site
    ((1,), (), (2,), (), False),  # another site
    ((1,), (), (), (), False),  # a site-less person
    ((1, 2), (), (2, 3), (), True),  # one shared site is enough
    ((1,), (11,), (1,), (11,), True),  # a member of the event's team
    ((1,), (11,), (1,), (10,), False),  # not a member
    ((1, 2), (11,), (2,), (), True),  # its team is not at the shared site
    # The teams at *any* shared site limit it (a member of neither stays in).
    ((1, 2), (11,), (1, 2), (12,), False),
    ((1,), (99,), (1,), (), True),  # an unknown team is ignored
    ((1,), (13,), (1,), (), True),  # a team without a site is ignored
]


@pytest.mark.parametrize(
    ("event_sites", "event_teams", "person_sites", "person_teams", "applies"), CLOSURE_CASES
)
def test_closure_applies(event_sites, event_teams, person_sites, person_teams, applies):
    assert (
        metrics.closure_applies(event_sites, event_teams, person_sites, person_teams, TEAM_SITES)
        is applies
    )


def test_off_days_within_keeps_weekdays_of_the_period_once():
    days = metrics.off_days_within(
        (d("2026-03-02"), d("2026-03-08")),
        [d("2026-03-04"), d("2026-03-01")],  # before the period
        [d("2026-03-04"), d("2026-03-07")],  # a Saturday
        (d(f"2026-03-0{day}") for day in (2, 3)),
    )
    assert days == (d("2026-03-02"), d("2026-03-03"), d("2026-03-04"))
    assert metrics.off_days_within((d("2026-03-02"), d("2026-03-08"))) == ()


def test_capacity_days_are_weekdays_less_off_days_at_the_persons_rate():
    off = (d("2026-03-04"), d("2026-03-11"))
    assert metrics.capacity_days(d("2026-03-01"), d("2026-03-31"), off, 100) == 20
    assert metrics.capacity_days(d("2026-03-01"), d("2026-03-31"), off, 50) == 10
    assert metrics.capacity_days(d("2026-03-05"), d("2026-03-10"), off, 80) == 3.2
    assert metrics.capacity_days(d("2026-03-10"), d("2026-03-05"), off, 100) == 0


CAPACITY_REFUSALS = [
    (
        {"measure": "utilisation", "dimensions": [{"kind": "site"}], "percent_of": "total"},
        "Utilisation is already a percentage",
    ),
    (
        {"measure": "available_days", "dimensions": [{"kind": "site"}], "percent_of": "total"},
        "Available days can be negative and cannot be a percentage",
    ),
    (
        {"measure": "utilisation", "dimensions": [{"kind": "project"}]},
        "Utilisation cannot be broken down by project",
    ),
    (
        {"measure": "capacity_days", "dimensions": [{"kind": "phase_type"}]},
        "Capacity (days) cannot be broken down by phase",
    ),
    (
        {"measure": "people_over_capacity", "filters": {"project_ids": [1]}},
        "The Projects filter does not apply to people over capacity",
    ),
    (
        {"measure": "available_days", "filters": {"tag_ids": [20]}},
        "The Tags filter does not apply to available days",
    ),
]


@pytest.mark.parametrize(("body", "message"), CAPACITY_REFUSALS)
def test_capacity_spec_refusals(body, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == message


def test_capacity_measures_accept_their_filters_and_a_share():
    query = MetricQuery.model_validate(
        {
            "measure": "people_over_capacity",
            "dimensions": [{"kind": "team"}, {"kind": "period", "grain": "month"}],
            "filters": {"site_ids": [1], "team_ids": [10], "person_ids": [1]},
        }
    )
    assert query.filters.team_ids == [10]
    MetricQuery.model_validate(
        {"measure": "capacity_days", "dimensions": [{"kind": "site"}], "percent_of": "total"}
    )


@pytest.mark.parametrize("percent_of", ["total", "first_dimension"])
def test_people_over_capacity_refuses_a_percentage(percent_of):
    from pydantic import ValidationError

    # A bucket counts the people over capacity in the bucket, the total over
    # the whole period: a bucket is not a part of the total.
    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(
            {
                "measure": "people_over_capacity",
                "dimensions": [{"kind": "team"}, {"kind": "period", "grain": "week"}],
                "percent_of": percent_of,
            }
        )
    assert caught.value.errors()[0]["msg"] == "People over capacity cannot be a percentage"
    assert metrics.percent_error("people_over_capacity") == (
        "People over capacity cannot be a percentage"
    )


@pytest.mark.parametrize(
    "measure", ["capacity_days", "available_days", "utilisation", "people_over_capacity"]
)
def test_capacity_measures_need_the_staff_view(measure):
    query = MetricQuery.model_validate({"measure": measure})
    viewer = Viewer(frozenset({"views.equipment", "views.archived"}))
    assert metrics.missing_permission(query, viewer) == "views.staff"
    with pytest.raises(MetricError) as caught:
        aggregate(facts(capacity=[person_capacity()]), query, viewer=viewer)
    assert caught.value.message == "This widget needs the Staff & Calendar view permission"
    assert metrics.measure_families(measure)[0] == "capacity"


def test_utilisation_reads_both_families():
    assert metrics.measure_families("utilisation") == ("capacity", "booking")
    assert metrics.measure_families("capacity_days") == ("capacity",)


def test_capacity_results_round_like_their_kind():
    case = facts(
        bookings=[booking(1, "2026-03-02", "2026-03-04", allocation=30)],
        capacity=[person_capacity(max_capacity=80)],
    )
    utilisation = aggregate(case, q("utilisation"), viewer=FULL)
    assert utilisation.total == 5.11  # 0.9 / 17.6
    assert aggregate(case, q("available_days"), viewer=FULL).total == 16.7
    over = aggregate(case, q("people_over_capacity"), viewer=FULL)
    assert over.total == 0 and isinstance(over.total, int)


def test_people_over_capacity_ignores_float_noise():
    rule = metrics.COMPOSITE_RULES["people_over_capacity"]
    assert rule(0, 0, {1: (10.000000000001, 10.0), 2: (10.1, 10.0), None: (5.0, 0.0)}) == 1


def test_capacity_items_and_subjects():
    fact = person_capacity(2)
    case = facts(capacity=[fact])
    items = list(
        metrics._items(case, "capacity_days", metrics._Filters(archived="exclude"), "capacity")
    )
    assert items == [metrics._Item("capacity", 2, None, date.min, date.max, capacity=fact)]
    assert metrics._subject("capacity_days", items[0]) == 2


# --- The equipment family: spec, needs, items (round 3, Task 3) -----------------

EQUIPMENT_REFUSALS = [
    (
        {"measure": "equipment_utilisation", "filters": {"project_ids": [1]}},
        "The Projects filter does not apply to equipment utilisation",
    ),
    (
        {"measure": "equipment_utilisation", "filters": {"tag_ids": [20]}},
        "The Tags filter does not apply to equipment utilisation",
    ),
    (
        {"measure": "equipment_booked_days", "filters": {"milestones": "only"}},
        "The Milestones filter does not apply to equipment booked days",
    ),
    (
        {"measure": "equipment_booking_count", "filters": {"person_ids": [1]}},
        "The People filter does not apply to equipment bookings",
    ),
    (
        {"measure": "equipment_booked", "dimensions": [{"kind": "period", "grain": "month"}]},
        "Equipment booked cannot be broken down by period",
    ),
    (
        {"measure": "equipment_utilisation", "dimensions": [{"kind": "project"}]},
        "Equipment utilisation cannot be broken down by project",
    ),
    (
        {"measure": "equipment_booked_days", "dimensions": [{"kind": "person"}]},
        "Equipment booked days cannot be broken down by person",
    ),
    (
        {"measure": "booked_days", "dimensions": [{"kind": "equipment"}]},
        "Booked days cannot be broken down by equipment",
    ),
    (
        {
            "measure": "equipment_utilisation",
            "dimensions": [{"kind": "equipment"}],
            "percent_of": "total",
        },
        "Equipment utilisation is already a percentage",
    ),
]


@pytest.mark.parametrize(("body", "message"), EQUIPMENT_REFUSALS)
def test_equipment_spec_refusals(body, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == message


def test_equipment_measures_accept_their_filters_and_a_share():
    booked = MetricQuery.model_validate(
        {
            "measure": "equipment_booked_days",
            "dimensions": [{"kind": "equipment_type"}, {"kind": "project"}],
            "filters": {
                "equipment_ids": [1],
                "equipment_types": ["HPLC"],
                "project_ids": [1],
                "tag_ids": [20],
            },
            "percent_of": "first_dimension",
        }
    )
    assert booked.filters.equipment_types == ["HPLC"]
    utilisation = MetricQuery.model_validate(
        {
            "measure": "equipment_utilisation",
            "dimensions": [{"kind": "site"}, {"kind": "period", "grain": "month"}],
            "filters": {"site_ids": [1], "equipment_ids": [1], "equipment_types": ["MS"]},
        }
    )
    assert utilisation.filters.site_ids == [1]


@pytest.mark.parametrize(
    "measure",
    [
        "equipment_booked_days",
        "equipment_booking_count",
        "equipment_booked",
        "equipment_utilisation",
    ],
)
def test_equipment_measures_need_the_equipment_view(measure):
    query = MetricQuery.model_validate({"measure": measure})
    viewer = Viewer(frozenset({"views.staff", "views.archived"}))
    assert metrics.missing_permission(query, viewer) == "views.equipment"
    with pytest.raises(MetricError) as caught:
        aggregate(facts(), query, viewer=viewer)
    assert caught.value.message == "This widget needs the Equipment view permission"
    assert metrics.measure_families(measure) == ("equipment",)


def test_equipment_dimensions_and_filters_need_the_equipment_view(monkeypatch):
    # Without the family's own need, the dimension and the filters still ask for it.
    monkeypatch.delitem(metrics.MEASURE_NEEDS, "equipment")
    viewer = Viewer(frozenset({"views.staff", "views.archived"}))
    for body in (
        {"measure": "equipment_booking_count", "dimensions": [{"kind": "equipment"}]},
        {"measure": "equipment_booking_count", "dimensions": [{"kind": "equipment_type"}]},
        {"measure": "equipment_booked_days", "filters": {"equipment_ids": [1]}},
        {"measure": "equipment_utilisation", "filters": {"equipment_types": ["HPLC"]}},
    ):
        query = MetricQuery.model_validate(body)
        assert metrics.missing_permission(query, viewer) == "views.equipment", body
    plain = MetricQuery.model_validate({"measure": "equipment_booked_days"})
    assert metrics.missing_permission(plain, viewer) is None


def test_equipment_results_round_like_their_kind():
    case = facts(
        equipment_bookings=[FIRST_WEEK, used(2, "2026-03-02", "2026-03-03")],
        availability=[available(blocks=(("2026-03-30", "2026-03-31"),))],
    )
    utilisation = aggregate(case, q("equipment_utilisation"), viewer=FULL)
    assert utilisation.total == 35.0  # 7 / 20
    count = aggregate(case, q("equipment_booking_count"), viewer=FULL)
    assert count.total == 2 and isinstance(count.total, int)
    booked = aggregate(case, q("equipment_booked"), viewer=FULL)
    assert booked.total == 1 and booked.unit == "equipment"


def test_equipment_off_days_are_holidays_of_its_sites_and_block_weekdays():
    off = metrics.equipment_off_days(
        MARCH_DAYS,
        (1, 2),
        {1: [d("2026-03-05")], 2: [d("2026-03-05"), d("2026-03-06")], 3: [d("2026-03-09")]},
        [(d("2026-02-26"), d("2026-03-03")), (d("2026-03-28"), d("2026-04-03"))],
    )
    # Holidays of sites 1 and 2 once; the blocks' weekdays inside March only.
    assert off == tuple(d(f"2026-03-{day}") for day in ("02", "03", "05", "06", "30", "31"))
    assert metrics.equipment_off_days(MARCH_DAYS, (), {}, []) == ()


def test_equipment_items_and_subjects():
    booking_fact = used(7, "2026-03-02", "2026-03-06", equipment=2)
    availability = available(2)
    case = facts(equipment_bookings=[booking_fact], availability=[availability])
    flt = metrics._Filters(archived="exclude")
    numerator = list(
        metrics._items(case, "equipment_booked_days", flt, "equipment", "equipment_utilisation")
    )
    assert [(i.kind, i.id, i.availability) for i in numerator] == [
        ("equipment_booking", 7, availability)
    ]
    denominator = list(
        metrics._items(case, "equipment_available_days", flt, "equipment", "equipment_utilisation")
    )
    assert denominator == [
        metrics._Item(
            "equipment_availability", 2, None, date.min, date.max, availability=availability
        )
    ]
    # Outside utilisation, a booking carries no availability (``site`` is the project's).
    plain = list(metrics._items(case, "equipment_booked_days", flt, "equipment"))
    assert plain[0].availability is None and plain[0].equipment_booking == booking_fact
    assert metrics._subject("equipment_booked_days", numerator[0]) == 2
    assert metrics._subject("equipment_available_days", denominator[0]) == 2
    assert metrics._ident("equipment_booked", plain[0]) == 2
    assert metrics._ident("equipment_booking_count", plain[0]) == ("equipment_booking", 7)


def test_an_equipment_row_gone_since_the_load_is_named_by_its_id():
    case = facts(equipment_bookings=[used(1, "2026-03-02", "2026-03-06", equipment=42)])
    result = aggregate(case, q("equipment_booking_count", BY_EQUIPMENT + BY_TYPE), viewer=FULL)
    assert [[k["label"] for k in row["keys"]] for row in result.rows] == [
        ["Equipment 42", "No type"]
    ]
    filtered = aggregate(
        case, q("equipment_booking_count", filters={"equipment_types": ["HPLC"]}), viewer=FULL
    )
    assert filtered.total == 0


def test_equipment_utilisation_rule():
    rule = metrics.COMPOSITE_RULES["equipment_utilisation"]
    assert rule(5.0, 0.0, {}) is None
    assert rule(0.0, 0.0, {}) == 0.0
    assert rule(22.0, 20.0, {}) == pytest.approx(110.0)


# ---------------------------------------------------------------------------
# Weekends are working days (2.5.0, ``Facts.weekends_working``)
# ---------------------------------------------------------------------------
# Off (the default) every number above stays Monday to Friday; these cases
# turn the setting on and check each place the rule reaches. One week =
# Monday 2 to Sunday 8 March 2026.

WEEK = {"from": "2026-03-02", "to": "2026-03-08"}


def weekend_facts(on: bool, **kwargs: Any) -> Facts:
    case = facts(**kwargs)
    case.weekends_working = on
    return case


def weekend_capacity(on: bool, absences: tuple[AbsenceSpan, ...] = (), **kwargs: Any):
    off_days = metrics.person_off_days(
        MARCH_DAYS,
        (1,),
        (),
        kwargs.get("holidays", {}),
        absences,
        kwargs.get("closures", ()),
        FACT_TEAM_SITES,
        weekends_working=on,
    )
    return CapacityFact(1, "Ann", (1,), (), 100, off_days)


@pytest.mark.parametrize(("on", "days"), [(False, 0), (True, 2)])
def test_a_weekend_booking_counts_only_when_weekends_are_working_days(on, days):
    case = weekend_facts(on, bookings=[booking(1, "2026-03-07", "2026-03-08")])
    assert aggregate(case, q("booked_days"), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "days"), [(False, 2), (True, 4)])
def test_a_friday_to_monday_booking(on, days):
    case = weekend_facts(on, bookings=[booking(1, "2026-03-06", "2026-03-09")])
    assert aggregate(case, q("booked_days"), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "weeks"), [(False, 1), (True, 1)])
def test_a_whole_week_is_one_week_either_way(on, weeks):
    # 5 days / 5 off, 7 days / 7 on: the divisor follows the setting.
    case = weekend_facts(on, bookings=[booking(1, "2026-03-02", "2026-03-08")])
    assert aggregate(case, q("booked_weeks", period=WEEK), viewer=FULL).total == weeks
    assert aggregate(case, q("project_weeks", period=WEEK), viewer=FULL).total == weeks


def test_the_weeks_divisor_is_seven_when_weekends_are_working_days():
    # Monday to Friday at 100 %: 5 of 7 days of a week.
    case = weekend_facts(True, bookings=[booking(1, "2026-03-02", "2026-03-06")])
    assert aggregate(case, q("booked_weeks"), viewer=FULL).total == pytest.approx(0.71, abs=0.01)
    assert aggregate(case, q("booked_days"), viewer=FULL).total == 5


@pytest.mark.parametrize(("on", "days"), [(False, 5), (True, 7)])
def test_capacity_per_week(on, days):
    case = weekend_facts(on, capacity=[weekend_capacity(on)])
    assert aggregate(case, q("capacity_days", period=WEEK), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "days"), [(False, 22), (True, 27)])
def test_a_saturday_recurring_absence_counts_only_when_weekends_are_working_days(on, days):
    # [R:6] = every Saturday: 7, 14, 21 and 28 March.
    saturdays = (absence("2026-03-01", "2026-03-31", "[R:6] Saturdays"),)
    case = weekend_facts(on, capacity=[weekend_capacity(on, saturdays)])
    assert aggregate(case, q("capacity_days"), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "days"), [(False, 5), (True, 5)])
def test_a_weekend_closure_takes_capacity_only_when_weekends_are_working_days(on, days):
    closures = (closure("2026-03-07", "2026-03-08"),)
    case = weekend_facts(on, capacity=[weekend_capacity(on, closures=closures)])
    assert aggregate(case, q("capacity_days", period=WEEK), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "days"), [(False, 5), (True, 6)])
def test_a_saturday_holiday_is_kept_only_when_weekends_are_working_days(on, days):
    holidays = expand_holidays(
        [(1, d("2026-03-07"), None)], (d("2026-03-01"), d("2026-03-31")), weekends_working=on
    )
    assert holidays == ({1: [d("2026-03-07")]} if on else {})
    case = weekend_facts(on, bookings=[booking(1, "2026-03-02", "2026-03-08")], holidays=holidays)
    assert aggregate(case, q("booked_days"), viewer=FULL).total == days


@pytest.mark.parametrize(("on", "utilisation"), [(False, 0), (True, 6.9)])
def test_equipment_availability_follows_the_setting(on, utilisation):
    # A Sunday-to-Monday block: 1 March is a Sunday, 2 March a Monday.
    off_days = metrics.equipment_off_days(
        MARCH_DAYS, (1,), {}, [(d("2026-03-01"), d("2026-03-02"))], weekends_working=on
    )
    assert off_days == ((d("2026-03-01"), d("2026-03-02")) if on else (d("2026-03-02"),))
    case = weekend_facts(
        on,
        equipment_bookings=[used(1, "2026-03-07", "2026-03-08")],
        availability=[EquipmentAvailabilityFact(1, (1,), off_days)],
    )
    # On: the weekend booking's 2 days over 31 - 2 available days; off: 0 of 21.
    assert aggregate(case, q("equipment_utilisation"), viewer=FULL).total == utilisation


def test_the_calendar_helpers_default_to_weekends_off():
    assert metrics.weekday_count(d("2026-03-02"), d("2026-03-08")) == 5
    assert metrics.weekday_count(d("2026-03-02"), d("2026-03-08"), weekends_working=True) == 7
    assert working_days(d("2026-03-02"), d("2026-03-08"), [d("2026-03-07")]) == 5
    assert (
        working_days(d("2026-03-02"), d("2026-03-08"), [d("2026-03-07")], weekends_working=True)
        == 6
    )
    assert metrics.off_days_within(MARCH_DAYS, [d("2026-03-07")]) == ()
    assert metrics.off_days_within(MARCH_DAYS, [d("2026-03-07")], weekends_working=True) == (
        d("2026-03-07"),
    )
    assert metrics.capacity_days(d("2026-03-02"), d("2026-03-08"), (), 50) == 2.5
    assert (
        metrics.capacity_days(d("2026-03-02"), d("2026-03-08"), (), 50, weekends_working=True)
        == 3.5
    )
    calendar = WorkingCalendar({})
    assert (calendar.weekends_working, calendar.days_per_week) == (False, 5)
    assert WorkingCalendar({}, True).days_per_week == 7
    assert Facts.__dataclass_fields__["weekends_working"].default is False


# --- 2.6.0: Utilisation's booked-side project filters, Has a customer -------

# Ann (100 %, site 1, March = 22 weekdays) is booked 10 days on a customer
# project and 5 days on an internal one at another site.
CUSTOMER_MIX = [
    project(1, customer="Acme", tag_ids=(20,), confirmed=True, field_values={30: 301}),
    project(2, site_id=2, customer="  ", team_ids=(10,), pm_id=2),
]
CUSTOMER_MIX_BOOKINGS = [
    booking(1, "2026-03-02", "2026-03-13", project_id=1),
    booking(2, "2026-03-16", "2026-03-20", project_id=2),
]


def customer_mix() -> Facts:
    return facts(
        projects=CUSTOMER_MIX, bookings=CUSTOMER_MIX_BOOKINGS, capacity=[person_capacity()]
    )


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({}, 68.18),  # 15 / 22
        ({"has_customer": True}, 45.45),  # 10 / 22: the capacity stays Ann's
        ({"has_customer": False}, 22.73),  # a blank customer is none
        ({"project_ids": [2]}, 22.73),
        ({"tag_ids": [20]}, 45.45),
        ({"confirmed": True}, 45.45),
        ({"project_team_ids": [10]}, 22.73),
        ({"project_manager_ids": [2]}, 22.73),
        ({"field_options": {30: [301]}}, 45.45),
        # Sites stay the person's: Ann works at site 1, the internal project is at site 2.
        ({"site_ids": [1]}, 68.18),
        ({"site_ids": [2]}, 0.0),
    ],
)
def test_utilisation_project_filters_narrow_the_booked_side_only(filters, expected):
    result = aggregate(customer_mix(), q("utilisation", filters=filters), viewer=FULL)
    assert result.total == expected
    capacity = aggregate(customer_mix(), q("capacity_days"), viewer=FULL)
    assert capacity.total == 22


def test_utilisation_by_person_with_a_customer_filter_keeps_every_person_in_scope():
    data = facts(
        projects=CUSTOMER_MIX,
        bookings=[*CUSTOMER_MIX_BOOKINGS, booking(3, "2026-03-02", "2026-03-06", person=2)],
        capacity=[person_capacity(), person_capacity(2)],
    )
    result = aggregate(
        data, q("utilisation", PERSON, filters={"has_customer": False}), viewer=FULL
    ).to_dict()
    # Bob's booking is on the customer project: he stays with 0 %.
    assert [(r["keys"][0]["label"], r["value"]) for r in result["rows"]] == [
        ("Ann", 22.73),
        ("Bob", 0.0),
    ]
    assert result["total"] == 11.36  # 5 / 44


@pytest.mark.parametrize(
    ("customer", "has"),
    [("Acme", True), ("", False), ("   ", False), (None, False), (" Lab ", True)],
)
def test_has_customer_follows_the_customer_dimension_blank_rule(customer, has):
    data = facts(
        projects=[project(1, customer=customer)],
        bookings=[booking(1, "2026-03-02", "2026-03-06")],
    )
    for wanted in (True, False):
        result = aggregate(data, q("booked_days", filters={"has_customer": wanted}), viewer=FULL)
        assert result.total == (5 if wanted == has else 0)


@pytest.mark.parametrize(
    "measure", ["booked_days", "project_count", "phase_count", "equipment_booked_days"]
)
def test_has_customer_filters_every_project_backed_family(measure):
    data = facts(
        projects=[project(1, customer="Acme"), project(2)],
        bookings=[
            booking(1, "2026-03-02", "2026-03-06"),
            booking(2, "2026-03-02", "2026-03-06", project_id=2),
        ],
        phases=[
            PhaseFact(1, 1, "Design", d("2026-03-02"), d("2026-03-06")),
            PhaseFact(2, 2, "Design", d("2026-03-02"), d("2026-03-06")),
        ],
        equipment_bookings=[
            used(1, "2026-03-02", "2026-03-06"),
            used(2, "2026-03-02", "2026-03-06", project_id=2),
        ],
    )
    every = aggregate(data, q(measure), viewer=FULL).total
    customer = aggregate(data, q(measure, filters={"has_customer": True}), viewer=FULL).total
    internal = aggregate(data, q(measure, filters={"has_customer": False}), viewer=FULL).total
    assert customer == internal == every / 2


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            {"measure": "available_days", "filters": {"has_customer": True}},
            "The Has a customer filter does not apply to available days",
        ),
        (
            {"measure": "people_over_capacity", "filters": {"tag_ids": [20]}},
            "The Tags filter does not apply to people over capacity",
        ),
        (
            {"measure": "equipment_utilisation", "filters": {"has_customer": False}},
            "The Has a customer filter does not apply to equipment utilisation",
        ),
        (
            {"measure": "utilisation", "filters": {"equipment_ids": [1]}},
            "The Equipment filter does not apply to utilisation",
        ),
    ],
)
def test_project_filters_stay_refused_beside_utilisation(body, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == message


def test_utilisation_project_filters_need_no_permission_beyond_the_staff_view():
    query = q("utilisation", filters={"project_ids": [1], "has_customer": True, "tag_ids": [20]})
    assert metrics.missing_permission(query, Viewer(frozenset({"views.staff"}))) is None
    assert metrics.filter_needs("utilisation") == {"person_ids": "absences.view_others"}


# --- 2.6.0: calculated widgets (divide_by) -------------------------------------


def divided(
    measure: str,
    divisor: str,
    dimensions: list[dict[str, Any]] | None = None,
    *,
    filters: dict[str, Any] | None = None,
    divisor_filters: dict[str, Any] | None = None,
    result: str | None = None,
) -> MetricQuery:
    divide_by: dict[str, Any] = {"measure": divisor, "filters": divisor_filters or {}}
    if result:
        divide_by["result"] = result
    return q(measure, dimensions, filters=filters or {}, divide_by=divide_by)


# Week 1 (2 March): 5 days on the customer project; week 2: 5 internal days.
SPLIT_WEEKS = [
    booking(1, "2026-03-02", "2026-03-06", project_id=1),
    booking(2, "2026-03-09", "2026-03-13", project_id=2),
]


def split_weeks() -> Facts:
    return facts(projects=CUSTOMER_MIX, bookings=SPLIT_WEEKS, capacity=[person_capacity()])


def test_a_ratio_divides_the_totals():
    query = divided("booked_days", "booked_days", divisor_filters={"has_customer": True})
    result = aggregate(split_weeks(), query, viewer=FULL).to_dict()
    assert result["rows"] == [{"keys": [], "value": 200.0}]
    assert result["total"] == 200.0 and result["unit"] == "percent"
    assert result["dimensions"] == []


def test_a_ratio_as_a_number_has_two_decimals_and_no_unit():
    query = divided("booked_days", "capacity_days", result="number")
    result = aggregate(split_weeks(), query, viewer=FULL)
    assert result.total == 0.45  # 10 / 22
    assert result.unit == "number"


def test_a_ratio_per_period_bucket_with_zero_denominators():
    query = divided("booked_days", "booked_days", WEEKS, divisor_filters={"has_customer": True})
    result = aggregate(split_weeks(), query, viewer=FULL).to_dict()
    rows = [(row["keys"][0]["key"], row["value"]) for row in result["rows"]]
    weeks = metrics.buckets("week", d("2026-03-01"), d("2026-03-31"))
    assert [key for key, _ in rows] == [bucket.key for bucket in weeks]
    values = dict(rows)
    # The week of 2 March: 5 / 5; of 9 March: 5 / 0 (no ratio); the others 0 / 0.
    assert values[weeks[1].key] == 100.0
    assert values[weeks[2].key] is None
    assert [values[b.key] for b in (weeks[0], *weeks[3:])] == [0.0] * (len(weeks) - 2)
    assert result["total"] == 200.0
    assert result["dimensions"] == [{"kind": "period", "label": "Week"}]


def test_a_ratio_of_nothing_over_something_is_zero_and_the_reverse_is_none():
    data = split_weeks()
    # No project carries the Blue tag: nothing booked over Ann's 22 days.
    nothing = divided("booked_days", "capacity_days", filters={"tag_ids": [21]})
    assert aggregate(data, nothing, viewer=FULL).total == 0.0
    over_nothing = divided("booked_days", "booked_days", divisor_filters={"person_ids": [3]})
    assert aggregate(data, over_nothing, viewer=FULL).total is None


def test_a_ratio_of_counts_over_a_sum():
    data = split_weeks()
    query = divided("booking_count", "booked_weeks", result="number")
    assert aggregate(data, query, viewer=FULL).total == 1.0  # 2 bookings / 2 weeks


def test_a_ratio_merges_the_warnings_of_both_sides():
    query = divided(
        "booked_days",
        "booked_days",
        filters={"tag_ids": [99]},
        divisor_filters={"project_ids": [98], "tag_ids": [99]},
    )
    result = aggregate(split_weeks(), query, viewer=FULL)
    assert result.warnings == ["Tag 99 no longer exists", "Project 98 no longer exists"]


def test_a_ratio_keeps_each_sides_archived_mode():
    data = facts(
        projects=[project(1), project(2, archived=True)],
        bookings=[
            booking(1, "2026-03-02", "2026-03-06"),
            booking(2, "2026-03-02", "2026-03-06", project_id=2),
        ],
    )
    query = divided("booked_days", "booked_days", divisor_filters={"archived": "include"})
    assert aggregate(data, query, viewer=FULL).total == 50.0
    assert metrics.query_archived_modes(query) == ("exclude", "include")
    assert metrics.query_archived_modes(q("booked_days")) == ("exclude",)


@pytest.mark.parametrize(
    ("query", "viewer_keys", "needed"),
    [
        # The divisor's family.
        (lambda: divided("booked_days", "capacity_days"), {"views.equipment"}, "views.staff"),
        (
            lambda: divided("booked_days", "equipment_booked_days"),
            {"views.staff"},
            "views.equipment",
        ),
        # The numerator's family first.
        (lambda: divided("capacity_days", "equipment_booked_days"), set(), "views.staff"),
        # The divisor's filters and archived mode.
        (
            lambda: divided("booked_days", "booked_days", divisor_filters={"person_ids": [1]}),
            {"views.archived"},
            "views.staff",
        ),
        (
            lambda: divided("booked_days", "capacity_days", divisor_filters={"person_ids": [1]}),
            {"views.staff"},
            "absences.view_others",
        ),
        (
            lambda: divided("booked_days", "booked_days", divisor_filters={"archived": "only"}),
            {"views.staff"},
            "views.archived",
        ),
        (lambda: divided("booked_days", "booked_days"), set(), None),
    ],
)
def test_a_ratio_checks_the_permissions_of_both_sides(query, viewer_keys, needed):
    built = query()
    viewer = Viewer(frozenset(viewer_keys))
    assert metrics.missing_permission(built, viewer) == needed
    if needed is not None:
        with pytest.raises(MetricError) as caught:
            aggregate(split_weeks(), built, viewer=viewer)
        assert caught.value.message == metrics.permission_message(needed)


def test_a_ratio_reads_the_families_of_both_sides():
    assert metrics.query_families(divided("booked_days", "capacity_days")) == (
        "booking",
        "capacity",
    )
    assert metrics.query_families(divided("capacity_days", "booked_days")) == (
        "capacity",
        "booking",
    )
    assert metrics.query_families(q("utilisation")) == ("capacity", "booking")
    assert metrics.divisor_query(q("booked_days")) is None


def test_the_divisor_shares_the_numerators_period_and_dimensions():
    query = divided("booked_days", "capacity_days", WEEKS, divisor_filters={"team_ids": [10]})
    divisor = metrics.divisor_query(query)
    assert divisor is not None
    assert divisor.measure == "capacity_days"
    assert divisor.dimensions == query.dimensions
    assert divisor.filters.period == query.filters.period
    assert divisor.filters.team_ids == [10]
    assert divisor.percent_of is None and divisor.top_n is None and divisor.divide_by is None


def test_ratio_value_rule():
    assert metrics.ratio_value(1, 4, "percent") == 25.0
    assert metrics.ratio_value(1, 4, "number") == 0.25
    assert metrics.ratio_value(0, 0, "number") == 0.0
    assert metrics.ratio_value(2, 0, "number") is None
    assert metrics.ratio_value(2, 0, "percent") is None


RATIO_REFUSALS = [
    (
        {"dimensions": [{"kind": "site"}]},
        "A calculated widget can only be broken down by period",
    ),
    (
        {"dimensions": [{"kind": "period", "grain": "month"}, {"kind": "site"}]},
        "A calculated widget can only be broken down by period",
    ),
    (
        {"dimensions": [{"kind": "period", "grain": "month"}], "percent_of": "total"},
        "A calculated widget cannot show a percentage of a dimension",
    ),
    (
        {"dimensions": [{"kind": "period", "grain": "month"}], "top_n": 3},
        "A calculated widget has no top N",
    ),
    (
        {"measure": "utilisation"},
        "Utilisation cannot be divided nor divide another measure: "
        "choose a summed or counted measure",
    ),
    (
        {"divide_by": {"measure": "available_days"}},
        "Available days cannot be divided nor divide another measure: "
        "choose a summed or counted measure",
    ),
    (
        {"divide_by": {"measure": "booked_days", "filters": {"milestones": "only"}}},
        "The Milestones filter does not apply to booked days",
    ),
    (
        {
            "divide_by": {"measure": "capacity_days", "filters": {"has_customer": True}},
        },
        "The Has a customer filter does not apply to capacity (days)",
    ),
    (
        {
            "dimensions": [{"kind": "period", "grain": "month"}],
            "divide_by": {"measure": "project_volume"},
        },
        "Project volume cannot be broken down by period",
    ),
    (
        {"divide_by": {"measure": "booked_days", "result": "fraction"}},
        "Input should be 'percent' or 'number'",
    ),
]


@pytest.mark.parametrize(("extra", "message"), RATIO_REFUSALS)
def test_ratio_spec_refusals(extra, message):
    from pydantic import ValidationError

    body = {"measure": "booked_days", "divide_by": {"measure": "capacity_days"}, **extra}
    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(body)
    assert caught.value.errors()[0]["msg"] == message


def test_the_divisor_has_no_period_of_its_own():
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as caught:
        MetricQuery.model_validate(
            {
                "measure": "booked_days",
                "divide_by": {
                    "measure": "capacity_days",
                    "filters": {"period": {"relative": "this_year"}},
                },
            }
        )
    assert caught.value.errors()[0]["type"] == "extra_forbidden"


def test_a_ratio_spec_round_trips_with_its_defaults():
    query = MetricQuery.model_validate(
        {
            "measure": "phases_due",
            "dimensions": [{"kind": "period", "grain": "quarter"}],
            "divide_by": {"measure": "phase_count", "filters": {"milestones": "exclude"}},
        }
    )
    assert query.divide_by is not None
    assert query.divide_by.result == "percent"
    dumped = query.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped["divide_by"] == {"measure": "phase_count", "filters": {"milestones": "exclude"}}


def test_widget_options_take_percent_of_target():
    widget = WidgetIn.model_validate(
        {
            "kind": "kpi",
            "title": "Absorption",
            "query": {"measure": "booked_days"},
            "options": {"target": 70, "percent_of_target": True},
            "layout": {
                "lg": {"x": 0, "y": 0, "w": 3, "h": 2},
                "md": {"x": 0, "y": 0, "w": 4, "h": 2},
                "sm": {"x": 0, "y": 0, "w": 4, "h": 2},
            },
        }
    )
    assert widget.options.percent_of_target is True and widget.options.target == 70


def test_a_ratio_groups_each_bucket_on_its_own():
    # Monthly over Feb-May: Feb both sides, Mar numerator only, Apr denominator
    # only, May neither.
    data = facts(
        projects=[project(1, customer="Acme"), project(2)],
        bookings=[
            booking(1, "2026-02-02", "2026-02-06", project_id=1),
            booking(2, "2026-02-09", "2026-02-13", project_id=2),
            booking(3, "2026-03-02", "2026-03-06", project_id=2),
            booking(4, "2026-04-06", "2026-04-08", project_id=1),
        ],
    )
    query = q(
        "booked_days",
        MONTHS,
        {"from": "2026-02-01", "to": "2026-05-31"},
        filters={"has_customer": False},
        divide_by={"measure": "booked_days", "filters": {"has_customer": True}},
    )
    result = aggregate(data, query, viewer=FULL).to_dict()
    assert [(row["keys"][0]["label"], row["value"]) for row in result["rows"]] == [
        ("Feb 2026", 100.0),  # 5 internal days / 5 customer days
        ("Mar 2026", None),  # 5 / 0
        ("Apr 2026", 0.0),  # 0 / 3
        ("May 2026", 0.0),  # 0 / 0
    ]
    assert result["total"] == 125.0  # 10 / 8
