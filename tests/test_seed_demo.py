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

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        return "OK"

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
    updates = [s for s, _ in conn.executed if s.lstrip().startswith("UPDATE")]
    assert updates and all("dependencies IS NULL OR dependencies IN" in s for s in updates)


async def test_rows_come_in_foreign_key_order(loaded):
    conn, _, _ = loaded
    order = [
        "sites",
        "skills",
        "users",
        "teams",
        "equipment",
        "tag_groups",
        "tags",
        "projects",
        "project_phases",
        "project_subphases",
        "phase_staff_assignments",
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


async def test_dependency_json_uses_resolved_ids_and_names_the_kind(loaded):
    conn, demo, _ = loaded
    updates = [(s, a) for s, a in conn.executed if s.lstrip().startswith("UPDATE")]
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
