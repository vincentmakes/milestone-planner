"""
Tenant management routes.

Provides CRUD operations for tenants, provisioning, and system stats.
"""

import logging
import sys
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models.tenant import AdminUser, Tenant, TenantAuditLog, TenantCredentials
from app.routers.admin.auth import get_current_admin
from app.schemas.tenant import (
    ResetAdminPasswordRequest,
    TenantCreate,
    TenantProvisionRequest,
    TenantUpdate,
)
from app.services.encryption import decrypt, encrypt, generate_password
from app.services.master_db import get_master_db
from app.services.tenant_manager import tenant_connection_manager
from app.services.tenant_provisioner import (
    check_tenant_database,
    drop_tenant_database,
    provision_tenant_database,
)

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter()

# Start time for uptime calculation
_start_time = time.time()


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------


async def add_audit_log(
    db: AsyncSession,
    tenant_id,
    action: str,
    details: dict | None = None,
    actor: str | None = None,
):
    """Add an audit log entry."""
    log = TenantAuditLog(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        action=action,
        details=details,
        actor=actor,
    )
    db.add(log)


def tenant_to_response(tenant: Tenant, db_status: dict | None = None) -> dict:
    """Convert tenant model to response dict."""
    return {
        "id": str(tenant.id),
        "name": tenant.name,
        "slug": tenant.slug,
        "database_name": tenant.database_name,
        "database_user": tenant.database_user,
        "company_name": tenant.company_name,
        "admin_email": tenant.admin_email,
        "status": tenant.status,
        "plan": tenant.plan,
        "max_users": tenant.max_users,
        "max_projects": tenant.max_projects,
        "created_at": tenant.created_at,
        "updated_at": tenant.updated_at,
        "database_status": db_status,
        "organization_id": str(tenant.organization_id) if tenant.organization_id else None,
        "organization_name": tenant.organization.name if tenant.organization else None,
        "required_group_ids": tenant.required_group_ids or [],
        "group_membership_mode": tenant.group_membership_mode or "any",
    }


# ---------------------------------------------------------
# Tenant CRUD
# ---------------------------------------------------------


@router.get("/tenants")
async def list_tenants(
    include_archived: bool = False,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all tenants."""
    query = select(Tenant).options(
        selectinload(Tenant.credentials),
        selectinload(Tenant.organization),
    )

    if not include_archived:
        query = query.where(Tenant.status != "archived")

    query = query.order_by(Tenant.name)

    result = await db.execute(query)
    tenants = result.scalars().all()

    response = []
    for tenant in tenants:
        db_status = None
        if tenant.credentials:
            try:
                decrypted_password = decrypt(tenant.credentials.encrypted_password)
                db_status = await check_tenant_database(
                    tenant.database_name,
                    tenant.database_user,
                    decrypted_password,
                )
            except Exception:
                db_status = {
                    "exists": False,
                    "accessible": False,
                    "error": "Credential decryption failed",
                }

        response.append(tenant_to_response(tenant, db_status))

    return response


@router.get("/tenants/{tenant_id}")
async def get_tenant(
    tenant_id: str,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get a single tenant with details."""
    result = await db.execute(
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(
            selectinload(Tenant.credentials),
            selectinload(Tenant.audit_logs),
            selectinload(Tenant.organization),
        )
    )
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    db_status = None
    if tenant.credentials:
        try:
            decrypted_password = decrypt(tenant.credentials.encrypted_password)
            db_status = await check_tenant_database(
                tenant.database_name,
                tenant.database_user,
                decrypted_password,
            )
        except Exception:
            db_status = {
                "exists": False,
                "accessible": False,
                "error": "Credential decryption failed",
            }

    response = tenant_to_response(tenant, db_status)

    response["audit_log"] = [
        {
            "id": str(log.id),
            "action": log.action,
            "details": log.details,
            "actor": log.actor,
            "created_at": log.created_at,
        }
        for log in (tenant.audit_logs or [])[:20]
    ]

    return response


@router.post("/tenants", status_code=201)
async def create_tenant(
    data: TenantCreate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create a new tenant."""
    import re

    if not re.match(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$", data.slug):
        raise HTTPException(
            status_code=400,
            detail="Invalid slug format. Use lowercase letters, numbers, and hyphens only.",
        )

    reserved = ["admin", "api", "app", "www", "mail", "ftp", "localhost", "test", "demo"]
    if data.slug in reserved:
        raise HTTPException(status_code=400, detail="This slug is reserved")

    existing = await db.execute(select(Tenant).where(Tenant.slug == data.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A tenant with this slug already exists")

    db_name = f"milestone_{data.slug.replace('-', '_')}"
    db_user = f"milestone_{data.slug.replace('-', '_')}_user"
    db_password = generate_password(32)

    tenant = Tenant(
        id=uuid.uuid4(),
        name=data.name,
        slug=data.slug,
        database_name=db_name,
        database_user=db_user,
        company_name=data.company_name,
        admin_email=data.admin_email,
        status="pending",
        plan=data.plan,
        max_users=data.max_users,
        max_projects=data.max_projects,
    )
    db.add(tenant)
    await db.flush()

    try:
        encrypted_pw = encrypt(db_password)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None
    credentials = TenantCredentials(
        tenant_id=tenant.id,
        encrypted_password=encrypted_pw,
    )
    db.add(credentials)

    await add_audit_log(
        db,
        tenant.id,
        "created",
        details={"admin_email": data.admin_email},
        actor=admin.email,
    )

    await db.commit()
    await db.refresh(tenant)

    return {
        "success": True,
        "tenant": tenant_to_response(tenant),
        "credentials": {
            "database_name": db_name,
            "database_user": db_user,
            "database_password": db_password,
        },
        "message": "Tenant created. Use the provision endpoint to create the database.",
    }


@router.put("/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: str,
    data: TenantUpdate,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update a tenant."""
    from app.models.organization import Organization

    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.organization))
    )
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    update_fields = data.model_dump(exclude_unset=True, by_alias=False)
    changes = {}

    if "organization_id" in update_fields and update_fields["organization_id"]:
        org_result = await db.execute(
            select(Organization).where(Organization.id == update_fields["organization_id"])
        )
        if not org_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Organization not found")

    if "group_membership_mode" in update_fields:
        if update_fields["group_membership_mode"] not in ("any", "all"):
            raise HTTPException(
                status_code=400, detail="group_membership_mode must be 'any' or 'all'"
            )

    for field, value in update_fields.items():
        if hasattr(tenant, field) and getattr(tenant, field) != value:
            changes[field] = {"from": getattr(tenant, field), "to": value}
            setattr(tenant, field, value)

    if changes:
        await add_audit_log(db, tenant.id, "updated", details=changes, actor=admin.email)

    await db.commit()

    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.organization))
    )
    tenant = result.scalar_one_or_none()

    return tenant_to_response(tenant)


