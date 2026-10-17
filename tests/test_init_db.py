"""
AUTO_INIT_DB fresh-install script (app/scripts/init_db.py).

asyncpg is replaced by a recording fake, so these tests pin which SQL the
script issues against an empty server vs. an already-initialized one, how the
seeded admin password is chosen (INIT_ADMIN_PASSWORD vs generated, legacy
"admin" passwords reset) and how ``main()`` dispatches per mode.
"""

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import bcrypt
import pytest

from app.scripts import init_db

_real_gensalt = bcrypt.gensalt


@pytest.fixture(autouse=True)
def fast_bcrypt(monkeypatch):
    # The script hashes with rounds=12; keep the format, drop the cost.
    monkeypatch.setattr(bcrypt, "gensalt", lambda rounds=12: _real_gensalt(rounds=4))


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("INIT_ADMIN_EMAIL", raising=False)
    monkeypatch.delenv("INIT_ADMIN_PASSWORD", raising=False)


def settings(**overrides):
    base = dict(
        multi_tenant=False,
        db_host="db",
        db_port=5432,
        db_name="milestone_dev",
        db_user="app_user",
        db_password="app_pw",
        pg_admin_user=None,
        pg_admin_password=None,
        master_db_host=None,
        master_db_port=5432,
        master_db_user=None,
        master_db_password=None,
        master_db_name="milestone_master",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class FakePg:
    """Recording stand-in for an asyncpg connection."""

    def __init__(self, server: "FakeServer", database: str):
        self.server = server
        self.database = database
        self.executed: list[tuple[str, tuple]] = []
        self.closed = False

    async def fetchval(self, sql, *args):
        if "pg_database" in sql:
            return 1 if args[0] in self.server.databases else None
        if "pg_roles" in sql:
            return 1 if args[0] in self.server.roles else None
        if "must_change_password" in sql:
            return self.server.has_must_change_column
        raise AssertionError(f"unexpected fetchval: {sql}")

    async def fetchrow(self, sql, *args):
        return self.server.admin_row

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        if self.server.fail_on and self.server.fail_on in sql:
            raise RuntimeError(f"failed: {self.server.fail_on}")
        if sql.lstrip().startswith("INSERT INTO admin_users"):
            return "INSERT 0 0" if self.server.admin_row else "INSERT 0 1"
        return "OK"

    async def close(self):
        self.closed = True

    def sql(self) -> list[str]:
        return [s for s, _ in self.executed]

    def ran(self, fragment: str) -> bool:
        return any(fragment in s for s in self.sql())


class FakeServer:
    def __init__(self, databases=(), roles=(), admin_row=None, has_must_change_column=True):
        self.databases = set(databases)
        self.roles = set(roles)
        self.admin_row = admin_row
        self.has_must_change_column = has_must_change_column
        self.fail_on: str | None = None
        self.connections: list[tuple[dict, FakePg]] = []

    async def connect(self, **kwargs):
        conn = FakePg(self, kwargs["database"])
        self.connections.append((kwargs, conn))
        return conn

    def conn(self, database: str) -> FakePg:
        return next(c for kw, c in self.connections if kw["database"] == database)

    def patch(self):
        return patch.object(init_db, "asyncpg", SimpleNamespace(connect=self.connect))


# ---------------------------------------------------------------------------
# generate_password / get_admin_conn
# ---------------------------------------------------------------------------


def test_generate_password_length_and_alphabet():
    pw = init_db.generate_password()
    assert len(pw) == 16
    assert set(pw) <= set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%")
    assert len(init_db.generate_password(40)) == 40
    assert init_db.generate_password() != init_db.generate_password()


@pytest.mark.asyncio
async def test_admin_conn_prefers_pg_admin_credentials():
    server = FakeServer()
    with server.patch():
        await init_db.get_admin_conn(settings(pg_admin_user="pgadmin", pg_admin_password="x"))
        await init_db.get_admin_conn(settings())

    (first, _), (second, _) = server.connections
    assert first == {
        "host": "db",
        "port": 5432,
        "user": "pgadmin",
        "password": "x",
        "database": "postgres",
    }
    assert (second["user"], second["password"]) == ("app_user", "app_pw")


# ---------------------------------------------------------------------------
# ensure_database_exists
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_existing_database_is_left_alone():
    server = FakeServer(databases={"milestone_dev"})
    with server.patch():
        created = await init_db.ensure_database_exists(settings(), "milestone_dev", "u", "p")

    assert created is False
    admin = server.conn("postgres")
    assert admin.executed == []
    assert admin.closed


@pytest.mark.asyncio
async def test_missing_database_and_role_are_created():
    server = FakeServer()
    with server.patch():
        created = await init_db.ensure_database_exists(settings(), "milestone_x", "x_user", "it's")

    assert created is True
    admin = server.conn("postgres")
    assert admin.sql() == [
        "CREATE USER \"x_user\" WITH PASSWORD 'it''s'",  # quote escaped
        'GRANT "x_user" TO CURRENT_USER',
        'CREATE DATABASE "milestone_x" OWNER "x_user"',
        'GRANT ALL PRIVILEGES ON DATABASE "milestone_x" TO "x_user"',
    ]
    assert admin.closed


@pytest.mark.asyncio
async def test_existing_role_is_reused_and_grant_failure_is_tolerated():
    server = FakeServer(roles={"x_user"})
    server.fail_on = "TO CURRENT_USER"  # superuser-less managed Postgres quirk
    with server.patch():
        assert await init_db.ensure_database_exists(settings(), "milestone_x", "x_user", "p")

    admin = server.conn("postgres")
    assert not admin.ran("CREATE USER")
    assert admin.ran('CREATE DATABASE "milestone_x" OWNER "x_user"')


@pytest.mark.asyncio
async def test_admin_connection_is_closed_on_failure():
    server = FakeServer()
    server.fail_on = "CREATE DATABASE"
    with server.patch(), pytest.raises(RuntimeError):
        await init_db.ensure_database_exists(settings(), "milestone_x", "x_user", "p")
    assert server.conn("postgres").closed


# ---------------------------------------------------------------------------
# apply_master_schema
# ---------------------------------------------------------------------------


def master_settings(**overrides):
    return settings(
        multi_tenant=True,
        master_db_host="master",
        master_db_user="m_user",
        master_db_password="m_pw",
        **overrides,
    )


def admin_insert(conn: FakePg) -> tuple:
    (args,) = (a for s, a in conn.executed if "INSERT INTO admin_users" in s)
    return args


@pytest.mark.asyncio
async def test_master_schema_with_configured_password(monkeypatch, capsys):
    monkeypatch.setenv("INIT_ADMIN_EMAIL", "ops@corp.example")
    monkeypatch.setenv("INIT_ADMIN_PASSWORD", "Chosen-Pass-1")
    server = FakeServer()
    with server.patch():
        await init_db.apply_master_schema(master_settings())

    kwargs, master = server.connections[-1]
    assert kwargs == {
        "host": "master",
        "port": 5432,
        "user": "m_user",
        "password": "m_pw",
        "database": "milestone_master",
    }
    for table in (
        "organizations",
        "organization_sso_config",
        "tenants",
        "tenant_credentials",
        "tenant_audit_log",
        "admin_users",
        "admin_sessions",
    ):
        assert master.ran(f"CREATE TABLE IF NOT EXISTS {table} ("), table
    assert master.ran("idx_tenants_organization_id")
    assert not master.ran("ALTER TABLE admin_users")  # column already there

    email, password_hash, must_change = admin_insert(master)
    assert email == "ops@corp.example"
    assert bcrypt.checkpw(b"Chosen-Pass-1", password_hash.encode())
    assert must_change == 0
    assert "DEFAULT ADMIN CREDENTIALS" not in capsys.readouterr().err
    assert master.closed


@pytest.mark.asyncio
async def test_master_schema_generates_and_prints_a_password(capsys):
    server = FakeServer(has_must_change_column=False)
    with (
        server.patch(),
        patch.object(init_db, "generate_password", return_value="Gen-Pass-123"),
    ):
        await init_db.apply_master_schema(master_settings())

    master = server.conn("milestone_master")
    assert master.ran("ALTER TABLE admin_users ADD COLUMN must_change_password")
    email, password_hash, must_change = admin_insert(master)
    assert email == "admin@milestone.local"
    assert bcrypt.checkpw(b"Gen-Pass-123", password_hash.encode())
    assert must_change == 1
    err = capsys.readouterr().err
    assert "DEFAULT ADMIN CREDENTIALS" in err and "Gen-Pass-123" in err


@pytest.mark.asyncio
async def test_master_schema_is_idempotent_for_an_existing_admin(capsys):
    row = {
        "password_hash": bcrypt.hashpw(b"a-real-password", _real_gensalt(4)).decode(),
        "must_change_password": 0,
    }
    server = FakeServer(databases={"milestone_master"}, admin_row=row)
    with server.patch():
        await init_db.apply_master_schema(master_settings())
        await init_db.apply_master_schema(master_settings())

    first, second = (c for kw, c in server.connections if kw["database"] == "milestone_master")
    # Every DDL statement is guarded, so a re-run issues the same SQL.
    assert first.sql() == second.sql()
    assert all("IF NOT EXISTS" in s for s in first.sql() if "CREATE" in s)
    assert not first.ran("UPDATE admin_users")
    assert "DEFAULT ADMIN CREDENTIALS" not in capsys.readouterr().err


def legacy_pbkdf2(password: str) -> str:
    salt = "abcd1234"
    digest = hashlib.pbkdf2_hmac("sha512", password.encode(), salt.encode(), 10000, dklen=64)
    return f"{salt}:{digest.hex()}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stored",
    [
        pytest.param(lambda: bcrypt.hashpw(b"admin", _real_gensalt(4)).decode(), id="bcrypt"),
        pytest.param(lambda: legacy_pbkdf2("admin"), id="legacy-pbkdf2"),
    ],
)
async def test_hardcoded_admin_password_is_reset(stored, capsys):
    row = {"password_hash": stored(), "must_change_password": 0}
    server = FakeServer(databases={"milestone_master"}, admin_row=row)
    with (
        server.patch(),
        patch.object(init_db, "generate_password", side_effect=["first-unused", "Reset-Pass-9"]),
    ):
        await init_db.apply_master_schema(master_settings())

    master = server.conn("milestone_master")
    ((sql, (new_hash, email)),) = ((s, a) for s, a in master.executed if "UPDATE admin_users" in s)
    assert "must_change_password = 1" in sql
    assert email == "admin@milestone.local"
    assert bcrypt.checkpw(b"Reset-Pass-9", new_hash.encode())
    err = capsys.readouterr().err
    assert "Reset-Pass-9" in err


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [
        {"password_hash": legacy_pbkdf2("not-admin"), "must_change_password": 0},
        {"password_hash": "pbkdf2_sha512$600000$s$h", "must_change_password": 0},
        {"password_hash": "whatever", "must_change_password": 1},  # already flagged
    ],
    ids=["other-password", "modern-format", "already-flagged"],
)
async def test_admin_with_a_real_password_is_not_reset(row):
    server = FakeServer(databases={"milestone_master"}, admin_row=row)
    with server.patch():
        await init_db.apply_master_schema(master_settings())
    assert not server.conn("milestone_master").ran("UPDATE admin_users")


