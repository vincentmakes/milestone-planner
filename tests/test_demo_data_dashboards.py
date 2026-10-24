"""
The demo data set is rich enough for the dashboards (2.1.0): the Overview's
widgets and the two demo extras, run through the real metric engine
(app/services/metrics.aggregate) over facts built from the `DemoData` rows,
each show a real shape, whatever day the demo is seeded on. Plus the rules
every row (old and new) keeps, and the guarantee that the extra projects only
*added* rows: everything the demo held before (the docs name it) is still
there, unchanged (tests/demo_data_snapshot.json, dates as day offsets from
SNAPSHOT_DAY).
"""

import dataclasses
import json
import statistics
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.models.absence_type import DEFAULT_ABSENCE_TYPES
from app.schemas.dashboard import MetricQuery
from app.scripts.demo_data import (
    ALICE,
    ANALYTICAL,
    BIOPROCESS,
    CANONICAL_PROJECTS,
    CATALYST,
    CHARLIE,
    DIANA,
    IMPURITY,
    LEGACY,
    QUALITY,
    SOLVENT,
    DemoData,
    build_demo,
)
from app.services import metrics
from app.services.booking_segments import segments_overlap
from app.services.dashboard_seed import base_dashboard_rows

SNAPSHOT_DAY = date(2026, 10, 17)
SNAPSHOT = Path(__file__).with_name("demo_data_snapshot.json")

# A January, a mid-year and a December seed day.
SEED_DAYS = [date(2027, 1, 14), date(2026, 6, 17), date(2026, 12, 9)]

VIEWER = metrics.Viewer(frozenset({"views.staff", "views.equipment", "views.archived"}))


# ---------------------------------------------------------------------------
# Only added: the snapshot of the demo before the dashboards' extra projects
# ---------------------------------------------------------------------------


def _offsets(value: Any, today: date) -> Any:
    """Rows as JSON-able values, dates as {"d": days from today}."""
    if isinstance(value, date):
        return {"d": (value - today).days}
    if isinstance(value, dict):
        return {k: _offsets(v, today) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_offsets(v, today) for v in value]
    return value


def _is_subsequence(old: list[Any], new: list[Any]) -> bool:
    rest = iter(new)
    return all(any(row == candidate for candidate in rest) for row in old)


def test_every_row_of_the_demo_before_the_extra_projects_is_kept():
    snapshot = json.loads(SNAPSHOT.read_text())
    demo = build_demo(SNAPSHOT_DAY)
    lists = {
        f.name: _offsets(getattr(demo, f.name), SNAPSHOT_DAY)
        for f in dataclasses.fields(demo)
        if isinstance(getattr(demo, f.name), list)
    }
    assert set(snapshot) == set(lists)
    for name, old_rows in snapshot.items():
        assert _is_subsequence(old_rows, lists[name]), name
    # Tables the extra projects leave alone are equal, not merely kept.
    # (The vacations gained the dashboards' two absences, at the end only.)
    for name in ("users", "teams", "tags", "project_fields", "sites", "comments"):
        assert lists[name] == snapshot[name], name


