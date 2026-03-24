"""Tests for application configuration."""

import os

import pytest


def test_settings_defaults():
    """Verify default settings load without errors."""
    # Clear cached settings so we get fresh defaults
    from app.config import Settings

    settings = Settings(
        db_host="localhost",
        db_port=5432,
        db_name="test_db",
        db_user="test_user",
        db_password="test_pass",
    )
    assert settings.app_name == "Milestone API"
    assert settings.port == 8485
    assert settings.multi_tenant is False
    assert settings.debug is False


def test_async_database_url():
    """Verify async database URL is built correctly."""
    from app.config import Settings

    settings = Settings(
        db_host="dbhost",
        db_port=5433,
        db_name="mydb",
        db_user="myuser",
        db_password="mypass",
    )
    url = settings.async_database_url
    assert url == "postgresql+asyncpg://myuser:mypass@dbhost:5433/mydb"


def test_async_database_url_from_database_url():
    """Verify DATABASE_URL is converted to async format."""
    from app.config import Settings

    settings = Settings(
        database_url="postgresql://user:pass@host:5432/db",
        db_host="ignored",
        db_name="ignored",
        db_user="ignored",
        db_password="ignored",
    )
    assert settings.async_database_url == "postgresql+asyncpg://user:pass@host:5432/db"


def test_master_database_url_disabled_when_not_multi_tenant():
    """Master DB URL should be None when not in multi-tenant mode."""
    from app.config import Settings

    settings = Settings(
        multi_tenant=False,
        db_host="localhost",
        db_name="test",
        db_user="test",
        db_password="test",
    )
    assert settings.master_async_database_url is None


def test_master_database_url_multi_tenant():
    """Master DB URL should be set in multi-tenant mode."""
    from app.config import Settings

    settings = Settings(
        multi_tenant=True,
        db_host="localhost",
        db_name="test",
        db_user="test",
        db_password="test",
        master_db_host="masterhost",
        master_db_port=5432,
        master_db_name="milestone_admin",
        master_db_user="admin",
        master_db_password="adminpass",
    )
    url = settings.master_async_database_url
    assert url == "postgresql+asyncpg://admin:adminpass@masterhost:5432/milestone_admin"