# ---------------------------------------------------------------------------
# apply_tenant_schema
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tenant_schema_and_seed_with_configured_password(monkeypatch):
    monkeypatch.setenv("INIT_ADMIN_PASSWORD", "Tenant-Pass-1")
    server = FakeServer()
    seed = AsyncMock()
    with (
        server.patch(),
        patch("app.services.tenant_provisioner.run_seed_data", seed),
        patch("app.services.encryption.hash_password", side_effect=lambda p: f"hashed:{p}"),
        patch("app.services.tenant_provisioner.get_tenant_schema_sql", return_value="-- SCHEMA"),
    ):
        await init_db.apply_tenant_schema(settings())

    assert server.conn("postgres").ran('CREATE DATABASE "milestone_dev" OWNER "app_user"')
    kwargs, tenant = server.connections[-1]
    assert (kwargs["database"], kwargs["user"], kwargs["password"]) == (
        "milestone_dev",
        "app_user",
        "app_pw",
    )
    assert tenant.sql()[0] == "-- SCHEMA"
    seed.assert_awaited_once_with(tenant, "admin@milestone.local", "hashed:Tenant-Pass-1")
    assert tenant.ran("INSERT INTO settings (key, value)")
    assert tenant.closed


@pytest.mark.asyncio
async def test_tenant_schema_generates_a_password_when_unset(capsys):
    server = FakeServer(databases={"milestone_dev"})
    seed = AsyncMock()
    with (
        server.patch(),
        patch("app.services.tenant_provisioner.run_seed_data", seed),
        patch("app.services.encryption.hash_password", side_effect=lambda p: f"hashed:{p}"),
        patch.object(init_db, "generate_password", return_value="Auto-Gen-7"),
    ):
        await init_db.apply_tenant_schema(settings())

    assert seed.await_args.args[2] == "hashed:Auto-Gen-7"
    assert "auto-generated" in capsys.readouterr().out
    # The real tenant schema was applied.
    assert "CREATE TABLE IF NOT EXISTS users" in server.conn("milestone_dev").sql()[0]


