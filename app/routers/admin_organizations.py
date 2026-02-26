"""
Admin Organizations Router.

Handles organization management in multi-tenant admin panel:
- Organization CRUD operations
- Organization SSO configuration
- Tenant-organization association
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.organization import Organization, OrganizationSSOConfig
from app.models.tenant import Tenant

# Import admin auth dependency and helpers from admin sub-package
from app.models.tenant import AdminUser
from app.routers.admin.auth import get_current_admin
from app.routers.admin.tenants import add_audit_log
from app.schemas.organization import (
    OrganizationCreate,
    OrganizationDetailResponse,
    OrganizationResponse,
    OrganizationSSOConfigCreate,
    OrganizationSSOConfigResponse,
    OrganizationUpdate,
    TenantGroupAccessUpdate,
    TenantSummary,
)
from app.services.encryption import encrypt
from app.services.master_db import get_master_db

router = APIRouter(prefix="/admin/organizations", tags=["Admin Organizations"])


# ---------------------------------------------------------
# Organization CRUD
# ---------------------------------------------------------


@router.get("", response_model=list[OrganizationResponse])
async def list_organizations(
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all organizations with tenant counts."""
    # Query organizations with tenant count
    result = await db.execute(
        select(Organization, func.count(Tenant.id).label("tenant_count"))
        .outerjoin(Tenant, Tenant.organization_id == Organization.id)
        .options(selectinload(Organization.sso_config))
        .group_by(Organization.id)
        .order_by(Organization.name)
    )
    rows = result.all()

    return [
        OrganizationResponse(
            id=org.id,
            name=org.name,
            slug=org.slug,
            description=org.description,
            created_at=org.created_at,
            updated_at=org.updated_at,
            tenant_count=count,
            sso_enabled=org.sso_config.is_enabled if org.sso_config else False,
        )
        for org, count in rows
    ]


