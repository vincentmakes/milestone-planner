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

from app.models.absence_type import AbsenceType
from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.equipment import Equipment, EquipmentAssignment, EquipmentBlock, EquipmentSite
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.project_field import ProjectField, ProjectFieldOption, ProjectFieldSelection
from app.models.rbac import Role
from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite, Site
from app.models.tag import ProjectTag, Tag
from app.models.team import CompanyEventTeam, ProjectTeam, Team, TeamMember
from app.models.user import User, UserSite
from app.models.vacation import Vacation
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
                    status="in_progress",
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
    assert [(p.id, p.type, p.start, p.end, p.is_milestone, p.status) for p in facts.phases] == [
        (100, "Design", d("2026-03-02"), d("2026-03-13"), False, "in_progress"),
        (101, "Gate", d("2026-03-20"), d("2026-03-20"), True, "todo"),
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
    result = aggregate(
        facts, query, viewer=Viewer(frozenset({"views.staff", "views.equipment", "views.archived"}))
    ).to_dict()
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


async def test_load_facts_accepts_the_families(db):
    # Booking, project and phase facts always load; the capacity and equipment
    # families (Tasks 2 / 3) add their facts only when named.
    facts = await load_facts(
        db,
        period=MARCH,
        visible_site_ids=None,
        archived="exclude",
        today=TODAY,
        families=frozenset({"phase"}),
    )
    assert _bookings(facts) == _bookings(await _load(db))
    assert len(facts.phases) == 2
    assert facts.capacity == {} and facts.equipment == {}
    assert facts.equipment_bookings == [] and facts.equipment_availability == []


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


# --- The capacity family ---------------------------------------------------------
# Ann (sites 1 and 2, teams Alpha and Gamma), Bob (site 1, team Beta, 50 %),
# an inactive Cid, a non-bookable Dee, Eve at a third site and a site-less
# Fin. March 2026: a bank holiday per site, Ann's unavailable week and Home
# Office week, Bob's untyped day and recurring Monday/Wednesday course, a
# whole-site closure at Frankfurt, a closure at Winterthur limited to Beta,
# a legacy single-site closure and an event that closes nothing.


@pytest.fixture
def capacity_db():
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
                Site(id=3, name="Basel"),
                AbsenceType(id=1, name="Holidays", counts_as_unavailable=True),
                AbsenceType(id=2, name="Home Office", counts_as_unavailable=False),
                *(
                    User(
                        id=user_id,
                        email=f"{first.lower()}@x",
                        password="x",
                        first_name=first,
                        last_name="T",
                        max_capacity=capacity,
                        active=active,
                        is_resource=resource,
                    )
                    for user_id, first, capacity, active, resource in (
                        (1, "Ann", 100, 1, True),
                        (2, "Bob", 50, 1, True),
                        (3, "Cid", 100, 0, True),
                        (4, "Dee", 100, 1, False),
                        (5, "Eve", 80, 1, True),
                        (6, "Fin", 100, 1, True),
                    )
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                *(
                    UserSite(user_id=user_id, site_id=site_id)
                    for user_id, site_id in ((1, 1), (1, 2), (2, 1), (3, 1), (4, 1), (5, 3))
                ),
                Team(id=10, site_id=1, name="Alpha"),
                Team(id=11, site_id=1, name="Beta"),
                Team(id=12, site_id=2, name="Gamma"),
                BankHoliday(site_id=1, date=d("2026-03-05"), name="One", year=2026),
                BankHoliday(site_id=2, date=d("2026-03-04"), name="Two", year=2026),
                BankHoliday(site_id=3, date=d("2026-03-06"), name="Three", year=2026),
                Vacation(
                    staff_id=1,
                    start_date=d("2026-03-09"),
                    end_date=d("2026-03-13"),
                    absence_type_id=1,
                ),
                Vacation(
                    staff_id=1,
                    start_date=d("2026-03-16"),
                    end_date=d("2026-03-20"),
                    absence_type_id=2,
                ),
                # Before the period: not loaded.
                Vacation(
                    staff_id=1,
                    start_date=d("2026-02-02"),
                    end_date=d("2026-02-06"),
                    absence_type_id=1,
                ),
                Vacation(staff_id=2, start_date=d("2026-03-23"), end_date=d("2026-03-23")),
                Vacation(
                    staff_id=2,
                    start_date=d("2026-02-01"),
                    end_date=d("2026-04-30"),
                    description="[R:1,3] Course",
                    absence_type_id=1,
                ),
                # Inactive and non-bookable people's absences never count.
                Vacation(staff_id=3, start_date=d("2026-03-02"), end_date=d("2026-03-31")),
                CompanyEvent(
                    id=1,
                    site_id=2,
                    date=d("2026-03-25"),
                    end_date=d("2026-03-27"),
                    name="Frankfurt closed",
                    counts_as_unavailable=True,
                ),
                CompanyEvent(
                    id=2,
                    site_id=1,
                    date=d("2026-03-30"),
                    end_date=d("2026-03-31"),
                    name="Beta offsite",
                    counts_as_unavailable=True,
                ),
                # Legacy: no company_event_sites row, the site_id stands in.
                CompanyEvent(
                    id=3, site_id=1, date=d("2026-03-02"), name="Legacy", counts_as_unavailable=True
                ),
                CompanyEvent(id=4, site_id=1, date=d("2026-03-03"), name="Audit"),
            ]
        )
        session.flush()
        session.add_all(
            [
                TeamMember(team_id=10, user_id=1),
                TeamMember(team_id=12, user_id=1),
                TeamMember(team_id=11, user_id=2),
                CompanyEventSite(event_id=1, site_id=2),
                CompanyEventSite(event_id=2, site_id=1),
                CompanyEventSite(event_id=4, site_id=1),
                CompanyEventTeam(event_id=2, team_id=11),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


ANN_OFF = ["02", "04", "05", "09", "10", "11", "12", "13", "25", "26", "27"]
BOB_OFF = ["02", "04", "05", "09", "11", "16", "18", "23", "25", "30", "31"]


def march(days: list[str]) -> tuple[date, ...]:
    return tuple(d(f"2026-03-{day}") for day in days)


async def _load_capacity(db, visible=None, period=MARCH):
    return await load_facts(
        db,
        period=period,
        visible_site_ids=visible,
        archived="exclude",
        today=TODAY,
        families=frozenset({"capacity", "booking"}),
    )


async def test_capacity_facts(capacity_db):
    facts = await _load_capacity(capacity_db, visible=frozenset({1, 2}))
    assert sorted(facts.capacity) == [1, 2]  # Cid inactive, Dee not bookable, Eve elsewhere
    ann, bob = facts.capacity[1], facts.capacity[2]
    assert (ann.person_name, ann.site_ids, ann.team_ids, ann.max_capacity) == (
        "Ann T",
        (1, 2),
        (10, 12),
        100,
    )
    # A holiday at each of her sites, the unavailable week (not Home Office),
    # the Frankfurt closure and the legacy Winterthur one (not Beta's).
    assert ann.off_days == march(ANN_OFF)
    # The Winterthur holiday, the untyped day, the course's Mondays and
    # Wednesdays, Beta's closure and the legacy one.
    assert (bob.site_ids, bob.team_ids, bob.max_capacity) == ((1,), (11,), 50)
    assert bob.off_days == march(BOB_OFF)
    # The capacity people's sites bring their holidays.
    assert set(facts.holidays) == {1, 2}


async def test_capacity_without_a_site_cut_includes_everyone_bookable(capacity_db):
    facts = await _load_capacity(capacity_db)
    assert sorted(facts.capacity) == [1, 2, 5, 6]
    assert facts.capacity[5].off_days == march(["06"])  # Basel's holiday
    assert facts.capacity[6].site_ids == () and facts.capacity[6].off_days == ()
    assert facts.capacity[1].off_days == march(ANN_OFF)


async def test_capacity_site_cut_keeps_the_persons_other_sites(capacity_db):
    facts = await _load_capacity(capacity_db, visible=frozenset({2}))
    assert sorted(facts.capacity) == [1]
    # Seen through Frankfurt, Ann keeps Winterthur's holiday and closures.
    assert facts.capacity[1].site_ids == (1, 2)
    assert facts.capacity[1].off_days == march(ANN_OFF)
    assert (await _load_capacity(capacity_db, visible=frozenset())).capacity == {}


async def test_capacity_off_days_stay_inside_the_period(capacity_db):
    facts = await _load_capacity(capacity_db, period=(d("2026-03-23"), d("2026-04-08")))
    # Bob's untyped day, the course (March and April) and Beta's closure.
    assert facts.capacity[2].off_days == tuple(
        d(day)
        for day in (
            "2026-03-23",
            "2026-03-25",
            "2026-03-30",
            "2026-03-31",
            "2026-04-01",
            "2026-04-06",
            "2026-04-08",
        )
    )


async def test_capacity_loads_only_when_its_family_is_named(capacity_db):
    facts = await load_facts(
        capacity_db,
        period=MARCH,
        visible_site_ids=None,
        archived="exclude",
        today=TODAY,
        families=frozenset({"booking"}),
    )
    assert facts.capacity == {} and facts.holidays == {}


async def test_absences_count_toward_the_row_cap(capacity_db, monkeypatch):
    # Ann's two March absences, Bob's two (the inactive Cid's is out).
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 3)
    with pytest.raises(TooManyFacts):
        await _load_capacity(capacity_db, visible=frozenset({1, 2}))
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 4)
    assert len((await _load_capacity(capacity_db, visible=frozenset({1, 2}))).capacity) == 2