def test_the_canonical_rows_the_docs_name_are_unchanged():
    demo = build_demo(SNAPSHOT_DAY)
    day = timedelta
    t = SNAPSHOT_DAY
    projects = {p["name"]: p for p in demo.projects}
    assert [p["name"] for p in demo.projects[:5]] == list(CANONICAL_PROJECTS)
    expected = {
        CATALYST: ("Winterthur", "Novachem AG", True, t - day(30), t + day(150)),
        BIOPROCESS: ("Winterthur", "BioGen Ltd", True, t - day(15), t + day(200)),
        ANALYTICAL: ("Winterthur", "PharmaCore", False, t + day(14), t + day(120)),
        QUALITY: ("Frankfurt", "Internal", True, t - day(60), t + day(90)),
        LEGACY: ("Winterthur", "AquaPure GmbH", True, t - day(120), t + day(30)),
    }
    for name, (site, customer, confirmed, start, end) in expected.items():
        p = projects[name]
        assert (p["site"], p["customer"], p["confirmed"]) == (site, customer, confirmed), name
        assert (p["start_date"], p["end_date"]) == (start, end), name
    assert projects[CATALYST]["tags"] == ["Critical"]
    assert projects[BIOPROCESS]["tags"] == ["Critical", "Tech Transfer"]
    assert projects[QUALITY]["tags"] == ["GMP"]
    assert projects[ANALYTICAL]["fields"] == {
        "Project type": ["Customer"],
        "Area": ["Analytics", "QA"],
    }
    assert projects[ANALYTICAL]["teams"] == [] and projects[LEGACY]["archived"]

    # Charlie's two stays on the Bioprocess Analytics phase.
    charlie = [
        a
        for a in demo.phase_assignments
        if (a["project"], a["phase"], a["staff"]) == (BIOPROCESS, "Analytics", CHARLIE)
    ]
    analytics = next(
        p for p in demo.phases if (p["project"], p["type"]) == (BIOPROCESS, "Analytics")
    )
    first = analytics["start_date"]
    assert [(a["start_date"], a["end_date"]) for a in charlie] == [
        (first, first + day(2)),
        (first + day(7), first + day(9)),
    ]
    # Alice's week at 50 % on top of her 100 % Trial booking.
    trial = next(p for p in demo.phases if (p["project"], p["type"]) == (BIOPROCESS, "Trial"))
    assert {
        "project": BIOPROCESS,
        "staff": ALICE,
        "allocation": 50,
        "start_date": trial["start_date"],
        "end_date": trial["start_date"] + day(6),
    } in demo.project_assignments
    # Diana's pending request on Bob's project.
    (request,) = demo.approval_requests
    assert (request["requester"], request["project"], request["target"]) == (
        DIANA,
        BIOPROCESS,
        "Analytics",
    )


# ---------------------------------------------------------------------------
# Rules every row keeps
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module", params=SEED_DAYS, ids=lambda d: d.isoformat())
def demo(request) -> DemoData:
    return build_demo(request.param)


def _cards(demo: DemoData) -> dict[tuple[str, str, str], tuple[date, date]]:
    cards = {
        ("phase", p["project"], p["type"]): (p["start_date"], p["end_date"]) for p in demo.phases
    }
    cards.update(
        {
            ("subphase", s["project"], s["name"]): (s["start_date"], s["end_date"])
            for s in demo.subphases
        }
    )
    return cards


def test_every_project_has_phases_and_names_are_unique(demo: DemoData):
    names = [p["name"] for p in demo.projects]
    assert len(names) == len(set(names))
    with_phases = {p["project"] for p in demo.phases}
    assert {p["name"] for p in demo.projects if not p["archived"]} <= with_phases
    assert len(demo.projects) == 13


def test_every_booking_lies_in_its_card_and_its_person_at_the_site(demo: DemoData):
    users = {u["email"]: u for u in demo.users}
    projects = {p["name"]: p for p in demo.projects}
    cards = _cards(demo)
    for a in demo.project_assignments:
        p = projects[a["project"]]
        assert p["start_date"] <= a["start_date"] <= a["end_date"] <= p["end_date"], a
        assert 1 <= a["allocation"] <= 100
    for kind, rows, key in (
        ("phase", demo.phase_assignments, "phase"),
        ("subphase", demo.subphase_assignments, "subphase"),
    ):
        for a in rows:
            start, end = cards[(kind, a["project"], a[key])]
            if "start_date" in a:
                assert start <= a["start_date"] <= a["end_date"] <= end, a
            assert 1 <= a["allocation"] <= 100
    for a in [*demo.project_assignments, *demo.phase_assignments, *demo.subphase_assignments]:
        person = users[a["staff"]]
        assert projects[a["project"]]["site"] in person["sites"], a
        assert person["active"] and person["is_resource"], a


