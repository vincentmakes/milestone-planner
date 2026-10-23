"""
The metric loader (``metrics.load_facts`` / ``load_extent``) against SQLite.

Two projects at two sites, phases with a nested subphase, bookings at the
three levels (a linked row, an unlinked segment partly outside its card, a
pending row, a nested-subphase row), a multi-day holiday and team
memberships: the facts, the clipping, the pending and archived exclusions,
the visible-site cut and the row cap.
"""

from datetime import date

import pytest

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.project_field import ProjectField, ProjectFieldOption, ProjectFieldSelection
from app.models.rbac import Role
from app.models.site import BankHoliday, Site
from app.models.tag import ProjectTag, Tag
from app.models.team import ProjectTeam, Team, TeamMember
from app.models.user import User
from app.schemas.dashboard import MetricQuery
from app.services import metrics
from app.services.metrics import TooManyFacts, Viewer, aggregate, load_extent, load_facts
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

MARCH = (date(2026, 3, 1), date(2026, 3, 31))
TODAY = date(2026, 10, 23)


def d(text: str) -> date:
    return date.fromisoformat(text)


def _project(project_id: int, site_id: int, start: str, end: str, **extra) -> Project:
    return Project(
        id=project_id,
        name=f"P{project_id}",
        site_id=site_id,
        start_date=d(start),
        end_date=d(end),
        **extra,
    )


@pytest.fixture
def db():
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
                User(id=1, email="ann@x", password="x", first_name="Ann", last_name="A"),
                User(id=2, email="bob@x", password="x", first_name="Bob", last_name="B"),
                User(id=3, email="cid@x", password="x", first_name="Cid", last_name="C"),
            ]
        )
        session.flush()
        session.add_all(
            [
                Team(id=10, site_id=1, name="Alpha", color="#111111"),
                Team(id=11, site_id=2, name="Beta"),
                _project(
                    1,
                    1,
                    "2026-03-01",
                    "2026-04-30",
                    confirmed=1,
                    customer="Acme",
                    pm_id=2,
                    volume=10.0,
                ),
                _project(2, 2, "2026-03-01", "2026-03-31"),
                _project(3, 1, "2026-03-01", "2026-03-31", archived=1),
                _project(4, 1, "2026-06-01", "2026-06-30"),
                Tag(id=20, name="Red", color="#ff0000"),
                ProjectField(id=30, name="Type", field_type="select"),
            ]
        )
        session.flush()
        session.add_all(
            [
                TeamMember(team_id=10, user_id=1),
                TeamMember(team_id=11, user_id=1),
                TeamMember(team_id=10, user_id=2),
                ProjectTeam(project_id=1, team_id=10),
                ProjectTag(project_id=1, tag_id=20),
                ProjectFieldOption(id=300, field_id=30, name="Internal", color="#aaaaaa"),
                ProjectPhase(
                    id=100,
                    project_id=1,
                    type="Design",
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-13"),
                ),
                ProjectPhase(
                    id=101,
                    project_id=1,
                    type="Gate",
                    start_date=d("2026-03-20"),
                    end_date=d("2026-03-24"),
                    is_milestone=1,
                ),
                ProjectPhase(
                    id=102,
                    project_id=1,
                    type="Later",
                    start_date=d("2026-04-06"),
                    end_date=d("2026-04-10"),
                ),
                BankHoliday(
                    site_id=1,
                    date=d("2026-03-05"),
                    end_date=d("2026-03-09"),
                    name="Long weekend",
                    year=2026,
                ),
                BankHoliday(site_id=1, date=d("2026-07-01"), name="Summer", year=2026),
                BankHoliday(site_id=2, date=d("2026-03-04"), name="Fasnacht", year=2026),
            ]
        )
        session.flush()
        session.add_all(
            [
                ProjectFieldSelection(project_id=1, option_id=300),
                ProjectSubphase(
                    id=200,
                    parent_id=100,
                    parent_type="phase",
                    project_id=1,
                    name="Prep",
                    start_date=d("2026-03-09"),
                    end_date=d("2026-03-13"),
                ),
                ProjectSubphase(
                    id=201,
                    parent_id=200,
                    parent_type="subphase",
                    project_id=1,
                    name="Detail",
                    start_date=d("2026-03-10"),
                    end_date=d("2026-03-11"),
                    depth=2,
                ),
                ProjectAssignment(
                    id=1,
                    project_id=1,
                    staff_id=1,
                    allocation=100,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                ),
                ProjectAssignment(
                    id=2,
                    project_id=2,
                    staff_id=2,
                    allocation=100,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                ),
                ProjectAssignment(
                    id=3,
                    project_id=3,
                    staff_id=2,
                    allocation=100,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                ),
                # Linked: the phase's dates.
                PhaseStaffAssignment(id=1, project_id=1, phase_id=100, staff_id=2, allocation=50),
                # A legacy segment partly before its card: clipped to 2-4 March.
                PhaseStaffAssignment(
                    id=2,
                    project_id=1,
                    phase_id=100,
                    staff_id=1,
                    allocation=100,
                    start_date=d("2026-02-23"),
                    end_date=d("2026-03-04"),
                ),
                # Pending: never a fact.
                PhaseStaffAssignment(
                    id=3,
                    project_id=1,
                    phase_id=100,
                    staff_id=3,
                    allocation=100,
                    approval_status="pending",
                ),
                # A segment wholly outside its card: dropped by the clipping.
                PhaseStaffAssignment(
                    id=4,
                    project_id=1,
                    phase_id=102,
                    staff_id=3,
                    allocation=100,
                    start_date=d("2026-03-30"),
                    end_date=d("2026-03-31"),
                ),
            ]
        )
        session.flush()
        session.add(
            SubphaseStaffAssignment(id=1, project_id=1, subphase_id=201, staff_id=1, allocation=100)
        )
        session.commit()
        yield AsyncSessionFacade(session)


