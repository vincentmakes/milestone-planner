"""
The demo seed loader (app/services/demo_seed.py, shared by the seed_demo CLI
and the admin portal's provisioning) against a recording fake of an asyncpg
connection: every insert is guarded (NOT EXISTS or ON CONFLICT), rows come in
foreign-key order, names resolve to the ids the fake hands out, dependency
JSON and mention tokens are built from those ids, the admin alone can get a
caller-supplied password hash, and the CLI's already-seeded check skips the
whole thing.
"""

import json
import re
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import bcrypt
import pytest

from app.scripts import seed_demo
from app.scripts.demo_data import DEMO_PASSWORD, build_demo
from app.services import demo_seed
from app.services.encryption import verify_user_password
from app.services.mentions import parse_mention_ids

_real_gensalt = bcrypt.gensalt


@pytest.fixture(autouse=True)
def fast_bcrypt(monkeypatch):
    monkeypatch.setattr(bcrypt, "gensalt", lambda rounds=12: _real_gensalt(rounds=4))


class RecordingConn:
    """asyncpg stand-in: records SQL, hands out ids per (table, natural key)."""

    def __init__(self):
        self.executed: list[tuple[str, tuple]] = []
        self.ids: dict[tuple, int] = {}
        self.closed = False

    # The command status asyncpg returns: every guarded INSERT inserts here
    # (a fresh database); ``existing`` names tables whose rows are already there.
    existing: frozenset[str] = frozenset()

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        m = re.match(r"\s*INSERT INTO (\w+)", sql)
        if m:
            return "INSERT 0 0" if m.group(1) in self.existing else "INSERT 0 1"
        return "UPDATE 1" if sql.lstrip().startswith("UPDATE") else "OK"

    def updates(self, table: str) -> list[tuple[str, tuple]]:
        return [(s, a) for s, a in self.executed if re.match(rf"\s*UPDATE {table}\b", s)]

    async def fetchval(self, sql, *args):
        if sql.startswith("SELECT id FROM absence_types"):
            return 99
        m = re.match(r"SELECT id FROM (\w+) WHERE", sql)
        assert m, f"unexpected fetchval: {sql}"
        key = (m.group(1), args)
        if key not in self.ids:
            self.ids[key] = 1000 + len(self.ids)
        return self.ids[key]

    async def close(self):
        self.closed = True

    def inserts(self, table: str) -> list[tuple[str, tuple]]:
        return [(s, a) for s, a in self.executed if re.match(rf"\s*INSERT INTO {table}\b", s)]

    def first_insert_index(self, table: str) -> int:
        return next(
            i for i, (s, _) in enumerate(self.executed) if re.match(rf"\s*INSERT INTO {table}\b", s)
        )


@pytest.fixture
async def loaded():
    conn = RecordingConn()
    demo = build_demo(date(2026, 10, 17))
    counts = await demo_seed.insert_demo_data(conn, demo)
    return conn, demo, counts


async def test_every_insert_is_idempotent(loaded):
    conn, _, _ = loaded
    for table in (
        "teams",
        "team_members",
        "project_teams",
        "tag_teams",
        "equipment_teams",
        "company_event_teams",
    ):
        assert conn.inserts(table), table  # the team rows are covered below
    unguarded = [
        s
        for s, _ in conn.executed
        if s.lstrip().startswith("INSERT") and "NOT EXISTS" not in s and "ON CONFLICT" not in s
    ]
    assert unguarded == []
    # A guarded insert never overwrites what is there.
    assert not [s for s, _ in conn.executed if "DO UPDATE" in s]
    updates = [s for s, _ in conn.executed if s.lstrip().startswith("UPDATE")]
    assert updates
    for sql in updates:
        # Only empty columns are filled (dependencies, a request's row link),
        # plus the demo's role / policy settings, which a re-run never repeats
        # (test_a_rerun_leaves_role_and_policy_settings_alone).
        assert (
            "dependencies IS NULL OR dependencies IN" in sql
            or "AND assignment_id IS NULL" in sql
            or re.match(r"\s*UPDATE (role_permissions|approval_policies) SET", sql)
        ), sql