@router.put("/tenants/{tenant_id}/status")
async def update_tenant_status(
    tenant_id: str,
    request: Request,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update tenant status. Valid statuses: active, suspended, archived."""
    body = await request.json()
    new_status = body.get("status")

    if new_status not in ["active", "suspended", "archived"]:
        raise HTTPException(
            status_code=400, detail="Invalid status. Must be: active, suspended, or archived"
        )

    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    old_status = tenant.status
    tenant.status = new_status

    await add_audit_log(
        db,
        tenant.id,
        f"status_changed_to_{new_status}",
        details={"from": old_status, "to": new_status},
        actor=admin.email,
    )

    if new_status != "active":
        try:
            await tenant_connection_manager._close_pool(tenant.slug)
        except Exception:
            pass

    await db.commit()
    await db.refresh(tenant)

    return tenant_to_response(tenant)


@router.delete("/tenants/{tenant_id}")
async def delete_tenant(
    tenant_id: str,
    delete_database: bool = Query(False, description="Also drop the tenant's database"),
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete a tenant."""
    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if tenant.status == "active":
        raise HTTPException(
            status_code=400,
            detail="Tenant must be suspended before deletion. Active tenants cannot be deleted.",
        )

    if delete_database and tenant.credentials:
        try:
            logger.info("Dropping database for tenant %s: %s", tenant.slug, tenant.database_name)
            await drop_tenant_database(tenant.database_name, tenant.database_user)
            logger.info("Successfully dropped database: %s", tenant.database_name)
        except Exception:
            logger.exception("Error dropping database for tenant %s", tenant.slug)

    await db.delete(tenant)
    await db.commit()

    return {
        "success": True,
        "message": "Tenant and database deleted"
        if delete_database
        else "Tenant deleted (database preserved)",
    }


# ---------------------------------------------------------
# Provisioning
# ---------------------------------------------------------


@router.post("/tenants/{tenant_id}/provision")
async def provision_tenant(
    tenant_id: str,
    data: TenantProvisionRequest | None = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Provision a tenant's database."""
    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.credentials:
        raise HTTPException(status_code=400, detail="Tenant credentials not found")

    db_password = decrypt(tenant.credentials.encrypted_password)
    admin_email = data.admin_email if data and data.admin_email else tenant.admin_email
    admin_password = data.admin_password if data and data.admin_password else None

    logger.info(
        "Provisioning tenant %s: admin_email=%s, password=%s",
        tenant.slug,
        admin_email,
        "provided" if admin_password else "will be generated",
    )

    try:
        prov_result = await provision_tenant_database(
            tenant_id=tenant.id,
            database_name=tenant.database_name,
            database_user=tenant.database_user,
            database_password=db_password,
            admin_email=admin_email,
            admin_password=admin_password,
        )
        logger.info("Tenant database provisioned successfully: %s", tenant.slug)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {e}") from e

    tenant.status = "active"

    await add_audit_log(
        db,
        tenant.id,
        "provisioned",
        details={"admin_email": admin_email},
        actor=admin.email,
    )

    await db.commit()

    return {
        "success": True,
        "message": "Database provisioned successfully",
        "adminEmail": prov_result["admin_email"],
        "adminPassword": prov_result["admin_password"],
    }


@router.post("/tenants/{tenant_id}/reset-admin-password")
async def reset_tenant_admin_password(
    tenant_id: str,
    data: ResetAdminPasswordRequest | None = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Reset a tenant's admin password."""
    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id).options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()

    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    if not tenant.credentials:
        raise HTTPException(status_code=400, detail="Tenant credentials not found")

    tenant_password = decrypt(tenant.credentials.encrypted_password)

    db_status = await check_tenant_database(
        tenant.database_name,
        tenant.database_user,
        tenant_password,
    )

    if not db_status.get("accessible"):
        raise HTTPException(
            status_code=400,
            detail="Tenant database is not accessible. Provision it first.",
        )

    new_password = data.password if data and data.password else generate_password(16)
    admin_email = data.email if data and data.email else tenant.admin_email

    import asyncpg

    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=tenant.database_user,
        password=tenant_password,
        database=tenant.database_name,
    )

    try:
        result = await conn.execute(
            "UPDATE users SET password = $1 WHERE email = $2 AND role = 'admin'",
            new_password,
            admin_email,
        )

        if result == "UPDATE 0":
            row = await conn.fetchrow("SELECT email FROM users WHERE role = 'admin' LIMIT 1")
            if row:
                admin_email = row["email"]
                await conn.execute(
                    "UPDATE users SET password = $1 WHERE email = $2",
                    new_password,
                    admin_email,
                )
            else:
                raise HTTPException(
                    status_code=404,
                    detail="No admin user found in tenant database",
                )
    finally:
        await conn.close()

    await add_audit_log(
        db,
        tenant.id,
        "admin_password_reset",
        details={"admin_email": admin_email},
        actor=admin.email,
    )
    await db.commit()

    return {
        "success": True,
        "email": admin_email,
        "password": new_password,
        "message": f"Password reset for {admin_email}",
    }


@router.get("/tenants/{tenant_id}/audit")
async def get_tenant_audit_log(
    tenant_id: str,
    limit: int = 50,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get tenant audit log."""
    result = await db.execute(
        select(TenantAuditLog)
        .where(TenantAuditLog.tenant_id == tenant_id)
        .order_by(TenantAuditLog.created_at.desc())
        .limit(limit)
    )
    logs = result.scalars().all()

    return [
        {
            "id": str(log.id),
            "action": log.action,
            "details": log.details,
            "actor": log.actor,
            "created_at": log.created_at,
        }
        for log in logs
    ]


# ---------------------------------------------------------
# System Stats
# ---------------------------------------------------------


@router.get("/stats")
async def get_system_stats(
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Get system statistics."""
    import psutil

    result = await db.execute(select(Tenant.status, func.count(Tenant.id)).group_by(Tenant.status))
    status_counts = {row[0]: row[1] for row in result.all()}

    tenant_stats = {
        "total": sum(status_counts.values()),
        "active": status_counts.get("active", 0),
        "suspended": status_counts.get("suspended", 0),
        "pending": status_counts.get("pending", 0),
        "archived": status_counts.get("archived", 0),
    }

    pool_stats = tenant_connection_manager.get_stats()

    process = psutil.Process()
    memory_info = process.memory_info()

    return {
        "tenants": tenant_stats,
        "connections": {
            "active_pools": pool_stats["active_pools"],
            "total_connections": pool_stats["total_connections"],
        },
        "system": {
            "uptime": time.time() - _start_time,
            "memory_mb": memory_info.rss / 1024 / 1024,
            "python_version": sys.version,
        },
    }