def test_one_persons_segments_on_a_card_never_overlap(demo: DemoData):
    by_card: dict[tuple[str, str, str], list[tuple[date, date]]] = {}
    for a in demo.phase_assignments:
        if "start_date" in a:
            by_card.setdefault((a["project"], a["phase"], a["staff"]), []).append(
                (a["start_date"], a["end_date"])
            )
        else:
            # A linked booking spans the card: no segment of that person beside it.
            assert all(
                (b["project"], b["phase"], b["staff"]) != (a["project"], a["phase"], a["staff"])
                for b in demo.phase_assignments
                if b is not a
            ), a
    two = [rows for rows in by_card.values() if len(rows) > 1]
    assert len(two) >= 2  # Charlie's, and the one on Impurity Profiling
    for rows in two:
        for i, a in enumerate(rows):
            for b in rows[i + 1 :]:
                assert not segments_overlap(*a, *b)


def test_teams_tags_and_items_follow_their_scope(demo: DemoData):
    teams = {(t["site"], t["name"]) for t in demo.teams}
    tags = {t["name"]: t for t in demo.tags}
    items = {f["name"]: {o["name"] for o in f["options"]} for f in demo.project_fields}
    for p in demo.projects:
        assert {(p["site"], name) for name in p["teams"]} <= teams, p["name"]
        for name in p["tags"]:
            tag = tags[name]
            assert tag["sites"] is None or p["site"] in tag["sites"], (p["name"], name)
            scoped = {team for site, team in tag["teams"] if site == p["site"]}
            assert not scoped or scoped & set(p["teams"]), (p["name"], name)
        for field_name, chosen in p["fields"].items():
            assert set(chosen) <= items[field_name], p["name"]
        assert len(p["fields"].get("Project type", [])) <= 1


def test_the_extra_projects_mix_sites_types_and_states(demo: DemoData):
    today = demo.today
    extra = [p for p in demo.projects if p["name"] not in CANONICAL_PROJECTS]
    assert len(extra) == 8
    assert sorted(p["site"] for p in extra).count("Frankfurt") == 5
    assert sum(p["confirmed"] for p in extra) == 5
    assert (
        sorted(p["fields"]["Project type"][0] for p in extra) == ["Customer"] * 4 + ["Internal"] * 4
    )
    for area in ("Process", "Analytics", "QA"):
        assert sum(area in p["fields"]["Area"] for p in extra) >= 3, area
    past = [p for p in extra if p["end_date"] < today]
    running = [p for p in extra if p["start_date"] <= today <= p["end_date"]]
    planned = [p for p in extra if p["start_date"] > today]
    assert (len(past), len(running), len(planned)) == (3, 3, 2)
    assert all(not p["archived"] for p in extra)
    assert {p["pm"] for p in extra} == {
        "bob.brown@demo.local",
        "fiona.fischer@demo.local",
        "george.garcia@demo.local",
        "alice.anderson@demo.local",
    }
    assert all(p["teams"] for p in extra)
    assert sum(bool(p["sales_pm"]) for p in extra) >= 2
    extra_names = {p["name"] for p in extra}
    assert len({s["project"] for s in demo.subphases} & extra_names) == 2
    assert sum(a["project"] in extra_names for a in demo.project_assignments) == 4


def test_bank_holidays_cover_last_year_this_year_and_next(demo: DemoData):
    years = {(h["site"], h["year"]) for h in demo.bank_holidays}
    y = demo.today.year
    assert years == {
        (site, year) for site in ("Winterthur", "Frankfurt") for year in (y - 1, y, y + 1)
    }


# ---------------------------------------------------------------------------
# The dashboards over the demo, through the real engine
# ---------------------------------------------------------------------------


