"""
The audit-log read API (app/routers/audit_log.py).

Route wiring (registration, the ``system.audit_log`` gate, the envelope, the
recorded and committed export) goes through ``authed_client`` with the mocked
session; what the filters *mean* is checked against SQLite with the router's
own query builders (``build_filters`` / ``load_page`` / ``filtered_query``).
"""

import csv
import io
import threading
from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.audit_log import AuditLog
from app.models.project import Project
from app.models.rbac import Role
from app.models.user import User
from app.routers import audit_log as audit_routes
from app.routers.audit_log import (
    CSV_COLUMNS,
    build_csv,
    build_filters,
    csv_cell,
    filtered_query,
    load_page,
)
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

ROUTES = ["/api/audit-log", "/api/audit-log/actions", "/api/audit-log/export"]


@pytest.fixture(autouse=True)
def purge():
    """The lazy purge, stubbed for the route tests (its SQL is tested on SQLite)."""
    with patch("app.services.audit_log.purge_old", AsyncMock(return_value=0)) as mock:
        yield mock


def _row(**fields) -> AuditLog:
    base = {
        "category": "auth",
        "action": "auth.login.succeeded",
        "outcome": "success",
        "origin": "web",
        "created_at": datetime(2026, 11, 3, 9, 0),
    }
    return AuditLog(**{**base, **fields})


def seed() -> list[AuditLog]:
    """Fresh rows for each use (an instance belongs to one session)."""
    return [
        _row(id=1, created_at=datetime(2026, 11, 1, 0, 0), actor_email="ada@x", actor_name="Ada L"),
        _row(
            id=2,
            created_at=datetime(2026, 11, 1, 23, 59),
            action="auth.login.failed",
            outcome="failure",
            subject_email="Ghost@Example.com",
            ip="203.0.113.9",
        ),
        _row(
            id=3,
            created_at=datetime(2026, 11, 2, 12, 0),
            action="auth.login.locked",
            outcome="failure",
            subject_email="ghost@example.com",
        ),
        _row(
            id=4,
            created_at=datetime(2026, 11, 3, 8, 0),
            category="admin",
            action="admin.user.updated",
            actor_user_id=7,
            actor_email="boss@x",
            actor_name="Grace Hopper",
            target_type="user",
            target_id="9",
            target_label="100% Bob",
            details='{"changes":{"role":{"new":"superuser","old":"user"}}}',
        ),
        _row(
            id=5,
            created_at=datetime(2026, 11, 3, 8, 0),
            category="change",
            action="project.created",
            actor_user_id=7,
            project_id=12,
            target_type="project",
            target_id="12",
            target_label="=HYPERLINK(evil)",
        ),
        _row(
            id=6,
            created_at=datetime(2026, 11, 4, 10, 0),
            category="change",
            action="project.updated",
            actor_user_id=8,
            project_id=99,  # deleted project: no name
        ),
        _row(
            id=7,
            created_at=datetime(2026, 11, 5, 7, 0),
            category="access",
            action="access.export.site",
            actor_user_id=7,
            origin="web",
        ),
        _row(
            id=8,
            created_at=datetime(2026, 11, 5, 7, 30),
            category="change",
            action="phase.deleted",
            origin="system",
            project_id=12,
        ),
    ]


@pytest.fixture
def db():
    with sqlite_session() as session:
        session.add(Role(id=1, key="user", name="User"))
        session.add_all(
            [
                User(id=i, email=f"u{i}@x", password="x", first_name="U", last_name=str(i))
                for i in (7, 8)
            ]
        )
        session.flush()
        session.add(
            Project(id=12, name="Apollo", start_date=date(2026, 1, 1), end_date=date(2026, 12, 31))
        )
        session.add_all(seed())
        session.commit()
        yield AsyncSessionFacade(session)


async def _ids(db, **filters):
    page = await load_page(db, build_filters(**filters), 1, 200)
    return [item.id for item in page.items]


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def test_the_router_is_registered(test_settings):
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app

        # Every route the app serves, as its OpenAPI schema lists them.
        paths = set(create_app().openapi()["paths"])
    for path in ROUTES:
        assert path in paths


@pytest.mark.parametrize("path", ROUTES)
async def test_every_route_needs_the_audit_log_key(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))  # not granted by default

    resp = await client.get(path)

    assert resp.status_code == 403
    assert "system.audit_log" in resp.json()["detail"]
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize("path", ROUTES)
async def test_a_custom_role_holding_the_key_reads(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(5, "auditor", {"system.audit_log"}))
    count = MagicMock()
    count.scalar_one.return_value = 0
    empty = MagicMock()
    empty.all.return_value = []
    empty.scalars.return_value.all.return_value = []
    mock_db_session.execute = AsyncMock(
        side_effect=[count, empty] if path == ROUTES[0] else [empty]
    )

    resp = await client.get(path)

    assert resp.status_code == 200