async def test_rows_come_in_foreign_key_order(loaded):
    conn, _, _ = loaded
    order = [
        "sites",
        "skills",
        "roles",
        "role_permissions",
        "approval_policy_roles",
        "users",
        "teams",
        "equipment",
        "project_fields",
        "project_field_options",
        "tags",
        "projects",
        "project_phases",
        "project_subphases",
        "phase_staff_assignments",
        "approval_requests",
        "equipment_assignments",
        "company_events",
        "vacations",
        "custom_columns",
        "custom_column_values",
        "card_comments",
        "notifications",
        "staff_notes",
    ]
    positions = [conn.first_insert_index(t) for t in order]
    assert positions == sorted(positions)
    # Join tables follow the rows they link.
    assert conn.first_insert_index("user_sites") > conn.first_insert_index("users")
    assert conn.first_insert_index("equipment_sites") > conn.first_insert_index("equipment")
    assert conn.first_insert_index("project_tags") > conn.first_insert_index("projects")
    assert conn.first_insert_index("project_field_selections") > conn.first_insert_index("projects")
    assert conn.first_insert_index("company_event_sites") > conn.first_insert_index(
        "company_events"
    )
    assert conn.first_insert_index("tag_sites") > conn.first_insert_index("tags")
    assert conn.first_insert_index("teams") > conn.first_insert_index("user_sites")
    assert conn.first_insert_index("team_members") > conn.first_insert_index("teams")
    assert conn.first_insert_index("equipment_teams") > conn.first_insert_index("equipment")
    assert conn.first_insert_index("tag_teams") > conn.first_insert_index("tags")
    assert conn.first_insert_index("project_teams") > conn.first_insert_index("projects")
    assert conn.first_insert_index("company_event_teams") > conn.first_insert_index(
        "company_events"
    )


async def test_counts_match_the_data_set(loaded):
    conn, demo, counts = loaded
    assert counts["projects"] == len(demo.projects)
    assert counts["phases"] == len(demo.phases)
    assert counts["subphases"] == len(demo.subphases)
    assert counts["bank_holidays"] == len(demo.bank_holidays)
    assert counts["teams"] == len(demo.teams)
    assert len(conn.inserts("teams")) == len(demo.teams)
    assert len(conn.inserts("team_members")) == sum(len(t["members"]) for t in demo.teams)
    assert len(conn.inserts("project_teams")) == sum(len(p["teams"]) for p in demo.projects)
    assert len(conn.inserts("tag_teams")) == sum(len(t["teams"]) for t in demo.tags)
    assert counts["project_fields"] == len(demo.project_fields)
    assert len(conn.inserts("project_fields")) == len(demo.project_fields)
    assert len(conn.inserts("project_field_options")) == sum(
        len(f["options"]) for f in demo.project_fields
    )
    assert len(conn.inserts("project_field_selections")) == sum(
        len(items) for p in demo.projects for items in p["fields"].values()
    )
    assert len(conn.inserts("equipment_teams")) == sum(len(e["teams"]) for e in demo.equipment)
    assert len(conn.inserts("company_event_teams")) == sum(
        len(ev["teams"]) for ev in demo.company_events
    )
    assert len(conn.inserts("projects")) == len(demo.projects)
    assert len(conn.inserts("project_subphases")) == len(demo.subphases)
    assert len(conn.inserts("vacations")) == len(demo.vacations)
    assert len(conn.inserts("notifications")) == len(demo.notifications)


async def test_names_resolve_to_the_handed_out_ids(loaded):
    conn, demo, _ = loaded
    site_ids = {args[0]: conn.ids[("sites", (args[0],))] for _, args in conn.inserts("sites")}
    # A project row carries its site's id, not its name.
    for sql, args in conn.inserts("projects"):
        assert args[1] in site_ids.values(), (sql, args)
    # The nested subphase points at its parent subphase, the others at their phase.
    sub_inserts = conn.inserts("project_subphases")
    parent_types = {args[3]: args[1] for _, args in sub_inserts}  # name → parent_type
    assert parent_types["Sampling"] == "subphase"
    assert parent_types["Pilot batch 1"] == "phase"
    # The shared instrument keeps the lowest linked site as its legacy site_id.
    shared = next(e for e in demo.equipment if len(e["sites"]) == 2)
    row = next(args for _, args in conn.inserts("equipment") if args[0] == shared["name"])
    assert row[2] == min(site_ids[s] for s in shared["sites"])
    # Inactive and part-time people carry their flags.
    users = {args[0]: args for _, args in conn.inserts("users")}
    assert users["edward.evans@demo.local"][7] == 0
    assert users["charlie.clark@demo.local"][6] == 60
    assert users["admin@demo.local"][8] == 1