def build_facts(demo: DemoData) -> metrics.Facts:
    """`metrics.Facts` from the demo rows, ids handed out in row order."""
    site_id = {s["name"]: i + 1 for i, s in enumerate(demo.sites)}
    person_id = {u["email"]: i + 1 for i, u in enumerate(demo.users)}
    persons = {person_id[u["email"]]: f"{u['first_name']} {u['last_name']}" for u in demo.users}
    team_id = {(t["site"], t["name"]): i + 1 for i, t in enumerate(demo.teams)}
    teams = {
        team_id[(t["site"], t["name"])]: metrics.TeamInfo(
            team_id[(t["site"], t["name"])], t["name"], t["color"], site_id[t["site"]]
        )
        for t in demo.teams
    }
    tag_id = {t["name"]: i + 1 for i, t in enumerate(demo.tags)}
    tags = {
        tag_id[t["name"]]: metrics.TagInfo(
            tag_id[t["name"]], t["name"], t["color"], t["sort_order"]
        )
        for t in demo.tags
    }
    fields: dict[int, metrics.FieldInfo] = {}
    options: dict[int, metrics.OptionInfo] = {}
    option_id: dict[tuple[str, str], int] = {}
    for fi, f in enumerate(demo.project_fields, start=1):
        fields[fi] = metrics.FieldInfo(fi, f["name"], f["field_type"], f["sort_order"])
        for o in f["options"]:
            oid = len(options) + 1
            option_id[(f["name"], o["name"])] = oid
            options[oid] = metrics.OptionInfo(oid, fi, o["name"], o["color"], o["sort_order"])
    field_id = {f.name: f.id for f in fields.values()}

    project_id = {p["name"]: i + 1 for i, p in enumerate(demo.projects)}
    projects: dict[int, metrics.ProjectFact] = {}
    for p in demo.projects:
        values: dict[int, Any] = {}
        for name, chosen in p["fields"].items():
            ids = [option_id[(name, item)] for item in chosen]
            values[field_id[name]] = ids[0] if name == "Project type" else ids
        projects[project_id[p["name"]]] = metrics.ProjectFact(
            id=project_id[p["name"]],
            name=p["name"],
            site_id=site_id[p["site"]],
            site_name=p["site"],
            archived=p["archived"],
            start=p["start_date"],
            end=p["end_date"],
            customer=p["customer"],
            pm_id=person_id[p["pm"]] if p["pm"] else None,
            pm_name=persons[person_id[p["pm"]]] if p["pm"] else None,
            confirmed=p["confirmed"],
            volume=None,
            team_ids=tuple(team_id[(p["site"], t)] for t in p["teams"]),
            tag_ids=tuple(tag_id[t] for t in p["tags"]),
            field_values=values,
        )
    site_of = {p["name"]: p["site"] for p in demo.projects}

    def person_teams(email: str, project: str) -> tuple[int, ...]:
        site = site_of[project]
        return tuple(
            team_id[(t["site"], t["name"])]
            for t in demo.teams
            if t["site"] == site and email in t["members"]
        )

    cards = _cards(demo)
    phases = [
        metrics.PhaseFact(
            i,
            project_id[p["project"]],
            p["type"],
            p["start_date"],
            p["end_date"],
            is_milestone=p["is_milestone"],
            status=p["status"],
        )
        for i, p in enumerate(demo.phases, start=1)
    ]
    phase_of_subphase = {(s["project"], s["name"]): s["phase"] for s in demo.subphases}
    bookings: list[metrics.BookingFact] = []

    def book(level: str, a: dict[str, Any], span: tuple[date, date] | None, phase: str | None):
        if span is None:
            return
        bookings.append(
            metrics.BookingFact(
                id=len(bookings) + 1,
                level=level,
                project_id=project_id[a["project"]],
                person_id=person_id[a["staff"]],
                person_name=persons[person_id[a["staff"]]],
                team_ids=person_teams(a["staff"], a["project"]),
                allocation=a["allocation"],
                start=span[0],
                end=span[1],
                phase_type=phase,
            )
        )

    for a in demo.project_assignments:
        p = projects[project_id[a["project"]]]
        start, end = max(a["start_date"], p.start), min(a["end_date"], p.end)
        book("project", a, (start, end) if start <= end else None, None)
    for a in demo.phase_assignments:
        card = cards[("phase", a["project"], a["phase"])]
        span = metrics.clip_to_card(a.get("start_date"), a.get("end_date"), *card)
        book("phase", a, span, a["phase"])
    for a in demo.subphase_assignments:
        card = cards[("subphase", a["project"], a["subphase"])]
        span = metrics.clip_to_card(a.get("start_date"), a.get("end_date"), *card)
        book("subphase", a, span, phase_of_subphase[(a["project"], a["subphase"])])

    holidays = metrics.expand_holidays(
        ((site_id[h["site"]], h["date"], None) for h in demo.bank_holidays),
        (date(1900, 1, 1), date(2999, 12, 31)),
    )

    # The capacity family, the way load_facts builds it: the active bookable
    # people, their sites and every team, their absences (a type that does not
    # count as unavailable leaves them plannable) and the site closures.
    period = (demo.today - timedelta(days=3 * 366), demo.today + timedelta(days=3 * 366))
    unavailable_type = {name: unavailable for name, _, unavailable in DEFAULT_ABSENCE_TYPES}
    closures = [
        metrics.ClosureSpan(
            e["date"],
            e["end_date"] or e["date"],
            tuple(sorted(site_id[s] for s in e["sites"])),
            tuple(sorted(team_id[t] for t in e["teams"])),
        )
        for e in demo.company_events
        if e["counts_as_unavailable"]
    ]
    team_sites = {team.id: team.site_id for team in teams.values()}
    capacity: dict[int, metrics.CapacityFact] = {}
    for u in demo.users:
        if not (u["active"] and u["is_resource"]):
            continue
        pid = person_id[u["email"]]
        sites = sorted(site_id[s] for s in u["sites"])
        member_of = sorted(
            team_id[(t["site"], t["name"])] for t in demo.teams if u["email"] in t["members"]
        )
        absences = [
            metrics.AbsenceSpan(
                v["start_date"], v["end_date"], v["description"], unavailable_type[v["type"]]
            )
            for v in demo.vacations
            if v["staff"] == u["email"]
        ]
        capacity[pid] = metrics.CapacityFact(
            person_id=pid,
            person_name=persons[pid],
            site_ids=tuple(sites),
            team_ids=tuple(member_of),
            max_capacity=u["max_capacity"],
            off_days=metrics.person_off_days(
                period, sites, member_of, holidays, absences, closures, team_sites
            ),
        )

    # The equipment family: every row, the bookings, and the availability of
    # every active equipment (every site visible) minus its blocks.
    equipment_id = {e["name"]: i + 1 for i, e in enumerate(demo.equipment)}
    equipment = {
        equipment_id[e["name"]]: metrics.EquipmentInfo(
            id=equipment_id[e["name"]],
            name=e["name"],
            type=e["type"],
            site_ids=tuple(sorted(site_id[s] for s in e["sites"])),
            active=True,
        )
        for e in demo.equipment
    }
    equipment_bookings = [
        metrics.EquipmentBookingFact(
            i,
            project_id[b["project"]],
            equipment_id[b["equipment"]],
            b["start_date"],
            b["end_date"],
        )
        for i, b in enumerate(demo.equipment_bookings, start=1)
    ]
    equipment_availability = [
        metrics.EquipmentAvailabilityFact(
            equipment_id=info.id,
            site_ids=info.site_ids,
            off_days=metrics.equipment_off_days(
                period,
                info.site_ids,
                holidays,
                [
                    (b["start_date"], b["end_date"])
                    for b in demo.equipment_blocks
                    if equipment_id[b["equipment"]] == info.id
                ],
            ),
        )
        for info in equipment.values()
    ]
    live = [p for p in projects.values() if not p.archived]
    return metrics.Facts(
        projects=projects,
        phases=phases,
        bookings=bookings,
        holidays=holidays,
        persons=persons,
        teams=teams,
        fields=fields,
        options=options,
        tags=tags,
        sites={v: k for k, v in site_id.items()},
        today=demo.today,
        extents={
            "exclude": (min(p.start for p in live), max(p.end for p in live)),
        },
        capacity=capacity,
        equipment=equipment,
        equipment_bookings=equipment_bookings,
        equipment_availability=equipment_availability,
    )