async def test_the_list_envelope(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    count = MagicMock()
    count.scalar_one.return_value = 51
    page = MagicMock()
    rows = seed()
    page.all.return_value = [(rows[3], None), (rows[4], "Apollo")]
    mock_db_session.execute = AsyncMock(side_effect=[count, page])

    resp = await client.get("/api/audit-log", params={"page": 2, "page_size": 2})

    assert resp.status_code == 200
    body = resp.json()
    assert (body["total"], body["page"], body["page_size"]) == (51, 2, 2)
    first, second = body["items"]
    assert first["id"] == 4 and first["created_at"] == "2026-11-03T08:00:00.000Z"
    assert first["details"] == {"changes": {"role": {"new": "superuser", "old": "user"}}}
    assert first["project_name"] is None
    assert (second["project_id"], second["project_name"], second["details"]) == (12, "Apollo", None)
    assert set(first) == {*CSV_COLUMNS}


@pytest.mark.parametrize(
    "params",
    [
        {"category": "security"},
        {"outcome": "partial"},
        {"page": 0},
        {"page_size": 201},
        {"since": "yesterday"},
        {"actor_user_id": "x"},
    ],
)
async def test_invalid_parameters_are_422(authed_client, params):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    resp = await client.get("/api/audit-log", params=params)

    assert resp.status_code == 422


async def test_actions_are_listed(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = MagicMock()
    result.scalars.return_value.all.return_value = ["admin.user.updated", "auth.logout"]
    mock_db_session.execute = AsyncMock(return_value=result)

    resp = await client.get("/api/audit-log/actions")

    assert resp.json() == {"actions": ["admin.user.updated", "auth.logout"]}


async def test_the_export_is_recorded_and_committed_before_the_body(
    authed_client, mock_db_session, audit_calls
):
    client, set_user = authed_client
    admin = FakeUser(1, "admin")
    set_user(admin)
    result = MagicMock()
    rows = seed()
    result.all.return_value = [(rows[4], "Apollo"), (rows[0], None)]
    mock_db_session.execute = AsyncMock(return_value=result)
    order: list[str] = []
    mock_db_session.commit = AsyncMock(
        side_effect=lambda: order.append(f"commit after {len(audit_calls)} row(s)")
    )
    real_build = audit_routes.build_csv
    threads: list[int] = []

    def build(rows):
        order.append(f"build after {len(audit_calls)} row(s)")
        threads.append(threading.get_ident())
        return real_build(rows)

    with patch.object(audit_routes, "build_csv", side_effect=build):
        resp = await client.get("/api/audit-log/export", params={"category": "change"})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/csv; charset=utf-8"
    assert resp.headers["content-disposition"] == 'attachment; filename="audit-log.csv"'
    (row,) = [kwargs for _, kwargs in audit_calls]
    assert row["action"] == "access.audit_log.exported"
    assert (row["category"], row["actor"], row["context"]) == ("access", admin, {"rows": 2})
    assert row["target"] == ("audit_log", None, "Audit log")
    # The purge's commit, then the export row's, then the body.
    assert order == ["commit after 0 row(s)", "commit after 1 row(s)", "build after 1 row(s)"]
    assert threads != [threading.get_ident()]  # built off the event loop
    lines = list(csv.reader(io.StringIO(resp.text)))
    assert tuple(lines[0]) == CSV_COLUMNS
    assert len(lines) == 3


async def test_the_export_is_capped(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = MagicMock()
    result.all.return_value = []
    mock_db_session.execute = AsyncMock(return_value=result)

    with patch.object(audit_routes, "AUDIT_EXPORT_MAX_ROWS", 3):
        await client.get("/api/audit-log/export")

    (statement,) = mock_db_session.execute.await_args.args
    assert statement._limit_clause.value == 3


# ---------------------------------------------------------------------------
# What the filters mean (SQLite)
# ---------------------------------------------------------------------------


async def test_no_filter_lists_everything_newest_first(db):
    # 4 and 5 share their timestamp: the higher id first.
    assert await _ids(db) == [8, 7, 6, 5, 4, 3, 2, 1]


async def test_category_outcome_actor_ip_and_project(db):
    assert await _ids(db, category="change") == [8, 6, 5]
    assert await _ids(db, outcome="failure") == [3, 2]
    assert await _ids(db, actor_user_id=7) == [7, 5, 4]
    assert await _ids(db, ip="203.0.113.9") == [2]
    assert await _ids(db, ip="  203.0.113.9 ") == [2]
    assert await _ids(db, project_id=12) == [8, 5]


async def test_action_is_exact_unless_it_ends_with_a_dot(db):
    assert await _ids(db, action="auth.login.failed") == [2]
    assert await _ids(db, action="auth.login.") == [3, 2, 1]
    assert await _ids(db, action="auth.login") == []
    assert await _ids(db, action="project.") == [6, 5]


async def test_q_searches_names_emails_and_labels(db):
    assert await _ids(db, q="GHOST@example") == [3, 2]  # subject, any case
    assert await _ids(db, q="ada") == [1]  # actor email and name
    assert await _ids(db, q="hopper") == [4]  # actor name
    assert await _ids(db, q="hyperlink") == [5]  # target label
    assert await _ids(db, q="100%") == [4]  # % is literal
    assert await _ids(db, q="%") == [4]
    assert await _ids(db, q="_") == []
    assert await _ids(db, q="   ") == [8, 7, 6, 5, 4, 3, 2, 1]


async def test_since_and_until_are_inclusive_days(db):
    assert await _ids(db, since=date(2026, 11, 3)) == [8, 7, 6, 5, 4]
    assert await _ids(db, until=date(2026, 11, 1)) == [2, 1]  # 00:00 and 23:59
    assert await _ids(db, since=date(2026, 11, 2), until=date(2026, 11, 4)) == [6, 5, 4, 3]


async def test_since_includes_a_row_at_exactly_midnight_of_that_day(db):
    # Row 1 is at 2026-11-01 00:00:00 sharp, row 2 at 23:59 the same day.
    assert await _ids(db, since=date(2026, 11, 1)) == [8, 7, 6, 5, 4, 3, 2, 1]
    assert await _ids(db, since=date(2026, 11, 2)) == [8, 7, 6, 5, 4, 3]


async def test_paging_and_total(db):
    first = await load_page(db, build_filters(), 1, 3)
    third = await load_page(db, build_filters(), 3, 3)
    beyond = await load_page(db, build_filters(), 4, 3)

    assert [i.id for i in first.items] == [8, 7, 6] and first.total == 8
    assert [i.id for i in third.items] == [2, 1] and third.total == 8
    assert beyond.items == [] and beyond.total == 8
    filtered = await load_page(db, build_filters(category="auth"), 1, 2)
    assert (len(filtered.items), filtered.total) == (2, 3)


async def test_project_names_are_joined(db):
    page = await load_page(db, build_filters(project_id=12), 1, 10)
    assert {(i.id, i.project_name) for i in page.items} == {(8, "Apollo"), (5, "Apollo")}
    (orphan,) = (await load_page(db, build_filters(actor_user_id=8), 1, 10)).items
    assert (orphan.project_id, orphan.project_name) == (99, None)


async def test_the_csv_of_real_rows(db):
    rows = (await db.execute(filtered_query(build_filters(actor_user_id=7)))).all()

    lines = list(csv.reader(io.StringIO(build_csv(rows))))

    assert tuple(lines[0]) == CSV_COLUMNS
    by_id = {line[0]: dict(zip(CSV_COLUMNS, line, strict=True)) for line in lines[1:]}
    assert list(by_id) == ["7", "5", "4"]
    assert by_id["5"]["target_label"] == "'=HYPERLINK(evil)"
    assert by_id["5"]["project_name"] == "Apollo"
    assert by_id["4"]["details"] == '{"changes":{"role":{"new":"superuser","old":"user"}}}'
    # The API's form: UTC with milliseconds and a Z (a reader can tell the zone).
    assert by_id["4"]["created_at"] == "2026-11-03T08:00:00.000Z"
    assert by_id["7"]["details"] == "" and by_id["7"]["project_id"] == ""


@pytest.mark.parametrize(
    ("value", "cell"),
    [
        (None, ""),
        ("plain", "plain"),
        ("=1+1", "'=1+1"),
        ("+1", "'+1"),
        ("-1", "'-1"),
        ("@sum", "'@sum"),
        ("\tx", "'\tx"),
        ("\rx", "'\rx"),
        (12, "12"),
        (datetime(2026, 1, 2, 3, 4, 5), "2026-01-02T03:04:05.000Z"),
    ],
)
def test_csv_cell(value, cell):
    assert csv_cell(value) == cell


# ---------------------------------------------------------------------------
# Retention: the purge before the list and the export
# ---------------------------------------------------------------------------


async def test_the_list_purges_and_commits_before_it_reads(authed_client, mock_db_session, purge):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    order: list[str] = []
    purge.side_effect = lambda *_: order.append("purge") or 0
    mock_db_session.commit = AsyncMock(side_effect=lambda: order.append("commit"))
    count = MagicMock()
    count.scalar_one.return_value = 0
    empty = MagicMock()
    empty.all.return_value = []

    async def execute(*_args, **_kwargs):
        order.append("read")
        return count if order.count("read") == 1 else empty

    mock_db_session.execute = AsyncMock(side_effect=execute)

    await client.get("/api/audit-log")

    assert order == ["purge", "commit", "read", "read"]
    (db, now), _ = purge.call_args
    assert db is mock_db_session and now.tzinfo is None


async def test_the_export_purges_first(authed_client, mock_db_session, purge):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = MagicMock()
    result.all.return_value = []
    mock_db_session.execute = AsyncMock(return_value=result)

    await client.get("/api/audit-log/export")

    purge.assert_awaited_once()


async def test_the_actions_never_purge(authed_client, mock_db_session, purge):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    mock_db_session.execute = AsyncMock(return_value=result)

    await client.get("/api/audit-log/actions")

    purge.assert_not_awaited()
