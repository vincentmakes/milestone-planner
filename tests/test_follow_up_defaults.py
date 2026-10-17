"""
Guards for defaults that drifted apart once and were documented as gotchas.

- The migration runners fall back to the same master database name as the app
  (``Settings.master_db_name``). They used to default to ``milestone_admin``
  while the app defaulted to ``milestone_master``, so a runner invoked without
  ``MASTER_DB_NAME`` targeted a database the app never used.
- ``upgrade_to_v90.sql`` is a legacy catch-up script; it must not add columns
  that no model or schema source has (it once added
  ``predefined_phases.is_system`` / ``color``).
"""

import re
from pathlib import Path

from app.config import Settings
from migrations.run_migration_master import split_sql_statements

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "migrations"


def _app_default() -> str:
    return Settings(db_host="h", db_port=5432, db_name="d", db_user="u", db_password="p").master_db_name


def test_python_runners_default_master_db_name_matches_the_app():
    expected = _app_default()
    for runner in ("run_migration.py", "run_migration_master.py"):
        source = (MIGRATIONS / runner).read_text()
        match = re.search(r"""getenv\(\s*['"]MASTER_DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)""", source)
        assert match, f"{runner} no longer reads MASTER_DB_NAME with a default"
        assert match.group(1) == expected, f"{runner} defaults to {match.group(1)!r}, app to {expected!r}"
        assert "milestone_admin" not in source


def test_shell_wrapper_defaults_master_db_name_like_the_app():
    source = (MIGRATIONS / "migrate_all_tenants.sh").read_text()
    assert 'ADMIN_DB="${ADMIN_DB:-${MASTER_DB_NAME:-' + _app_default() + '}}"' in source


def test_legacy_v90_script_adds_no_unknown_predefined_phases_columns():
    sql = (MIGRATIONS / "upgrade_to_v90.sql").read_text()
    statements = split_sql_statements(sql)
    assert statements, "the legacy script must still split into statements"
    offending = [s for s in statements if re.search(r"ALTER TABLE predefined_phases ADD COLUMN", s)]
    assert offending == [], offending
    assert "LEGACY" in sql.splitlines()[2]