async def test_loaded_capacity_aggregates(capacity_db):
    capacity_db.add(_project(1, 1, "2026-03-01", "2026-03-31"))
    await capacity_db.flush()
    capacity_db.add(
        ProjectAssignment(
            id=1,
            project_id=1,
            staff_id=2,
            allocation=100,
            start_date=d("2026-03-02"),
            end_date=d("2026-03-06"),
        )
    )
    await capacity_db.commit()
    facts = await _load_capacity(capacity_db, visible=frozenset({1, 2}))
    viewer = Viewer(frozenset({"views.staff"}))

    def ask(measure):
        query = MetricQuery.model_validate(
            {
                "measure": measure,
                "dimensions": [{"kind": "person"}],
                "filters": {"period": {"from": "2026-03-01", "to": "2026-03-31"}},
            }
        )
        result = aggregate(facts, query, viewer=viewer).to_dict()
        return [(r["keys"][0]["label"], r["value"]) for r in result["rows"]], result["total"]

    # Ann: 22 - 11 off days; Bob: (22 - 11) x 50 %.
    assert ask("capacity_days") == ([("Ann T", 11), ("Bob T", 5.5)], 16.5)
    # Bob's booking: 2-6 March less Winterthur's holiday on the 5th = 4 days.
    assert ask("utilisation") == ([("Ann T", 0.0), ("Bob T", 72.73)], 24.24)
    assert ask("people_over_capacity") == ([("Ann T", 0), ("Bob T", 0)], 0)