async def test_team_links_resolve_to_the_handed_out_ids(loaded):
    conn, _, _ = loaded

    def site(name):
        return conn.ids[("sites", (name,))]

    def team(site_name, name):
        return conn.ids[("teams", (site(site_name), name))]

    def project(name, site_name):
        return conn.ids[("projects", (name, site(site_name)))]

    def links(table):
        return {args for _, args in conn.inserts(table)}

    lab, qa = team("Winterthur", "Analytical Lab"), team("Frankfurt", "QA & Compliance")
    teams = {args[1]: args for _, args in conn.inserts("teams")}  # name → row
    assert teams["Analytical Lab"][0] == site("Winterthur")
    assert teams["Formulation"][0] == site("Frankfurt")
    alice = conn.ids[("users", ("alice.anderson@demo.local",))]
    assert (lab, alice) in links("team_members")
    assert (project("Catalyst Optimization", "Winterthur"), lab) in links("project_teams")
    assert (project("Quality System Upgrade", "Frankfurt"), qa) in links("project_teams")
    assert (conn.ids[("tags", ("GMP",))], qa) in links("tag_teams")
    spectrometer = conn.ids[("equipment", ("Mass Spectrometer",))]
    assert links("equipment_teams") >= {(spectrometer, lab)}
    assert all("ON CONFLICT DO NOTHING" in s for s, _ in conn.inserts("team_members"))


async def test_project_field_rows_resolve_to_the_handed_out_ids(loaded):
    conn, _, _ = loaded

    def field(name):
        return conn.ids[("project_fields", (name,))]

    def item(field_name, name):
        return conn.ids[("project_field_options", (field(field_name), name))]

    fields = {args[0]: args for _, args in conn.inserts("project_fields")}
    assert fields["Project type"][:3] == ("Project type", "select", 0)
    assert fields["Area"][:3] == ("Area", "multiselect", 1)
    options = {args[1]: args for _, args in conn.inserts("project_field_options")}
    # field_id, name, color, all_sites, sort_order
    assert options["Customer"][:5] == (field("Project type"), "Customer", "#0ea5e9", True, 1)
    assert options["QA"][0] == field("Area")
    site = conn.ids[("sites", ("Winterthur",))]
    bioprocess = conn.ids[("projects", ("Bioprocess Scale-Up", site))]
    analytical = conn.ids[("projects", ("Analytical Method Transfer", site))]
    selections = {args for _, args in conn.inserts("project_field_selections")}
    assert (bioprocess, item("Project type", "Customer")) in selections
    assert (bioprocess, item("Area", "Process")) in selections
    assert {(analytical, item("Area", "Analytics")), (analytical, item("Area", "QA"))} <= selections
    assert all("ON CONFLICT DO NOTHING" in s for s, _ in conn.inserts("project_field_selections"))
    # Tags no longer carry a group.
    assert all("group_id" not in s for s, _ in conn.inserts("tags"))