@pytest.mark.asyncio
async def test_tenant_connection_is_closed_when_the_seed_fails():
    server = FakeServer(databases={"milestone_dev"})
    with (
        server.patch(),
        patch("app.services.tenant_provisioner.run_seed_data", AsyncMock(side_effect=RuntimeError)),
        patch("app.services.encryption.hash_password", return_value="h"),
        pytest.raises(RuntimeError),
    ):
        await init_db.apply_tenant_schema(settings())
    assert server.conn("milestone_dev").closed


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("multi", "expected"), [(True, "master"), (False, "tenant")])
async def test_main_dispatches_on_mode(multi, expected, capsys):
    master, tenant = AsyncMock(), AsyncMock()
    cfg = settings(multi_tenant=multi)
    with (
        patch.object(init_db, "get_settings", return_value=cfg),
        patch.object(init_db, "apply_master_schema", master),
        patch.object(init_db, "apply_tenant_schema", tenant),
    ):
        await init_db.main()

    called, skipped = (master, tenant) if expected == "master" else (tenant, master)
    called.assert_awaited_once_with(cfg)
    skipped.assert_not_awaited()
    assert "completed successfully" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_main_exits_1_on_failure(capsys):
    with (
        patch.object(init_db, "get_settings", return_value=settings()),
        patch.object(init_db, "apply_tenant_schema", AsyncMock(side_effect=OSError("no db"))),
        pytest.raises(SystemExit) as exc,
    ):
        await init_db.main()

    assert exc.value.code == 1
    assert "Database initialization failed: no db" in capsys.readouterr().out