def _overview(facts: metrics.Facts) -> dict[str, metrics.MetricResult]:
    """Every Overview widget (with the two demo extras), by title."""
    field_ids = {f.name: f.id for f in facts.fields.values()}
    _, widgets = base_dashboard_rows(field_ids)
    assert len(widgets) == 10
    return {
        w["title"]: metrics.aggregate(
            facts, MetricQuery.model_validate(json.loads(w["query"])), viewer=VIEWER
        )
        for w in widgets
    }


def _query(measure: str, dimensions: list[dict[str, Any]], period: str) -> MetricQuery:
    return MetricQuery.model_validate(
        {
            "measure": measure,
            "dimensions": dimensions,
            "filters": {"archived": "exclude", "period": {"relative": period}},
        }
    )


def _labels(result: metrics.MetricResult, index: int = 0) -> list[str]:
    return [row["keys"][index]["label"] for row in result.rows if row["value"]]


@pytest.fixture(scope="module")
def facts(demo: DemoData) -> metrics.Facts:
    return build_facts(demo)


def test_every_overview_widget_has_a_shape(facts: metrics.Facts):
    results = _overview(facts)
    for title, result in results.items():
        assert result.total > 0, title
        assert not result.warnings, title

    months = [row["value"] for row in results["Booked weeks per month"].rows]
    assert len(months) == 12
    assert sum(1 for value in months if value > 0) >= 10
    median = statistics.median(months)
    assert max(months) <= 3 * median, months

    sites = {row["keys"][0]["label"]: row["value"] for row in results["Projects by site"].rows}
    assert set(sites) == {"Winterthur", "Frankfurt"}
    assert min(sites.values()) >= 0.4 * sum(sites.values()), sites

    per_project = results["Booked weeks per project"]
    assert len([row for row in per_project.rows if row["keys"][0]["label"] != "Other"]) >= 8

    by_team: dict[str, set[str]] = {}
    for row in results["Booked time per team by Confirmed"].rows:
        if row["value"]:
            by_team.setdefault(row["keys"][0]["label"], set()).add(row["keys"][1]["label"])
    assert set(by_team) == {
        "Analytical Lab",
        "Process Development",
        "QA & Compliance",
        "Formulation",
    }
    assert sum(len(states) == 2 for states in by_team.values()) >= 2, by_team

    per_type = {
        row["keys"][1]["label"]
        for row in results["Share of time by Project type per team"].rows
        if row["value"]
    }
    assert per_type == {"Internal", "Customer"}
    assert set(_labels(results["Booked weeks by Area"])) == {"Process", "Analytics", "QA"}

    assert results["People booked"].total >= 7


