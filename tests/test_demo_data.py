"""
The demo data set (app/scripts/demo_data.py) checked against the app's own
rules, without a database: every name a row refers to exists once, the
single-select tag group holds one tag per project, the site-restricted tag sits
only on projects of its site, status/completion pairs follow card_status.py,
dependencies carry `entity` and form no cycle, the PM belongs to the project's
site, recurring absences use the `[R:…]` pattern, mention placeholders name
real people, every range is ordered and holidays carry their year.
"""

import re
from datetime import date, timedelta

import pytest

from app.scripts.demo_data import (
    PHASE_TYPES,
    DemoData,
    build_demo,
    easter_sunday,
    german_holidays,
    phase_progress,
    swiss_holidays,
)
from app.services.card_status import completion_for_status, status_for_completion

TODAY = date(2026, 10, 17)


@pytest.fixture(scope="module")
def demo() -> DemoData:
    return build_demo(TODAY)


def _names(rows, key="name"):
    return [r[key] for r in rows]


def test_every_reference_resolves_to_exactly_one_row(demo: DemoData):
    sites = _names(demo.sites)
    users = _names(demo.users, "email")
    skills = _names(demo.skills)
    equipment = _names(demo.equipment)
    projects = _names(demo.projects)
    groups = _names(demo.tag_groups)
    tags = _names(demo.tags)
    columns = _names(demo.custom_columns)
    for pool in (sites, users, skills, equipment, projects, groups, tags, columns):
        assert len(pool) == len(set(pool))

    phases = {(p["project"], p["type"]) for p in demo.phases}
    subphases = {(s["project"], s["name"]) for s in demo.subphases}
    assert len(phases) == len(demo.phases)
    assert len(subphases) == len(demo.subphases)

    def entity_exists(ent):
        kind, proj, name = ent
        return (proj, name) in (phases if kind == "phase" else subphases)

    for u in demo.users:
        assert set(u["sites"]) <= set(sites) and set(u["skills"]) <= set(skills)
    for e in demo.equipment:
        assert e["sites"] and set(e["sites"]) <= set(sites)
    for t in demo.tags:
        assert t["group"] is None or t["group"] in groups
        assert t["sites"] is None or set(t["sites"]) <= set(sites)
    for p in demo.projects:
        assert p["site"] in sites and set(p["tags"]) <= set(tags)
        assert p["pm"] is None or p["pm"] in users
    for ph in demo.phases:
        assert ph["project"] in projects and ph["type"] in PHASE_TYPES
    for sp in demo.subphases:
        assert (sp["project"], sp["phase"]) in phases
        if sp["parent"]:
            assert (sp["project"], sp["parent"]) in subphases
            assert sp["depth"] == 2
    for d in demo.dependencies:
        assert entity_exists(d["successor"]) and entity_exists(d["predecessor"])
    for a in demo.phase_assignments:
        assert (a["project"], a["phase"]) in phases and a["staff"] in users
    for a in demo.project_assignments:
        assert a["project"] in projects and a["staff"] in users
    for a in demo.subphase_assignments:
        assert (a["project"], a["subphase"]) in subphases and a["staff"] in users
    for b in demo.equipment_bookings:
        assert b["project"] in projects and b["equipment"] in equipment
    for b in demo.equipment_blocks:
        assert b["equipment"] in equipment
    for h in demo.bank_holidays:
        assert h["site"] in sites
    for ev in demo.company_events:
        assert ev["sites"] and set(ev["sites"]) <= set(sites)
    for v in demo.vacations:
        assert v["staff"] in users
    for c in demo.custom_columns:
        assert c["site"] is None or c["site"] in sites
    for val in demo.custom_column_values:
        assert val["column"] in columns and entity_exists(val["entity"])
    for cm in demo.comments:
        assert cm["project"] in projects and cm["author"] in users and entity_exists(cm["entity"])
    for n in demo.notifications:
        assert n["user"] in users and n["actor"] in users and n["project"] in projects
        assert entity_exists(n["entity"])
        assert n["type"] in ("assigned", "comment", "mention", "status_change")
    for note in demo.staff_notes:
        assert note["site"] in sites and note["staff"] in users


def test_canonical_projects_and_people_are_present(demo: DemoData):
    # Referenced by scripts/screenshots/capture.py and the docs' alt text.
    assert {
        "Bioprocess Scale-Up",
        "Catalyst Optimization",
        "Analytical Method Transfer",
        "Quality System Upgrade",
    } <= set(_names(demo.projects))
    assert any(u["first_name"] == "Alice" and u["last_name"] == "Anderson" for u in demo.users)
    assert "HPLC System 1" in _names(demo.equipment)
    assert demo.custom_columns[0]["name"] == "Priority"
    assert any(p["archived"] for p in demo.projects)