@router.post("", response_model=OrganizationResponse, status_code=201)
async def create_organization(
    data: OrganizationCreate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create a new organization."""
    # Check if slug is already used
    existing = await db.execute(select(Organization).where(Organization.slug == data.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Organization with slug '{data.slug}' already exists",
        )

    # Create organization
    org = Organization(
        id=uuid.uuid4(),
        name=data.name,
        slug=data.slug,
        description=data.description,
    )
    db.add(org)
    await db.commit()
    await db.refresh(org)

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        tenant_count=0,
        sso_enabled=False,
    )


@router.get("/{org_id}", response_model=OrganizationDetailResponse)
async def get_organization(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get organization details including SSO config and tenants."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(
            selectinload(Organization.sso_config),
            selectinload(Organization.tenants),
        )
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Build SSO config response if exists
    sso_config = None
    if org.sso_config:
        sso_config = OrganizationSSOConfigResponse(
            enabled=org.sso_config.is_enabled,
            configured=org.sso_config.is_configured,
            provider=org.sso_config.provider,
            entra_tenant_id=org.sso_config.entra_tenant_id,
            client_id=org.sso_config.client_id,
            redirect_uri=org.sso_config.redirect_uri,
            auto_create_users=org.sso_config.should_auto_create_users,
            default_user_role=org.sso_config.default_user_role,
        )

    return OrganizationDetailResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        sso_config=sso_config,
        tenants=[
            TenantSummary(
                id=t.id,
                name=t.name,
                slug=t.slug,
                status=t.status,
                required_group_ids=t.required_group_ids or [],
                group_membership_mode=t.group_membership_mode or "any",
            )
            for t in org.tenants
        ],
    )


@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    org_id: str,
    data: OrganizationUpdate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update an organization."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if data.name is not None:
        org.name = data.name
    if data.description is not None:
        org.description = data.description

    org.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(org)

    # Get tenant count
    count_result = await db.execute(
        select(func.count(Tenant.id)).where(Tenant.organization_id == org.id)
    )
    tenant_count = count_result.scalar() or 0

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        description=org.description,
        created_at=org.created_at,
        updated_at=org.updated_at,
        tenant_count=tenant_count,
        sso_enabled=org.sso_config.is_enabled if org.sso_config else False,
    )


@router.delete("/{org_id}")
async def delete_organization(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete an organization. Tenants will be disassociated but not deleted."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.tenants))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Disassociate tenants (organization_id will be set to NULL by ON DELETE SET NULL)
    # Just need to clear group restrictions
    for tenant in org.tenants:
        tenant.required_group_ids = []
        tenant.group_membership_mode = "any"

    await db.delete(org)
    await db.commit()

    return {"success": True, "message": f"Organization '{org.name}' deleted"}


# ---------------------------------------------------------
# Organization SSO Configuration
# ---------------------------------------------------------


@router.get("/{org_id}/sso", response_model=OrganizationSSOConfigResponse)
async def get_organization_sso_config(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if not org.sso_config:
        return OrganizationSSOConfigResponse(
            enabled=False,
            configured=False,
            provider="entra",
            entra_tenant_id=None,
            client_id=None,
            redirect_uri=None,
            auto_create_users=False,
            default_user_role="user",
        )

    return OrganizationSSOConfigResponse(
        enabled=org.sso_config.is_enabled,
        configured=org.sso_config.is_configured,
        provider=org.sso_config.provider,
        entra_tenant_id=org.sso_config.entra_tenant_id,
        client_id=org.sso_config.client_id,
        redirect_uri=org.sso_config.redirect_uri,
        auto_create_users=org.sso_config.should_auto_create_users,
        default_user_role=org.sso_config.default_user_role,
    )


@router.put("/{org_id}/sso", response_model=OrganizationSSOConfigResponse)
async def update_organization_sso_config(
    org_id: str,
    data: OrganizationSSOConfigCreate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create or update organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    config = org.sso_config

    if not config:
        # Create new SSO config
        config = OrganizationSSOConfig(
            organization_id=org.id,
            enabled=1 if data.enabled else 0,
            provider="entra",
        )
        db.add(config)

    # Update fields if provided
    if data.enabled is not None:
        config.enabled = 1 if data.enabled else 0
    if data.entra_tenant_id is not None:
        config.entra_tenant_id = data.entra_tenant_id
    if data.client_id is not None:
        config.client_id = data.client_id
    if data.client_secret is not None and data.client_secret:
        # Encrypt the client secret
        config.client_secret_encrypted = encrypt(data.client_secret)
    if data.redirect_uri is not None:
        config.redirect_uri = data.redirect_uri
    if data.auto_create_users is not None:
        config.auto_create_users = 1 if data.auto_create_users else 0
    if data.default_user_role is not None:
        config.default_user_role = data.default_user_role

    config.updated_at = datetime.utcnow()

    await db.commit()
    await db.refresh(config)

    return OrganizationSSOConfigResponse(
        enabled=config.is_enabled,
        configured=config.is_configured,
        provider=config.provider,
        entra_tenant_id=config.entra_tenant_id,
        client_id=config.client_id,
        redirect_uri=config.redirect_uri,
        auto_create_users=config.should_auto_create_users,
        default_user_role=config.default_user_role,
    )


@router.delete("/{org_id}/sso")
async def delete_organization_sso_config(
    org_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete organization SSO configuration."""
    result = await db.execute(
        select(Organization)
        .where(Organization.id == org_id)
        .options(selectinload(Organization.sso_config))
    )
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    if not org.sso_config:
        raise HTTPException(status_code=404, detail="SSO config not found")

    await db.delete(org.sso_config)
    await db.commit()

    return {"success": True, "message": "SSO configuration deleted"}


# ---------------------------------------------------------
# Tenant Organization Assignment
# ---------------------------------------------------------


@router.put("/{org_id}/tenants/{tenant_id}")
async def add_tenant_to_organization(
    org_id: str,
    tenant_id: str,
    data: TenantGroupAccessUpdate | None = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Add a tenant to an organization with optional group requirements."""
    # Get organization
    org_result = await db.execute(select(Organization).where(Organization.id == org_id))
    org = org_result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    # Get tenant
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Update tenant
    tenant.organization_id = org.id

    if data:
        if data.required_group_ids is not None:
            tenant.required_group_ids = data.required_group_ids
        if data.group_membership_mode is not None:
            if data.group_membership_mode not in ("any", "all"):
                raise HTTPException(
                    status_code=400, detail="group_membership_mode must be 'any' or 'all'"
                )
            tenant.group_membership_mode = data.group_membership_mode

    # Add audit log
    await add_audit_log(
        db,
        tenant.id,
        "organization_assigned",
        details={"organization_id": str(org.id), "organization_name": org.name},
        actor=admin.email,
    )

    await db.commit()

    return {
        "success": True,
        "message": f"Tenant '{tenant.name}' added to organization '{org.name}'",
    }


@router.delete("/{org_id}/tenants/{tenant_id}")
async def remove_tenant_from_organization(
    org_id: str,
    tenant_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Remove a tenant from an organization."""
    # Get tenant
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if str(tenant.organization_id) != org_id:
        raise HTTPException(status_code=400, detail="Tenant is not in this organization")

    # Clear organization and group settings
    old_org_id = tenant.organization_id
    tenant.organization_id = None
    tenant.required_group_ids = []
    tenant.group_membership_mode = "any"

    # Add audit log
    await add_audit_log(
        db,
        tenant.id,
        "organization_removed",
        details={"organization_id": str(old_org_id)},
        actor=admin.email,
    )

    await db.commit()

    return {
        "success": True,
        "message": f"Tenant '{tenant.name}' removed from organization",
    }


@router.patch("/tenants/{tenant_id}/groups")
async def update_tenant_group_access(
    tenant_id: str,
    data: TenantGroupAccessUpdate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update tenant's group-based access requirements."""
    # Get tenant
    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = tenant_result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Handle organization_id update
    if data.organization_id is not None:
        if data.organization_id:
            # Verify organization exists
            org_result = await db.execute(
                select(Organization).where(Organization.id == data.organization_id)
            )
            if not org_result.scalar_one_or_none():
                raise HTTPException(status_code=404, detail="Organization not found")
        tenant.organization_id = data.organization_id if data.organization_id else None

    if data.required_group_ids is not None:
        tenant.required_group_ids = data.required_group_ids

    if data.group_membership_mode is not None:
        if data.group_membership_mode not in ("any", "all"):
            raise HTTPException(
                status_code=400, detail="group_membership_mode must be 'any' or 'all'"
            )
        tenant.group_membership_mode = data.group_membership_mode

    await db.commit()
    await db.refresh(tenant)

    return {
        "success": True,
        "organization_id": str(tenant.organization_id) if tenant.organization_id else None,
        "required_group_ids": tenant.required_group_ids or [],
        "group_membership_mode": tenant.group_membership_mode,
    }
