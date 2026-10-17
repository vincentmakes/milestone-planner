"""Tests for the SQL migration statement splitter."""

import sys
from pathlib import Path

# Add project root so we can import migrations module
sys.path.insert(0, str(Path(__file__).parent.parent))

from migrations.run_migration_master import split_sql_statements


def test_simple_statements():
    """Simple semicolon-delimited statements are split correctly."""
    sql = "CREATE TABLE foo (id INT);\nCREATE TABLE bar (id INT);"
    stmts = split_sql_statements(sql)
    assert len(stmts) == 2
    assert "foo" in stmts[0]
    assert "bar" in stmts[1]


def test_comments_are_skipped():
    """SQL comments are excluded from statement output."""
    sql = "-- This is a comment\nCREATE TABLE foo (id INT);"
    stmts = split_sql_statements(sql)
    assert len(stmts) == 1
    assert "foo" in stmts[0]


def test_dollar_quoted_block_preserved():
    """DO $$ ... END $$; blocks are kept as a single statement."""
    sql = """
CREATE TABLE foo (id INT);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM foo WHERE id = 1) THEN
        INSERT INTO foo (id) VALUES (1);
    END IF;
END $$;

CREATE TABLE bar (id INT);
"""
    stmts = split_sql_statements(sql)
    assert len(stmts) == 3
    assert "CREATE TABLE foo" in stmts[0]
    assert "DO $$" in stmts[1]
    assert "INSERT INTO foo" in stmts[1]
    assert "END $$;" in stmts[1]
    assert "CREATE TABLE bar" in stmts[2]


def test_empty_sql():
    """Empty SQL produces no statements."""
    stmts = split_sql_statements("")
    assert len(stmts) == 0


def test_only_comments():
    """SQL with only comments produces no statements."""
    sql = "-- comment 1\n-- comment 2\n"
    stmts = split_sql_statements(sql)
    assert len(stmts) == 0


def test_inline_semicolons_in_dollar_block():
    """Semicolons inside $$ blocks don't split the statement."""
    sql = """DO $$
BEGIN
    EXECUTE 'DROP TABLE IF EXISTS temp;';
    EXECUTE 'CREATE TABLE temp (id INT);';
END $$;"""
    stmts = split_sql_statements(sql)
    assert len(stmts) == 1
    assert "DROP TABLE" in stmts[0]
    assert "CREATE TABLE" in stmts[0]


def test_declare_loop_dollar_block_stays_whole():
    """A DO block with DECLARE, a FOR ... LOOP and an IF (the FK-rewrite shape)
    is one statement, inner semicolons included."""
    sql = """CREATE INDEX IF NOT EXISTS idx_x ON x(y);

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    FOR fk_name IN
        SELECT c.conname FROM pg_constraint c WHERE c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE equipment DROP CONSTRAINT %I', fk_name);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint) THEN
        UPDATE equipment SET site_id = NULL WHERE site_id IS NOT NULL;
        ALTER TABLE equipment ADD CONSTRAINT equipment_site_id_fkey
            FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
    END IF;
END $$;

INSERT INTO equipment_sites (equipment_id, site_id) SELECT 1, 1;
"""
    stmts = split_sql_statements(sql)
    assert len(stmts) == 3
    assert stmts[1].lstrip().startswith("DO $$")
    assert "END LOOP;" in stmts[1]
    assert "ON DELETE SET NULL;" in stmts[1]
    assert stmts[1].rstrip().endswith("END $$;")
    assert "INSERT INTO equipment_sites" in stmts[2]


def test_equipment_sites_migration_splits_cleanly():
    """The real migration file: every DO block is kept whole."""
    path = Path(__file__).parent.parent / "migrations" / "add_equipment_sites_and_site_closures.sql"
    stmts = split_sql_statements(path.read_text())
    do_blocks = [s for s in stmts if s.lstrip().startswith("DO $$")]
    assert len(do_blocks) == 3  # FK rewrite, grants, completion notice
    assert all(s.rstrip().endswith("END $$;") for s in do_blocks)
    fk_block = do_blocks[0]
    assert "DROP CONSTRAINT" in fk_block and "ON DELETE SET NULL" in fk_block
    # No statement leaks out of a block: everything else is plain DDL/DML.
    for s in stmts:
        if s not in do_blocks:
            assert "$$" not in s
            assert "END IF" not in s and "END LOOP" not in s
