"""Tests for data model imports and basic structure."""


def test_tenant_models_import():
    """Verify tenant/master models can be imported."""
    from app.models.tenant import MasterBase, Tenant, AdminUser, AdminSession

    assert Tenant.__tablename__ == "tenants"
    assert AdminUser.__tablename__ == "admin_users"
    assert AdminSession.__tablename__ == "admin_sessions"


def test_tenant_base_separate_from_app_base():
    """MasterBase and Base should be distinct declarative bases."""
    from app.models.tenant import MasterBase
    from app.database import Base

    assert MasterBase is not Base
