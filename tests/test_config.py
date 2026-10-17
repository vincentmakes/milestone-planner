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
    # Holiday import defaults to the current Nager API (v4)
    assert settings.nager_api_url.endswith("/api/v4")


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


def test_sso_env_settings_are_gone_and_ignored(monkeypatch):
    """SSO is configured in-app; the SSO_* env vars were dead settings and are
    removed. An old .env that still sets them must keep loading (extra="ignore")."""
    from app.config import Settings

    monkeypatch.setenv("SSO_ENABLED", "true")
    monkeypatch.setenv("SSO_CLIENT_ID", "abc")
    settings = Settings(db_host="h", db_port=5432, db_name="d", db_user="u", db_password="p")
    for field in ("sso_enabled", "sso_client_id", "sso_client_secret", "sso_tenant_id", "sso_redirect_uri"):
        assert not hasattr(settings, field), field
