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