async def test_restricted_field_items_get_their_site_and_team_links():
    conn = RecordingConn()
    demo = build_demo(date(2026, 10, 17))
    qa = next(o for o in demo.project_fields[1]["options"] if o["name"] == "QA")
    qa["sites"] = ["Frankfurt"]
    qa["teams"] = [("Frankfurt", "QA & Compliance")]
    for p in demo.projects:  # keep the data consistent: QA only on the Frankfurt project
        if p["site"] != "Frankfurt" and "QA" in p["fields"].get("Area", []):
            p["fields"]["Area"].remove("QA")

    await demo_seed.insert_demo_data(conn, demo)

    frankfurt = conn.ids[("sites", ("Frankfurt",))]
    team = conn.ids[("teams", (frankfurt, "QA & Compliance"))]
    option = conn.ids[("project_field_options", (conn.ids[("project_fields", ("Area",))], "QA"))]
    assert [args for _, args in conn.inserts("project_field_option_sites")] == [(option, frankfurt)]
    assert [args for _, args in conn.inserts("project_field_option_teams")] == [(option, team)]
    assert next(a for _, a in conn.inserts("project_field_options") if a[1] == "QA")[3] is False
    for table in ("project_field_option_sites", "project_field_option_teams"):
        assert all("ON CONFLICT DO NOTHING" in s for s, _ in conn.inserts(table))
        assert conn.first_insert_index(table) > conn.first_insert_index("project_field_options")


async def test_dependency_json_uses_resolved_ids_and_names_the_kind(loaded):
    conn, demo, _ = loaded
    updates = [
        (s, a)
        for s, a in conn.executed
        if s.lstrip().startswith("UPDATE") and "SET dependencies" in s
    ]
    assert len(updates) == len({d["successor"] for d in demo.dependencies})
    sampling_id = conn.ids[
        (
            "project_subphases",
            (
                conn.ids[
                    ("projects", ("Bioprocess Scale-Up", conn.ids[("sites", ("Winterthur",))]))
                ],
                "Sampling",
            ),
        )
    ]
    ss_links = [
        json.loads(a[0])
        for s, a in updates
        if "project_phases" in s and any(link["entity"] == "subphase" for link in json.loads(a[0]))
    ]
    assert ss_links == [[{"id": sampling_id, "type": "SS", "lag": 0, "entity": "subphase"}]]
    for _, args in updates:
        for link in json.loads(args[0]):
            assert set(link) == {"id", "type", "lag", "entity"}
            assert isinstance(link["id"], int)


async def test_comments_render_mentions_and_derive_mentioned_ids(loaded):
    conn, _, _ = loaded
    rows = conn.inserts("card_comments")
    assert rows
    bodies = [args[4] for _, args in rows]
    assert not any("{mention:" in b for b in bodies)
    alice = conn.ids[("users", ("alice.anderson@demo.local",))]
    assert any(f"@[Alice Anderson]({alice})" in b for b in bodies)
    for _, args in rows:
        assert json.loads(args[5]) == parse_mention_ids(args[4])


async def test_notifications_set_read_at_from_the_flag(loaded):
    conn, demo, _ = loaded
    rows = conn.inserts("notifications")
    read_flags = sorted(bool(args[8]) for _, args in rows)
    assert read_flags == sorted(bool(n["read"]) for n in demo.notifications)
    assert all("CASE WHEN $9::boolean THEN CURRENT_TIMESTAMP" in s for s, _ in rows)


async def test_no_statement_uses_a_placeholder_twice(loaded):
    """asyncpg prepares every statement, and PostgreSQL deduces one type per
    parameter: a `$n` that appears both in an INSERT ... SELECT list and in a
    `WHERE col = $n` comparison comes out as text in one place and character
    varying in the other, and the statement is refused. That stopped the
    seed right before the notifications on a real database. The recording
    fake cannot see types, so it pins the shape: each placeholder once,
    and as many placeholders as arguments."""
    conn, _, _ = loaded
    for sql, args in conn.executed:
        used = re.findall(r"\$(\d+)", sql)
        assert len(used) == len(set(used)), sql
        assert len(used) == len(args), sql


async def test_admin_password_hash_lands_on_the_admin_only():
    """Provisioning passes the hash of the password it shows the portal admin;
    the sample people then get a random, discarded password — nobody can sign
    in as them with demo1234 (or anything else) on a portal-created tenant."""
    conn = RecordingConn()
    demo = build_demo(date(2026, 10, 17), admin_email="owner@acme.example")
    await demo_seed.insert_demo_data(conn, demo, admin_password_hash="$2b$04$owner-hash")
    users = {args[0]: args for _, args in conn.inserts("users")}
    assert users["owner@acme.example"][1] == "$2b$04$owner-hash"
    assert users["owner@acme.example"][8] == 1  # still the system admin
    assert "admin@demo.local" not in users
    others = [args[1] for email, args in users.items() if email != "owner@acme.example"]
    assert others and len(set(others)) == 1
    assert others[0].startswith("$2b$")  # a real bcrypt hash, never plaintext
    assert not verify_user_password(DEMO_PASSWORD, others[0])
    assert not verify_user_password("", others[0])