def _bookings(facts):
    return sorted(
        (b.level, b.id, b.person_id, b.start, b.end, b.team_ids, b.phase_type, b.allocation)
        for b in facts.bookings
    )


async def _load(db, visible=None, archived="exclude", period=MARCH):
    return await load_facts(
        db, period=period, visible_site_ids=visible, archived=archived, today=TODAY
    )


async def test_load_facts(db):
    facts = await _load(db)

    assert _bookings(facts) == [
        ("phase", 1, 2, d("2026-03-02"), d("2026-03-13"), (10,), "Design", 50),
        ("phase", 2, 1, d("2026-03-02"), d("2026-03-04"), (10,), "Design", 100),
        ("project", 1, 1, d("2026-03-02"), d("2026-03-06"), (10,), None, 100),
        ("project", 2, 2, d("2026-03-02"), d("2026-03-06"), (), None, 100),
        # Nested subphase: the top phase's type.
        ("subphase", 1, 1, d("2026-03-10"), d("2026-03-11"), (10,), "Design", 100),
    ]
    assert sorted(facts.projects) == [1, 2]
    p1 = facts.projects[1]
    assert (p1.site_name, p1.customer, p1.pm_id, p1.pm_name) == ("Winterthur", "Acme", 2, "Bob B")
    assert (p1.confirmed, p1.archived, p1.volume) == (True, False, 10.0)
    assert (p1.team_ids, p1.tag_ids, p1.field_values) == ((10,), (20,), {30: 300})
    assert [(p.id, p.type, p.start, p.end, p.is_milestone) for p in facts.phases] == [
        (100, "Design", d("2026-03-02"), d("2026-03-13"), False),
        (101, "Gate", d("2026-03-20"), d("2026-03-20"), True),
    ]
    assert facts.holidays == {
        1: [d("2026-03-05"), d("2026-03-06"), d("2026-03-09")],
        2: [d("2026-03-04")],
    }
    assert facts.persons == {1: "Ann A", 2: "Bob B", 3: "Cid C"}
    assert facts.sites == {1: "Winterthur", 2: "Frankfurt"}
    assert set(facts.teams) == {10, 11} and facts.teams[10].color == "#111111"
    assert set(facts.tags) == {20} and set(facts.fields) == {30} and set(facts.options) == {300}
    assert facts.project_ids == frozenset({1, 2, 3, 4})
    assert facts.today == TODAY


async def test_loaded_facts_aggregate(db):
    facts = await _load(db)
    query = MetricQuery.model_validate(
        {
            "measure": "booked_days",
            "dimensions": [{"kind": "site"}],
            "filters": {"period": {"from": "2026-03-01", "to": "2026-03-31"}},
        }
    )
    result = aggregate(facts, query, viewer=Viewer(True, True)).to_dict()
    # Winterthur (5, 6 and 9 March off): project row 3 + linked 50 % x 7 +
    # clipped segment 3 + subphase 2 = 11.5; Frankfurt (4 March off): 4.
    assert [(r["keys"][0]["label"], r["value"]) for r in result["rows"]] == [
        ("Frankfurt", 4),
        ("Winterthur", 11.5),
    ]
    assert result["total"] == 15.5


async def test_visible_sites_cut_the_facts(db):
    facts = await _load(db, visible=frozenset({2}))
    assert sorted(facts.projects) == [2]
    assert _bookings(facts) == [("project", 2, 2, d("2026-03-02"), d("2026-03-06"), (), None, 100)]
    assert facts.holidays == {2: [d("2026-03-04")]}


async def test_no_visible_site_loads_nothing(db):
    facts = await _load(db, visible=frozenset())
    assert facts.projects == {} and facts.bookings == [] and facts.phases == []


async def test_archived_modes(db):
    include = await _load(db, archived="include")
    assert sorted(include.projects) == [1, 2, 3]
    assert ("project", 3) in {(b.level, b.id) for b in include.bookings}
    only = await _load(db, archived="only")
    assert sorted(only.projects) == [3]


async def test_project_outside_the_period_is_left_out(db):
    facts = await _load(db, period=(d("2026-06-01"), d("2026-06-30")))
    assert sorted(facts.projects) == [4]
    assert facts.bookings == []


async def test_row_cap(db, monkeypatch):
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 5)
    with pytest.raises(TooManyFacts) as caught:
        await _load(db)
    assert caught.value.message == "Narrow the filters: this query covers too many bookings"
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 6)
    assert len((await _load(db)).bookings) == 5


async def test_load_extent(db):
    assert await load_extent(db, visible_site_ids=None, archived="exclude") == (
        d("2026-03-01"),
        d("2026-06-30"),
    )
    assert await load_extent(db, visible_site_ids=frozenset({2}), archived="exclude") == (
        d("2026-03-01"),
        d("2026-03-31"),
    )
    assert await load_extent(db, visible_site_ids=frozenset({2}), archived="only") is None
