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
from app.services.dashboard_seed import BASE_DASHBOARD, DEMO_EXTRA_WIDGETS, base_dashboard_rows
from app.services.metrics import (
    BookingFact,
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
FULL = Viewer(can_see_staff=True, can_see_archived=True)
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


def facts(
    projects: list[ProjectFact] | None = None,
    bookings: list[BookingFact | None] | None = None,
    phases: list[PhaseFact] | None = None,
    holidays: dict[int, list[date]] | None = None,
    extent: tuple[date, date] | None = None,
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
            Viewer(can_see_staff=False, can_see_archived=True),
            {"measure": "booked_days", "dimensions": [{"kind": "person"}]},
            "This widget needs the Staff view permission",
        ),
        (
            Viewer(can_see_staff=True, can_see_archived=False),
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
    viewer = Viewer(can_see_staff=False, can_see_archived=False)
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


def test_every_seed_widget_parses_and_passes_the_matrix():
    _, rows = base_dashboard_rows({"Project type": 1, "Area": 2})
    assert len(rows) == len(BASE_DASHBOARD["widgets"]) + len(DEMO_EXTRA_WIDGETS)
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
    _, rows = base_dashboard_rows({"Project type": 1, "Area": 2})
    for row in rows:
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
        "The Teams and People filters apply to booked time only",
    ),
    (
        {"measure": "phase_weeks", "filters": {"person_ids": [2]}},
        "The Teams and People filters apply to booked time only",
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
