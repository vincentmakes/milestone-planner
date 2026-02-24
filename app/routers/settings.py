"""
Settings API router.
Handles application settings key-value storage.

This is one of the first endpoints migrated to Python.
It matches the Node.js API at /api/settings exactly.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_admin
from app.models.settings import Settings, SSOConfig
from app.models.user import User
from app.schemas.auth import SSOConfigResponse, SSOConfigUpdate
from app.schemas.settings import SettingsResponse, SettingUpdate

router = APIRouter()


@router.get("/settings", response_model=dict[str, str | None])
async def get_all_settings(db: AsyncSession = Depends(get_db)):
    """
    Get all settings as a key-value dictionary.

    This endpoint is public - needed for instance title on login page.
    Matches: GET /api/settings
    """
    result = await db.execute(select(Settings))
    settings = result.scalars().all()

    return {s.key: s.value for s in settings}


# ---------------------------------------------------------
# SSO Configuration (MUST be before /settings/{key} routes)
# ---------------------------------------------------------


@router.get("/settings/sso", response_model=SSOConfigResponse)
async def get_sso_settings(
    db: AsyncSession = Depends(get_db),
):
    """
    Get SSO configuration.

    Public endpoint - needed for login page.
    Matches: GET /api/settings/sso
    """
    try:
        result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
        config = result.scalar_one_or_none()
    except Exception as e:
        # Table might not exist - return default disabled config
        print(f"SSO config query failed (table may not exist): {e}")
        return SSOConfigResponse(
            enabled=False,
            configured=False,
        )

    if not config:
        return SSOConfigResponse(
            enabled=False,
            configured=False,
        )

    # Extract values to avoid any lazy loading issues
    return SSOConfigResponse(
        enabled=config.enabled == 1,
        configured=bool(config.tenant_id and config.client_id and config.redirect_uri),
        tenant_id=config.tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.auto_create_users == 1,
        default_role=config.default_role,
    )


@router.put("/settings/sso", response_model=SSOConfigResponse)
async def update_sso_settings(
    data: SSOConfigUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update SSO configuration.

    Requires admin authentication.
    Matches: PUT /api/settings/sso
    """
    result = await db.execute(select(SSOConfig).where(SSOConfig.id == 1))
    config = result.scalar_one_or_none()

    if not config:
        # Create new config
        config = SSOConfig(id=1)
        db.add(config)

    # Update fields - use column names directly, not properties
    if data.enabled is not None:
        config.enabled = 1 if data.enabled else 0
    if data.tenant_id is not None:
        config.tenant_id = data.tenant_id
    if data.client_id is not None:
        config.client_id = data.client_id
    if data.client_secret is not None:
        config.client_secret = data.client_secret
    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_role is not None:
        config.default_role = data.default_role

    await db.commit()
    await db.refresh(config)

    # Extract values directly to avoid property lazy loading
    return SSOConfigResponse(
        enabled=config.enabled == 1,
        configured=bool(config.tenant_id and config.client_id and config.redirect_uri),
        tenant_id=config.tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.auto_create_users == 1,
        default_role=config.default_role,
    )


# ---------------------------------------------------------
# Generic Key-Value Settings (AFTER specific routes)
# ---------------------------------------------------------


@router.get("/settings/{key}", response_model=SettingsResponse)
async def get_setting(key: str, db: AsyncSession = Depends(get_db)):
    """
    Get a specific setting by key.

    This endpoint is public.
    Matches: GET /api/settings/:key
    """
    result = await db.execute(select(Settings).where(Settings.key == key))
    setting = result.scalar_one_or_none()

    if setting:
        return SettingsResponse(key=key, value=setting.value)
    else:
        return SettingsResponse(key=key, value=None)


@router.put("/settings/{key}", response_model=SettingsResponse)
async def update_setting(
    key: str,
    data: SettingUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update a setting (create if not exists).

    Requires admin authentication.
    Matches: PUT /api/settings/:key
    """
    # Check if setting exists
    result = await db.execute(select(Settings).where(Settings.key == key))
    setting = result.scalar_one_or_none()

    if setting:
        # Update existing
        setting.value = data.value
    else:
        # Create new
        setting = Settings(key=key, value=data.value)
        db.add(setting)

    await db.commit()
    await db.refresh(setting)

    return SettingsResponse(key=setting.key, value=setting.value)