async def test_without_a_hash_everyone_gets_the_demo_password(loaded):
    conn, _, _ = loaded
    hashes = {args[1] for _, args in conn.inserts("users")}
    assert len(hashes) == 1
    assert verify_user_password(DEMO_PASSWORD, hashes.pop())


def test_render_mentions():
    body = "{mention:a@x} and {mention:b@x}: hello"
    out = demo_seed.render_mentions(body, {"a@x": 1, "b@x": 22}, {"a@x": "Ann A", "b@x": "Bo B"})
    assert out == "@[Ann A](1) and @[Bo B](22): hello"
    assert parse_mention_ids(out) == [1, 22]


class _SchemaConn(RecordingConn):
    def __init__(self, has_users: bool, user_count: int):
        super().__init__()
        self.has_users = has_users
        self.user_count = user_count

    async def fetchval(self, sql, *args):
        if "information_schema" in sql:
            return self.has_users
        if sql.startswith("SELECT COUNT(*) FROM users"):
            return self.user_count
        return await super().fetchval(sql, *args)


def _settings():
    return SimpleNamespace(db_host="db", db_port=5432)


async def test_apply_schema_skips_an_already_seeded_database(capsys):
    conn = _SchemaConn(has_users=True, user_count=9)
    with (
        patch.object(seed_demo.asyncpg, "connect", return_value=conn),
        patch.object(seed_demo, "insert_demo_data", return_value={}) as insert,
    ):
        await seed_demo.apply_schema_and_seed(_settings())
    assert "already seeded" in capsys.readouterr().out
    assert conn.executed == [] and not insert.called and conn.closed


async def test_apply_schema_seeds_an_empty_database(capsys):
    conn = _SchemaConn(has_users=True, user_count=0)
    with (
        patch.object(seed_demo.asyncpg, "connect", return_value=conn),
        patch(
            "app.services.tenant_provisioner.get_tenant_schema_sql",
            return_value="CREATE TABLE t();",
        ),
        patch.object(seed_demo, "insert_demo_data", return_value={"sites": 2}) as insert,
    ):
        await seed_demo.apply_schema_and_seed(_settings())
    assert conn.executed[0][0] == "CREATE TABLE t();"
    insert.assert_awaited_once()
    assert insert.await_args.args[0] is conn
    assert insert.await_args.args[1].admin_email == "admin@demo.local"
    assert "sites: 2" in capsys.readouterr().out
    assert conn.closed


# ---------------------------------------------------------------------------
# Roles and approvals
# ---------------------------------------------------------------------------


def _user(conn, email):
    return conn.ids[("users", (email,))]


async def test_team_lead_role_and_its_permissions(loaded):
    conn, demo, _ = loaded
    (lead,) = demo.roles
    lead_id = conn.ids[("roles", ("team_lead",))]
    (role_row,) = (args for _, args in conn.inserts("roles"))
    assert role_row[:4] == ("team_lead", "Team Lead", lead["description"], False)
    rows = [args for sql, args in conn.inserts("role_permissions") if args[0] == lead_id]
    assert {(key, mode) for _, key, mode in rows} == set(lead["permissions"].items())
    users = {args[0]: args for _, args in conn.inserts("users")}
    assert users["fiona.fischer@demo.local"][5] == "team_lead"


async def test_user_role_switches_to_approval_mode(loaded):
    conn, demo, _ = loaded
    user_role = conn.ids[("roles", ("user",))]
    # The schema seeded the role's allow rows; the first seed switches them.
    rows = [a for _, a in conn.updates("role_permissions")]
    assert {(permission, mode) for mode, role, permission in rows} == set(
        demo.role_modes["user"].items()
    )
    assert {role for _, role, _ in rows} == {user_role}
    assert not [a for _, a in conn.inserts("role_permissions") if a[0] == user_role]