# --- The equipment family (round 3, Task 3) ------------------------------------
# Three sites with a holiday each; an HPLC at Winterthur with a two-day block
# (and one in February), a mass spectrometer at both sites blocked over a
# weekend into March's last two weekdays, an inactive oven, a site-less rig
# with a blank type and an NMR in Basel. Bookings: two in March, one of an
# archived project, one of the inactive oven, one in April, and one of a
# Frankfurt project that ends before March.


@pytest.fixture
def equipment_db():
    with sqlite_session() as session:
        session.add_all(
            [
                Site(id=1, name="Winterthur"),
                Site(id=2, name="Frankfurt"),
                Site(id=3, name="Basel"),
                Equipment(id=1, name="HPLC A", type="HPLC", site_id=1),
                Equipment(id=2, name="Mass spec", type="MS", site_id=1),
                Equipment(id=3, name="Old oven", type=None, site_id=1, active=0),
                Equipment(id=4, name="Mobile rig", type=""),
                Equipment(id=5, name="Basel NMR", type="NMR", site_id=3),
            ]
        )
        session.flush()
        session.add_all(
            [
                *(
                    EquipmentSite(equipment_id=equipment_id, site_id=site_id)
                    for equipment_id, site_id in ((1, 1), (2, 1), (2, 2), (3, 1), (5, 3))
                ),
                _project(1, 1, "2026-03-01", "2026-03-31"),
                _project(2, 2, "2026-03-01", "2026-03-31"),
                _project(3, 1, "2026-03-01", "2026-03-31", archived=1),
                _project(5, 2, "2026-01-05", "2026-02-27"),
                BankHoliday(site_id=1, date=d("2026-03-05"), name="One", year=2026),
                BankHoliday(site_id=2, date=d("2026-03-04"), name="Two", year=2026),
                BankHoliday(site_id=3, date=d("2026-03-06"), name="Three", year=2026),
                EquipmentBlock(
                    equipment_id=1, start_date=d("2026-03-16"), end_date=d("2026-03-17")
                ),
                EquipmentBlock(
                    equipment_id=1, start_date=d("2026-02-02"), end_date=d("2026-02-06")
                ),
                EquipmentBlock(
                    equipment_id=2, start_date=d("2026-03-28"), end_date=d("2026-04-02")
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                EquipmentAssignment(
                    id=1,
                    project_id=1,
                    equipment_id=1,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-13"),
                ),
                EquipmentAssignment(
                    id=2,
                    project_id=2,
                    equipment_id=2,
                    start_date=d("2026-03-09"),
                    end_date=d("2026-03-13"),
                ),
                EquipmentAssignment(
                    id=3,
                    project_id=3,
                    equipment_id=1,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                ),
                EquipmentAssignment(
                    id=4,
                    project_id=1,
                    equipment_id=3,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-03"),
                ),
                EquipmentAssignment(
                    id=5,
                    project_id=1,
                    equipment_id=1,
                    start_date=d("2026-04-06"),
                    end_date=d("2026-04-10"),
                ),
                # Booked outside its project's dates: the project still loads.
                EquipmentAssignment(
                    id=6,
                    project_id=5,
                    equipment_id=2,
                    start_date=d("2026-03-02"),
                    end_date=d("2026-03-06"),
                ),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


async def _load_equipment(db, visible=None, archived="exclude", period=MARCH):
    return await load_facts(
        db,
        period=period,
        visible_site_ids=visible,
        archived=archived,
        today=TODAY,
        families=frozenset({"equipment"}),
    )


def _equipment_bookings(facts):
    return [(b.id, b.project_id, b.equipment_id, b.start, b.end) for b in facts.equipment_bookings]


def _availability(facts):
    return {a.equipment_id: (a.site_ids, a.off_days) for a in facts.equipment_availability}


async def test_equipment_facts(equipment_db):
    facts = await _load_equipment(equipment_db, visible=frozenset({1, 2}))
    # Every equipment row, whatever its site or state.
    assert [(e.id, e.name, e.type, e.site_ids, e.active) for e in facts.equipment.values()] == [
        (1, "HPLC A", "HPLC", (1,), True),
        (2, "Mass spec", "MS", (1, 2), True),
        (3, "Old oven", None, (1,), False),
        (4, "Mobile rig", "", (), True),
        (5, "Basel NMR", "NMR", (3,), True),
    ]
    # Not the archived project's (3) nor April's (5).
    assert _equipment_bookings(facts) == [
        (1, 1, 1, d("2026-03-02"), d("2026-03-13")),
        (2, 2, 2, d("2026-03-09"), d("2026-03-13")),
        (4, 1, 3, d("2026-03-02"), d("2026-03-03")),
        (6, 5, 2, d("2026-03-02"), d("2026-03-06")),
    ]
    assert sorted(facts.projects) == [1, 2, 5]
    # The active equipment of the visible sites: holidays at any of its sites
    # and the weekdays of its blocks inside the period.
    assert _availability(facts) == {
        1: ((1,), (d("2026-03-05"), d("2026-03-16"), d("2026-03-17"))),
        2: ((1, 2), (d("2026-03-04"), d("2026-03-05"), d("2026-03-30"), d("2026-03-31"))),
    }


async def test_equipment_without_a_site_cut_includes_site_less_equipment(equipment_db):
    facts = await _load_equipment(equipment_db)
    availability = _availability(facts)
    assert sorted(availability) == [1, 2, 4, 5]  # the oven is inactive
    assert availability[4] == ((), ())
    assert availability[5] == ((3,), (d("2026-03-06"),))  # Basel's holiday
    assert set(facts.holidays) == {1, 2, 3}


async def test_equipment_site_cut_keeps_the_equipments_other_sites(equipment_db):
    facts = await _load_equipment(equipment_db, visible=frozenset({2}))
    assert _equipment_bookings(facts) == [
        (2, 2, 2, d("2026-03-09"), d("2026-03-13")),
        (6, 5, 2, d("2026-03-02"), d("2026-03-06")),
    ]
    # Seen through Frankfurt, the mass spectrometer keeps Winterthur's holiday.
    assert _availability(facts) == {
        2: ((1, 2), (d("2026-03-04"), d("2026-03-05"), d("2026-03-30"), d("2026-03-31"))),
    }
    assert set(facts.holidays) == {1, 2}
    empty = await _load_equipment(equipment_db, visible=frozenset())
    assert empty.equipment_bookings == [] and empty.equipment_availability == []
    assert len(empty.equipment) == 5


async def test_equipment_archived_bookings_follow_the_mode(equipment_db):
    facts = await _load_equipment(equipment_db, visible=frozenset({1}), archived="only")
    assert _equipment_bookings(facts) == [(3, 3, 1, d("2026-03-02"), d("2026-03-06"))]


async def test_equipment_off_days_stay_inside_the_period(equipment_db):
    facts = await _load_equipment(equipment_db, period=(d("2026-03-30"), d("2026-04-08")))
    assert _availability(facts)[2][1] == tuple(
        d(day) for day in ("2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02")
    )
    assert _equipment_bookings(facts) == [(5, 1, 1, d("2026-04-06"), d("2026-04-10"))]


async def test_equipment_loads_only_when_its_family_is_named(equipment_db):
    facts = await load_facts(
        equipment_db,
        period=MARCH,
        visible_site_ids=None,
        archived="exclude",
        today=TODAY,
        families=frozenset({"booking", "capacity"}),
    )
    assert facts.equipment == {} and facts.equipment_bookings == []
    assert facts.equipment_availability == []
    assert sorted(facts.projects) == [1, 2]  # no booking pulls project 5 in


async def test_equipment_bookings_count_toward_the_row_cap(equipment_db, monkeypatch):
    # Bookings 1, 2, 4 and 6 (no staff booking in this database).
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 3)
    with pytest.raises(TooManyFacts):
        await _load_equipment(equipment_db)
    monkeypatch.setattr(metrics, "MAX_FACT_ROWS", 4)
    assert len((await _load_equipment(equipment_db)).equipment_bookings) == 4