def test_last_year_and_all_time_have_data(facts: metrics.Facts):
    today = facts.today
    last_year = metrics.aggregate(facts, _query("booked_weeks", [], "last_year"), viewer=VIEWER)
    assert last_year.total > 0
    touching = metrics.aggregate(
        facts, _query("project_count", [{"kind": "project"}], "last_year"), viewer=VIEWER
    )
    assert len(_labels(touching)) >= 3

    everything = metrics.aggregate(
        facts,
        _query("booked_weeks", [{"kind": "period", "grain": "quarter"}], "all"),
        viewer=VIEWER,
    )
    start, end = everything.period
    assert start <= today - timedelta(days=15 * 30) and end >= today + timedelta(days=9 * 30 - 5)
    assert sum(1 for row in everything.rows if row["value"]) >= 7
    by_year = metrics.aggregate(
        facts, _query("booked_weeks", [{"kind": "period", "grain": "year"}], "all"), viewer=VIEWER
    )
    assert len(_labels(by_year)) >= 2


@pytest.mark.parametrize(
    ("dimension", "at_least"),
    [
        ({"kind": "customer"}, 7),
        ({"kind": "project_manager"}, 4),
        ({"kind": "person"}, 7),
        ({"kind": "site"}, 2),
        ({"kind": "team"}, 4),
        ({"kind": "project_team"}, 4),
        ({"kind": "tag"}, 3),
        ({"kind": "confirmed"}, 2),
    ],
)
def test_the_main_breakdowns_have_several_values(facts, dimension, at_least):
    result = metrics.aggregate(facts, _query("booked_weeks", [dimension], "all"), viewer=VIEWER)
    labels = [label for label in _labels(result) if not label.startswith("No ")]
    assert len(labels) >= at_least, labels