def test_single_select_group_has_one_tag_per_project(demo: DemoData):
    single = {g["name"] for g in demo.tag_groups if g["single_select"]}
    assert single == {"Project type"}
    tag_group = {t["name"]: t["group"] for t in demo.tags}
    for p in demo.projects:
        in_group = [t for t in p["tags"] if tag_group[t] == "Project type"]
        assert len(in_group) <= 1, p["name"]
        if not p["archived"]:
            assert in_group, f"{p['name']} needs a project type for the colour-by screenshots"


def test_site_restricted_tags_sit_only_on_their_sites(demo: DemoData):
    restricted = {t["name"]: set(t["sites"]) for t in demo.tags if t["sites"] is not None}
    assert restricted  # the data exercises site applicability
    for p in demo.projects:
        for t in p["tags"]:
            if t in restricted:
                assert p["site"] in restricted[t], (p["name"], t)


def test_status_completion_pairs_follow_card_status(demo: DemoData):
    for item in [*demo.phases, *demo.subphases]:
        status, completion = item["status"], item["completion"]
        if status == "blocked":
            # Blocked keeps whatever progress it had; the seed blocks unstarted work.
            assert completion == 0
            continue
        assert status_for_completion(completion, None) == status, item
        assert completion_for_status(status, completion) == completion, item
    statuses = {p["status"] for p in demo.phases}
    assert {"todo", "in_progress", "done", "blocked"} <= statuses


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (TODAY - timedelta(days=10), TODAY - timedelta(days=1), (100, "done")),
        (TODAY + timedelta(days=1), TODAY + timedelta(days=5), (0, "todo")),
        (TODAY - timedelta(days=5), TODAY + timedelta(days=5), (50, "in_progress")),
        (TODAY, TODAY, (5, "in_progress")),  # starts today: never 0 % in progress
        (TODAY - timedelta(days=99), TODAY, (95, "in_progress")),  # ends today: never 100 %
    ],
)
def test_phase_progress(start, end, expected):
    assert phase_progress(start, end, TODAY) == expected


def test_dependencies_name_their_kind_and_form_no_cycle(demo: DemoData):
    for d in demo.dependencies:
        assert d["predecessor"][0] in ("phase", "subphase")
        assert d["type"] in ("FS", "SS", "FF", "SF")
        assert d["successor"][1] == d["predecessor"][1], "links stay inside one project"
        assert d["successor"] != d["predecessor"]
    # Walk successor → predecessor; a revisit on the current path is a cycle.
    preds: dict[tuple, list[tuple]] = {}
    for d in demo.dependencies:
        preds.setdefault(d["successor"], []).append(d["predecessor"])

    def walk(node, path):
        assert node not in path, f"cycle through {node}"
        for nxt in preds.get(node, []):
            walk(nxt, path | {node})

    for start in preds:
        walk(start, frozenset())
    types = {d["type"] for d in demo.dependencies}
    assert {"FS", "SS"} <= types
    assert any(d["lag"] for d in demo.dependencies)


def test_project_managers_are_members_of_the_project_site(demo: DemoData):
    users = {u["email"]: u for u in demo.users}
    pms = [(p, users[p["pm"]]) for p in demo.projects if p["pm"]]
    assert pms
    for p, pm in pms:
        assert p["site"] in pm["sites"], (p["name"], pm["email"])
        assert pm["active"]
    # The PM rule is exercised by a plain user managing exactly one project.
    assert any(pm["role"] == "user" for _, pm in pms)


def test_people_cover_the_user_panel_states(demo: DemoData):
    assert any(u["max_capacity"] < 100 for u in demo.users)
    assert any(len(u["sites"]) > 1 and u["role"] != "admin" for u in demo.users)
    inactive = [u["email"] for u in demo.users if not u["active"]]
    assert inactive
    assigned = (
        {a["staff"] for a in demo.phase_assignments}
        | {a["staff"] for a in demo.project_assignments}
        | {a["staff"] for a in demo.subphase_assignments}
    )
    assert not assigned & set(inactive), "inactive people are never booked"
    assert any(u["is_system"] for u in demo.users)


def test_absences_cover_every_default_type_and_the_recurring_pattern(demo: DemoData):
    assert {v["type"] for v in demo.vacations} == {
        "Holidays",
        "Home Office",
        "Illness",
        "Business Trip",
        "Training",
    }
    recurring = [v for v in demo.vacations if v["description"].startswith("[R:")]
    assert recurring
    for v in recurring:
        assert re.match(r"^\[R:([0-6](?:,[0-6])*)\]\s\S", v["description"])