async def test_policy_names_the_team_lead(loaded):
    conn, _, _ = loaded
    ((sql, policy),) = conn.inserts("approval_policies")
    assert policy == ("assignments.self_create", True) and "DO NOTHING" in sql
    ((_, update),) = conn.updates("approval_policies")
    assert update == (True, "assignments.self_create")
    (link,) = (args for _, args in conn.inserts("approval_policy_roles"))
    assert link == ("assignments.self_create", conn.ids[("roles", ("team_lead",))])


async def test_pending_row_and_request_point_at_each_other(loaded):
    conn, demo, _ = loaded
    diana = _user(conn, "diana.davis@demo.local")
    (request_sql, request_args) = conn.inserts("approval_requests")[0]
    phase_id = request_args[4]
    request_id = conn.ids[
        ("approval_requests", (diana, "assignments.self_create", "phase", phase_id))
    ]
    assert request_args[:4] == (diana, "assignments.self_create", request_args[2], "phase")
    assert json.loads(request_args[5]) == {"allocation": 50}
    assert request_args[7] == "pending"

    pending = [(s, a) for s, a in conn.inserts("phase_staff_assignments") if "'pending'" in s]
    ((row_sql, row_args),) = pending
    assert row_args[1:5] == (phase_id, diana, 50, request_id)
    # Inserted only while the request is pending, never as a duplicate booking.
    assert "AND status = 'pending'" in row_sql and "NOT EXISTS" in row_sql
    (link_sql, link_args) = next(
        (s, a) for s, a in conn.executed if s.lstrip().startswith("UPDATE approval_requests")
    )
    assert link_args == (phase_id, diana, request_id, request_id)
    # The request goes in after the regular bookings, its row right after it.
    executed = [s for s, _ in conn.executed]
    assert executed.index(request_sql) < executed.index(row_sql) < executed.index(link_sql)
    assert conn.first_insert_index("approval_requests") > conn.first_insert_index(
        "subphase_staff_assignments"
    )


async def test_approval_notification_names_the_request(loaded):
    conn, _, _ = loaded
    rows = [a for _, a in conn.inserts("notifications") if a[1] == "approval_requested"]
    ((user_id, _, actor, entity_type, entity_id, *_rest),) = rows
    assert user_id == _user(conn, "bob.brown@demo.local")
    assert actor == _user(conn, "diana.davis@demo.local")
    assert entity_type == "approval_request"
    assert entity_id == next(v for k, v in conn.ids.items() if k[0] == "approval_requests")


async def test_no_todos_are_seeded(loaded):
    conn, _, counts = loaded
    assert conn.inserts("todos") == []
    assert "todos" not in counts


async def test_a_missing_system_role_stops_the_seed():
    class NoUserRole(RecordingConn):
        async def fetchval(self, sql, *args):
            if sql.startswith("SELECT id FROM roles WHERE key = $1"):
                return None
            return await super().fetchval(sql, *args)

    with pytest.raises(RuntimeError, match="system role 'user' missing"):
        await demo_seed.insert_demo_data(NoUserRole(), build_demo(date(2026, 10, 17)))


async def test_a_rerun_leaves_role_and_policy_settings_alone():
    """Re-provisioning with demo data (the portal route has no already-
    provisioned guard) finds the team_lead role already there: an admin's
    edits since -- the user role back to allow, pm_approves off, a role
    removed from a policy, team_lead's matrix -- are never reverted."""

    class Seeded(RecordingConn):
        existing = frozenset({"roles"})

    conn = Seeded()
    await demo_seed.insert_demo_data(conn, build_demo(date(2026, 10, 17)))

    assert conn.inserts("roles")  # still guarded, inserts nothing
    assert not conn.inserts("role_permissions")
    assert not conn.updates("role_permissions")
    assert not conn.updates("approval_policies")
    assert not conn.inserts("approval_policy_roles")
    assert conn.inserts("users")  # the rest of the seed still completes