def test_customers_managers_people_and_tags_this_year(demo: DemoData, facts: metrics.Facts):
    live = [p for p in demo.projects if not p["archived"]]
    customers = {p["customer"] for p in live}
    assert "Internal" in customers and len(customers - {"Internal"}) >= 6
    assert len({p["pm"] for p in live if p["pm"]}) >= 4
    for tag in demo.tags:
        assert sum(tag["name"] in p["tags"] for p in live) >= 2, tag["name"]
    people = metrics.aggregate(
        facts, _query("booked_weeks", [{"kind": "person"}], "this_year"), viewer=VIEWER
    )
    assert len(_labels(people)) >= 7


# ---------------------------------------------------------------------------
# The capacity, equipment and delivery measures over the demo
# ---------------------------------------------------------------------------


def _custom(measure: str, dimensions: list[dict[str, Any]], start: date, end: date) -> MetricQuery:
    return MetricQuery.model_validate(
        {
            "measure": measure,
            "dimensions": dimensions,
            "filters": {
                "archived": "exclude",
                "period": {"from": start.isoformat(), "to": end.isoformat()},
            },
        }
    )


def _values(result: metrics.MetricResult) -> dict[str, float | None]:
    return {row["keys"][0]["label"]: row["value"] for row in result.rows}


def test_utilisation_per_team_is_plausible_and_someone_runs_over(facts: metrics.Facts):
    def run(measure: str, dimensions: list[dict[str, Any]], period: str) -> metrics.MetricResult:
        return metrics.aggregate(facts, _query(measure, dimensions, period), viewer=VIEWER)

    # This quarter: every team has a figure, none absurd (a quarter seeded
    # late is mostly past, which the demo plans more lightly).
    teams = _values(run("utilisation", [{"kind": "team"}], "this_quarter"))
    assert len(teams) >= 3
    assert all(value is not None and 30 <= value <= 130 for value in teams.values()), teams
    # Next month is planned densely: one team at or over its capacity, and
    # someone over theirs, whatever day the demo is seeded.
    ahead = _values(run("utilisation", [{"kind": "team"}], "next_month"))
    assert max(v for v in ahead.values() if v is not None) >= 95, ahead
    assert run("people_over_capacity", [], "next_month").total >= 1
    # Available days per bookable person (the admin and Edward are not).
    available = _values(run("available_days", [{"kind": "person"}], "this_quarter"))
    assert len(available) == 7, available


@pytest.mark.parametrize("today", [date(2026, 10, 24), date(2027, 1, 14)], ids=str)
def test_a_quarter_seeded_early_shows_a_team_over_capacity(today: date):
    """Seeded in the first half of a quarter, the quarter is mostly planned work."""
    facts = build_facts(build_demo(today))
    teams = metrics.aggregate(
        facts, _query("utilisation", [{"kind": "team"}], "this_quarter"), viewer=VIEWER
    )
    values = _values(teams)
    assert len(values) >= 3 and None not in values.values()
    over = [name for name, value in values.items() if value is not None and value >= 95]
    assert "Process Development" in over, values
    assert all(value is not None and 40 <= value <= 130 for value in values.values()), values
    people = metrics.aggregate(
        facts, _query("people_over_capacity", [], "this_quarter"), viewer=VIEWER
    )
    assert people.total >= 1
    negative = _values(
        metrics.aggregate(
            facts, _query("available_days", [{"kind": "person"}], "this_quarter"), viewer=VIEWER
        )
    )
    assert negative["Bob Brown"] is not None and negative["Bob Brown"] < 0, negative