def test_mention_placeholders_name_existing_people(demo: DemoData):
    users = {u["email"] for u in demo.users}
    placeholders = [
        email for cm in demo.comments for email in re.findall(r"\{mention:([^}]+)\}", cm["body"])
    ]
    assert placeholders
    assert set(placeholders) <= users
    assert any(n["type"] == "mention" for n in demo.notifications)
    assert any(n["read"] for n in demo.notifications) and any(
        not n["read"] for n in demo.notifications
    )


def test_every_range_is_ordered_and_relative_to_today(demo: DemoData):
    ranged = [
        *demo.projects,
        *demo.phases,
        *demo.subphases,
        *demo.project_assignments,
        *demo.equipment_bookings,
        *demo.equipment_blocks,
        *demo.vacations,
    ]
    for r in ranged:
        assert isinstance(r["start_date"], date) and isinstance(r["end_date"], date)
        assert r["start_date"] <= r["end_date"], r
    for sp in demo.subphases:
        ph = next(
            p for p in demo.phases if (p["project"], p["type"]) == (sp["project"], sp["phase"])
        )
        assert ph["start_date"] <= sp["start_date"] <= sp["end_date"] <= ph["end_date"], sp
        if sp["is_milestone"]:
            assert sp["start_date"] == sp["end_date"]
    for ev in demo.company_events:
        assert ev["end_date"] is None or ev["date"] <= ev["end_date"]
    closure = next(ev for ev in demo.company_events if ev["counts_as_unavailable"])
    assert len(closure["sites"]) == 2 and closure["date"] >= TODAY
    # Rebuilding for another day moves everything with it.
    later = build_demo(TODAY + timedelta(days=100))
    assert later.projects[0]["start_date"] == demo.projects[0]["start_date"] + timedelta(days=100)


def test_holidays_carry_their_year_and_both_sites(demo: DemoData):
    assert {h["site"] for h in demo.bank_holidays} == {"Winterthur", "Frankfurt"}
    assert {h["year"] for h in demo.bank_holidays} == {TODAY.year, TODAY.year + 1}
    for h in demo.bank_holidays:
        assert h["date"].year == h["year"]
    keys = [(h["site"], h["date"], h["name"]) for h in demo.bank_holidays]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize(
    ("year", "expected"),
    [
        (2024, date(2024, 3, 31)),
        (2025, date(2025, 4, 20)),
        (2026, date(2026, 4, 5)),
        (2027, date(2027, 3, 28)),
    ],
)
def test_easter(year, expected):
    assert easter_sunday(year) == expected


def test_holiday_rules_2026():
    swiss = dict((n, d) for d, n in swiss_holidays(2026))
    german = dict((n, d) for d, n in german_holidays(2026))
    assert swiss["Good Friday"] == date(2026, 4, 3)
    assert swiss["Whit Monday"] == date(2026, 5, 25)
    assert swiss["Swiss National Day"] == date(2026, 8, 1)
    assert german["Corpus Christi"] == date(2026, 6, 4)
    assert german["German Unity Day"] == date(2026, 10, 3)
    assert "Swiss National Day" not in german and "Corpus Christi" not in swiss


def test_equipment_shared_by_both_sites_and_overlapping_bookings(demo: DemoData):
    assert any(len(e["sites"]) == 2 for e in demo.equipment)
    hplc = [b for b in demo.equipment_bookings if b["equipment"] == "HPLC System 1"]
    assert len(hplc) == 2
    a, b = sorted(hplc, key=lambda x: x["start_date"])
    assert b["start_date"] <= a["end_date"], "the two HPLC bookings overlap on purpose"
    today_block = [b for b in demo.equipment_blocks if b["start_date"] <= TODAY <= b["end_date"]]
    assert today_block, "something is blocked today"


def test_custom_columns_include_a_site_scoped_one_with_values(demo: DemoData):
    scoped = [c for c in demo.custom_columns if c["site"]]
    assert len(scoped) == 1
    scoped_values = [v for v in demo.custom_column_values if v["column"] == scoped[0]["name"]]
    projects_by_name = {p["name"]: p for p in demo.projects}
    for v in scoped_values:
        assert projects_by_name[v["entity"][1]]["site"] == scoped[0]["site"]
    assert any(v["entity"][0] == "subphase" for v in demo.custom_column_values)
    keys = [(v["column"], v["entity"]) for v in demo.custom_column_values]
    assert len(keys) == len(set(keys))
