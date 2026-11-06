"""
Audit-log retention: the ``audit_log_retention_days`` instance setting
(``_int_range(0, 3650)``, default ``"365"``) and the lazy purge
(``audit_log.retention_days`` / ``retention_cutoff`` / ``purge_old``) on SQLite.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select, text

from app.models.audit_log import AuditLog
from app.models.settings import Settings as SettingRow
from app.services import audit_log
from app.services.instance_settings import KNOWN_SETTINGS, _int_range, canonicalise, default_for
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session
from tests.support import scalar_result

NOW = datetime(2026, 11, 5, 12, 0)

# Captured before the route tests' autouse stub could replace it.
REAL_PURGE = audit_log.purge_old


def test_the_constants():
    assert audit_log.RETENTION_SETTING_KEY == "audit_log_retention_days"
    assert (audit_log.DEFAULT_RETENTION_DAYS, audit_log.MAX_RETENTION_DAYS) == (365, 3650)
    assert KNOWN_SETTINGS["audit_log_retention_days"].default == "365"
    assert default_for("audit_log_retention_days") == "365"


@pytest.mark.parametrize(
    ("value", "canonical"),
    [("0", "0"), ("3650", "3650"), (365, "365"), (" 030 ", "30"), ("7", "7")],
)
def test_int_range_accepts(value, canonical):
    assert _int_range(0, 3650)(value) == canonical


@pytest.mark.parametrize("value", ["-1", "3651", "abc", "", "1.5", "1e3", True, -1, 3651])
def test_int_range_rejects(value):
    with pytest.raises(ValueError, match="whole number from 0 to 3650"):
        _int_range(0, 3650)(value)


def test_the_setting_canonicalises():
    assert canonicalise("audit_log_retention_days", "0090") == "90"
    with pytest.raises(ValueError):
        canonicalise("audit_log_retention_days", "forever")


async def test_put_canonicalises_and_rejects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    resp = await client.put("/api/settings/audit_log_retention_days", json={"value": " 090"})
    assert resp.status_code == 200
    assert resp.json()["value"] == "90"
    (row,) = mock_db_session.add.call_args.args
    assert (row.key, row.value) == ("audit_log_retention_days", "90")

    for bad in ("-1", "3651", "abc"):
        resp = await client.put("/api/settings/audit_log_retention_days", json={"value": bad})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Invalid value for audit_log_retention_days"


async def test_put_needs_settings_general(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))

    resp = await client.put("/api/settings/audit_log_retention_days", json={"value": "30"})

    assert resp.status_code == 403


async def test_get_serves_the_default(app_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    resp = await app_client.get("/api/settings/audit_log_retention_days")

    assert resp.json() == {"key": "audit_log_retention_days", "value": "365"}


# ---------------------------------------------------------------------------
# The purge on SQLite
# ---------------------------------------------------------------------------


@pytest.fixture
def db():
    with sqlite_session() as session:
        session.add_all(
            [
                AuditLog(
                    id=1,
                    category="auth",
                    action="auth.logout",
                    created_at=NOW - timedelta(days=400),
                ),
                # Exactly on the cutoff: past retention (<=).
                AuditLog(
                    id=2,
                    category="auth",
                    action="auth.logout",
                    created_at=NOW - timedelta(days=365),
                ),
                AuditLog(
                    id=3,
                    category="auth",
                    action="auth.logout",
                    created_at=NOW - timedelta(days=364, hours=23),
                ),
                AuditLog(id=4, category="auth", action="auth.logout", created_at=NOW),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


async def _left(db) -> list[int]:
    return list((await db.execute(select(AuditLog.id).order_by(AuditLog.id))).scalars().all())


async def _set(db, value: str) -> None:
    db.add(SettingRow(key="audit_log_retention_days", value=value))
    await db.commit()


async def test_the_default_keeps_a_year(db):
    assert await audit_log.retention_days(db) == 365

    assert await REAL_PURGE(db, NOW) == 2
    await db.commit()

    assert await _left(db) == [3, 4]


async def test_a_configured_retention(db):
    await _set(db, "30")

    assert await audit_log.retention_days(db) == 30
    assert await REAL_PURGE(db, NOW) == 3
    assert await _left(db) == [4]


async def test_zero_keeps_everything(db):
    await _set(db, "0")

    assert await REAL_PURGE(db, NOW) == 0
    assert await _left(db) == [1, 2, 3, 4]


@pytest.mark.parametrize("stored", ["", "abc", "-5", "99999"])
async def test_a_malformed_row_reads_as_the_default(db, stored):
    await _set(db, stored)

    assert await audit_log.retention_days(db) == 365


def test_retention_cutoff():
    assert audit_log.retention_cutoff(0, NOW) is None
    assert audit_log.retention_cutoff(10, NOW) == NOW - timedelta(days=10)


async def test_a_purged_row_is_not_listed(db):
    """The list reads after the purge: a stale row never comes back."""
    from app.routers.audit_log import build_filters, load_page

    await REAL_PURGE(db, NOW)
    await db.commit()
    page = await load_page(db, build_filters(), 1, 50)

    assert [item.id for item in page.items] == [4, 3]
    assert page.total == 2
    assert (await db.execute(text("SELECT count(*) FROM audit_log"))).scalar() == 2