def test_the_two_new_absences_take_capacity(demo: DemoData, facts: metrics.Facts):
    bob, charlie = demo.vacations[-2:]
    assert (bob["type"], charlie["type"]) == ("Illness", "Holidays")
    for absence in (bob, charlie):
        assert (absence["end_date"] - absence["start_date"]).days == 6
    names = {f"{u['first_name']} {u['last_name']}": u["email"] for u in demo.users}
    by_email = {names[c.person_name]: c for c in facts.capacity.values()}
    for absence in (bob, charlie):
        off = set(by_email[absence["staff"]].off_days)
        week = [
            absence["start_date"] + timedelta(days=i)
            for i in range(7)
            if (absence["start_date"] + timedelta(days=i)).weekday() < 5
        ]
        assert set(week) <= off, absence


def test_equipment_time_covers_every_instrument_and_double_bookings_run_over(
    demo: DemoData, facts: metrics.Facts
):
    year = _values(
        metrics.aggregate(
            facts,
            _query("equipment_utilisation", [{"kind": "equipment"}], "this_year"),
            viewer=VIEWER,
        )
    )
    assert len(year) == len(demo.equipment) >= 6
    assert sum(1 for value in year.values() if value) >= 6, year
    assert all(value is not None and value < 100 for value in year.values()), year
    types = {e["type"] for e in demo.equipment}
    booked_types = {
        e["type"]
        for e in demo.equipment
        for b in demo.equipment_bookings
        if b["equipment"] == e["name"]
    }
    assert booked_types == types

    # The two overlaps: HPLC System 1 (with a block in the same days) and
    # the Mass Spectrometer, each over 100 % in the days both bookings share.
    def booking(equipment: str, project: str) -> dict[str, Any]:
        (row,) = (
            b
            for b in demo.equipment_bookings
            if (b["equipment"], b["project"]) == (equipment, project)
        )
        return row

    overlaps = {
        "HPLC System 1": (booking("HPLC System 1", CATALYST), booking("HPLC System 1", BIOPROCESS)),
        "Mass Spectrometer": (
            booking("Mass Spectrometer", SOLVENT),
            booking("Mass Spectrometer", IMPURITY),
        ),
    }
    for name, (first, second) in overlaps.items():
        start = max(first["start_date"], second["start_date"])
        end = min(first["end_date"], second["end_date"])
        assert start <= end, name
        shared = _values(
            metrics.aggregate(
                facts,
                _custom("equipment_utilisation", [{"kind": "equipment"}], start, end),
                viewer=VIEWER,
            )
        )
        assert shared[name] is not None and shared[name] > 100, (name, shared)
    per_project = metrics.aggregate(
        facts, _query("equipment_booked_days", [{"kind": "project"}], "all"), viewer=VIEWER
    )
    assert len(_labels(per_project)) >= 10


def test_phases_are_due_every_month_and_one_is_late(demo: DemoData, facts: metrics.Facts):
    overdue = metrics.aggregate(
        facts, _query("phases_overdue", [], "last_12_months"), viewer=VIEWER
    )
    assert overdue.total >= 1
    due = metrics.aggregate(
        facts,
        _query("phases_due", [{"kind": "period", "grain": "month"}], "next_12_months"),
        viewer=VIEWER,
    )
    assert sum(1 for row in due.rows if row["value"]) >= 3
    statuses = metrics.aggregate(
        facts, _query("phase_count", [{"kind": "status"}], "all"), viewer=VIEWER
    )
    assert set(_labels(statuses)) == {"To do", "In progress", "Blocked", "Done"}
