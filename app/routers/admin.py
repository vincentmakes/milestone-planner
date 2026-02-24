"""
Admin API Router.

Handles multi-tenant administration:
- Admin authentication
- Tenant CRUD operations
- Database provisioning
- System statistics
- Admin user management
"""

import json
import sys
import time
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.services.master_db import get_master_db
from app.services.encryption import (
    encrypt, decrypt, generate_password, hash_password, verify_password
)
from app.services.tenant_provisioner import (
    provision_tenant_database,
    drop_tenant_database,
    check_tenant_database,
)
from app.services.tenant_manager import tenant_connection_manager
from app.models.tenant import (
    Tenant, TenantCredentials, TenantAuditLog, AdminUser, AdminSession
)
from app.schemas.tenant import (
    AdminLoginRequest, AdminLoginResponse, AdminUserInfo, AdminMeResponse,
    TenantCreate, TenantUpdate, TenantResponse, TenantCreateResponse,
    TenantCredentialsResponse, TenantProvisionRequest, TenantProvisionResponse,
    ResetAdminPasswordRequest, ResetAdminPasswordResponse,
    SystemStatsResponse, TenantStats, ConnectionStats, SystemInfo,
    AdminUserCreate, AdminUserUpdate, AdminUserResponse,
    DatabaseStatus, AuditLogEntry,
)

router = APIRouter(prefix="/admin", tags=["Admin"])
settings = get_settings()

# Start time for uptime calculation
_start_time = time.time()


# ---------------------------------------------------------
# Admin Auth Middleware
# ---------------------------------------------------------

async def get_admin_session_id(request: Request) -> Optional[str]:
    """Extract admin session ID from cookie."""
    cookie = request.cookies.get("admin_session")
    if not cookie:
        return None
    return cookie


async def get_current_admin(
    request: Request,
    db: AsyncSession = Depends(get_master_db),
) -> AdminUser:
    """
    Get current authenticated admin user.
    
    Uses Node.js admin_sessions format:
    - sid: TEXT PRIMARY KEY (session ID)
    - sess: TEXT (JSON blob with {admin_user_id, email, ...})
    - expired: BIGINT (Unix timestamp in milliseconds)
    """
    session_id = await get_admin_session_id(request)
    
    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required",
        )
    
    # Find session (Node.js format)
    now_ms = int(time.time() * 1000)  # Current time in milliseconds
    result = await db.execute(
        select(AdminSession)
        .where(AdminSession.sid == session_id)
        .where(AdminSession.expired > now_ms)
    )
    session = result.scalar_one_or_none()
    
    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )
    
    # Parse session data from JSON blob
    try:
        sess_data = json.loads(session.sess)
        admin_user_id = sess_data.get("admin_user_id")
        if not admin_user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid session data",
            )
    except (json.JSONDecodeError, KeyError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session data format",
        )
    
    # Get admin user
    result = await db.execute(
        select(AdminUser).where(AdminUser.id == admin_user_id)
    )
    admin = result.scalar_one_or_none()
    
    if not admin:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin user not found",
        )
    
    if not admin.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin account is disabled",
        )
    
    return admin


async def get_current_admin_optional(
    request: Request,
    db: AsyncSession = Depends(get_master_db),
) -> Optional[AdminUser]:
    """Get current admin if authenticated, None otherwise."""
    try:
        return await get_current_admin(request, db)
    except HTTPException:
        return None


async def require_superadmin(
    admin: AdminUser = Depends(get_current_admin),
) -> AdminUser:
    """Require superadmin role."""
    if not admin.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Superadmin access required",
        )
    return admin


# ---------------------------------------------------------
# Admin Authentication
# ---------------------------------------------------------

@router.post("/auth/login", response_model=AdminLoginResponse)
async def admin_login(
    data: AdminLoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_master_db),
):
    """Admin login."""
    # Find admin by email
    result = await db.execute(
        select(AdminUser).where(AdminUser.email == data.email)
    )
    admin = result.scalar_one_or_none()
    
    # Verify credentials
    if not admin or not verify_password(data.password, admin.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    
    if not admin.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin account is disabled",
        )
    
    # Create session in Node.js format
    session_id = generate_password(64)
    expires_ms = int((time.time() + 86400) * 1000)  # 24 hours from now in milliseconds
    
    # Session data as JSON blob (Node.js format)
    sess_data = json.dumps({
        "admin_user_id": admin.id,
        "email": admin.email,
        "role": admin.role,
    })
    
    session = AdminSession(
        sid=session_id,
        sess=sess_data,
        expired=expires_ms,
    )
    db.add(session)
    
    # Update last login
    admin.last_login = datetime.utcnow()
    
    await db.commit()
    
    # Set cookie
    response.set_cookie(
        key="admin_session",
        value=session_id,
        max_age=86400,  # 24 hours
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
    )
    
    return AdminLoginResponse(
        success=True,
        user=AdminUserInfo(
            id=admin.id,
            email=admin.email,
            name=admin.name,
            role=admin.role,
        ),
    )


@router.post("/auth/logout")
async def admin_logout(
    response: Response,
    request: Request,
    db: AsyncSession = Depends(get_master_db),
):
    """Admin logout."""
    session_id = await get_admin_session_id(request)
    
    if session_id:
        result = await db.execute(
            select(AdminSession).where(AdminSession.sid == session_id)
        )
        session = result.scalar_one_or_none()
        if session:
            await db.delete(session)
            await db.commit()
    
    response.delete_cookie(key="admin_session", path="/")
    
    return {"success": True}


@router.get("/auth/me", response_model=AdminMeResponse)
async def admin_me(
    admin: Optional[AdminUser] = Depends(get_current_admin_optional),
):
    """Get current admin session."""
    if admin:
        return AdminMeResponse(
            user=AdminUserInfo(
                id=admin.id,
                email=admin.email,
                name=admin.name,
                role=admin.role,
            )
        )
    return AdminMeResponse(user=None)


# ---------------------------------------------------------
# Tenant Management
# ---------------------------------------------------------

async def add_audit_log(
    db: AsyncSession,
    tenant_id,  # UUID
    action: str,
    details: Optional[dict] = None,
    actor: Optional[str] = None,
):
    """Add an audit log entry."""
    import uuid
    log = TenantAuditLog(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        action=action,
        details=details,  # JSONB column, pass dict directly
        actor=actor,
    )
    db.add(log)


def tenant_to_response(tenant: Tenant, db_status: Optional[dict] = None) -> dict:
    """Convert tenant model to response dict."""
    return {
        "id": str(tenant.id),  # UUID to string
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
        # Organization fields
        "organization_id": str(tenant.organization_id) if tenant.organization_id else None,
        "organization_name": tenant.organization.name if tenant.organization else None,
        "required_group_ids": tenant.required_group_ids or [],
        "group_membership_mode": tenant.group_membership_mode or "any",
    }


@router.get("/tenants")
async def list_tenants(
    include_archived: bool = False,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all tenants."""
    from app.models.organization import Organization
    
    query = select(Tenant).options(
        selectinload(Tenant.credentials),
        selectinload(Tenant.organization),
    )
    
    if not include_archived:
        query = query.where(Tenant.status != "archived")
    
    query = query.order_by(Tenant.name)
    
    result = await db.execute(query)
    tenants = result.scalars().all()
    
    # Get database status for each tenant
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
            except Exception as e:
                db_status = {
                    "exists": False,
                    "accessible": False,
                    "error": f"Decryption failed: {e}",
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
    
    # Get database status
    db_status = None
    if tenant.credentials:
        try:
            decrypted_password = decrypt(tenant.credentials.encrypted_password)
            db_status = await check_tenant_database(
                tenant.database_name,
                tenant.database_user,
                decrypted_password,
            )
        except Exception as e:
            db_status = {
                "exists": False,
                "accessible": False,
                "error": f"Decryption failed: {e}",
            }
    
    response = tenant_to_response(tenant, db_status)
    
    # Add audit log (limited to 20 entries)
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
    import uuid
    
    # Validate slug format
    if not re.match(r'^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$', data.slug):
        raise HTTPException(
            status_code=400,
            detail="Invalid slug format. Use lowercase letters, numbers, and hyphens only.",
        )
    
    # Check reserved slugs
    reserved = ['admin', 'api', 'app', 'www', 'mail', 'ftp', 'localhost', 'test', 'demo']
    if data.slug in reserved:
        raise HTTPException(status_code=400, detail="This slug is reserved")
    
    # Check if slug exists
    existing = await db.execute(
        select(Tenant).where(Tenant.slug == data.slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A tenant with this slug already exists")
    
    # Generate database credentials
    db_name = f"milestone_{data.slug.replace('-', '_')}"
    db_user = f"milestone_{data.slug.replace('-', '_')}_user"
    db_password = generate_password(32)
    
    # Create tenant with UUID
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
    await db.flush()  # Get tenant ID
    
    # Store encrypted credentials
    credentials = TenantCredentials(
        tenant_id=tenant.id,
        encrypted_password=encrypt(db_password),
    )
    db.add(credentials)
    
    # Add audit log
    await add_audit_log(
        db, tenant.id, "created",
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
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(selectinload(Tenant.organization))
    )
    tenant = result.scalar_one_or_none()
    
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    
    # Update fields
    update_fields = data.model_dump(exclude_unset=True, by_alias=False)
    changes = {}
    
    # Validate organization_id if being set
    if "organization_id" in update_fields and update_fields["organization_id"]:
        org_result = await db.execute(
            select(Organization).where(Organization.id == update_fields["organization_id"])
        )
        if not org_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Organization not found")
    
    # Validate group_membership_mode
    if "group_membership_mode" in update_fields:
        if update_fields["group_membership_mode"] not in ("any", "all"):
            raise HTTPException(
                status_code=400, 
                detail="group_membership_mode must be 'any' or 'all'"
            )
    
    for field, value in update_fields.items():
        if hasattr(tenant, field) and getattr(tenant, field) != value:
            changes[field] = {"from": getattr(tenant, field), "to": value}
            setattr(tenant, field, value)
    
    if changes:
        await add_audit_log(db, tenant.id, "updated", details=changes, actor=admin.email)
    
    await db.commit()
    
    # Refresh with organization relationship
    result = await db.execute(
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(selectinload(Tenant.organization))
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
    """
    Update tenant status.
    
    Valid statuses: active, suspended, archived
    """
    body = await request.json()
    new_status = body.get("status")
    
    if new_status not in ["active", "suspended", "archived"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid status. Must be: active, suspended, or archived"
        )
    
    result = await db.execute(
        select(Tenant).where(Tenant.id == tenant_id)
    )
    tenant = result.scalar_one_or_none()
    
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    
    old_status = tenant.status
    tenant.status = new_status
    
    await add_audit_log(
        db, tenant.id, f"status_changed_to_{new_status}",
        details={"from": old_status, "to": new_status},
        actor=admin.email,
    )
    
    # If suspending or archiving, close any active connections
    if new_status != "active":
        try:
            await tenant_connection_manager.close_tenant(tenant.slug)
        except Exception:
            pass  # Ignore errors closing connections
    
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
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()
    
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    
    # Check if tenant is suspended (required before deletion)
    if tenant.status == 'active':
        raise HTTPException(
            status_code=400, 
            detail="Tenant must be suspended before deletion. Active tenants cannot be deleted."
        )
    
    # Drop database if requested
    if delete_database and tenant.credentials:
        try:
            print(f"Dropping database for tenant {tenant.slug}: {tenant.database_name}")
            await drop_tenant_database(tenant.database_name, tenant.database_user)
            print(f"Successfully dropped database: {tenant.database_name}")
        except Exception as e:
            print(f"Error dropping database: {e}")
            # Continue with tenant deletion even if database drop fails
            import traceback
            traceback.print_exc()
    
    # Delete tenant record (cascades to credentials and audit log)
    await db.delete(tenant)
    await db.commit()
    
    return {
        "success": True,
        "message": "Tenant and database deleted" if delete_database else "Tenant deleted (database preserved)",
    }


@router.post("/tenants/{tenant_id}/provision")
async def provision_tenant(
    tenant_id: str,
    data: TenantProvisionRequest = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Provision a tenant's database."""
    result = await db.execute(
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()
    
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    
    if not tenant.credentials:
        raise HTTPException(status_code=400, detail="Tenant credentials not found")
    
    # Get password
    db_password = decrypt(tenant.credentials.encrypted_password)
    
    # Admin email and password
    admin_email = data.admin_email if data and data.admin_email else tenant.admin_email
    admin_password = data.admin_password if data and data.admin_password else None
    
    print(f"Provision request: data={data}, tenant.admin_email={tenant.admin_email}")
    print(f"Using admin_email={admin_email}, admin_password={'***' if admin_password else 'will be generated'}")
    
    # Provision database
    try:
        prov_result = await provision_tenant_database(
            tenant_id=tenant.id,
            database_name=tenant.database_name,
            database_user=tenant.database_user,
            database_password=db_password,
            admin_email=admin_email,
            admin_password=admin_password,
        )
        print(f"Provisioner returned: {prov_result}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {e}")
    
    # Update tenant status
    tenant.status = "active"
    
    # Add audit log
    await add_audit_log(
        db, tenant.id, "provisioned",
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
    data: ResetAdminPasswordRequest = None,
    admin: AdminUser = Depends(get_current_admin),
    db: AsyncSession = Depends(get_master_db),
):
    """Reset a tenant's admin password."""
    result = await db.execute(
        select(Tenant)
        .where(Tenant.id == tenant_id)
        .options(selectinload(Tenant.credentials))
    )
    tenant = result.scalar_one_or_none()
    
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    
    if not tenant.credentials:
        raise HTTPException(status_code=400, detail="Tenant credentials not found")
    
    # Decrypt password first
    tenant_password = decrypt(tenant.credentials.encrypted_password)
    
    # Check database is accessible
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
    
    # Generate new password
    new_password = data.password if data and data.password else generate_password(16)
    admin_email = data.email if data and data.email else tenant.admin_email
    
    # Connect to tenant database and update password
    import asyncpg
    
    conn = await asyncpg.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=tenant.database_user,
        password=tenant_password,
        database=tenant.database_name,
    )
    
    try:
        # Update admin user password
        result = await conn.execute(
            "UPDATE users SET password = $1 WHERE email = $2 AND role = 'admin'",
            new_password,
            admin_email,
        )
        
        if result == "UPDATE 0":
            # Try any admin
            row = await conn.fetchrow(
                "SELECT email FROM users WHERE role = 'admin' LIMIT 1"
            )
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
    
    # Add audit log
    await add_audit_log(
        db, tenant.id, "admin_password_reset",
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
    
    # Tenant stats
    result = await db.execute(
        select(Tenant.status, func.count(Tenant.id))
        .group_by(Tenant.status)
    )
    status_counts = {row[0]: row[1] for row in result.all()}
    
    tenant_stats = {
        "total": sum(status_counts.values()),
        "active": status_counts.get("active", 0),
        "suspended": status_counts.get("suspended", 0),
        "pending": status_counts.get("pending", 0),
        "archived": status_counts.get("archived", 0),
    }
    
    # Connection stats
    pool_stats = tenant_connection_manager.get_stats()
    
    # System stats
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


# ---------------------------------------------------------
# Admin User Management (Superadmin only)
# ---------------------------------------------------------

@router.get("/users")
async def list_admin_users(
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """List all admin users."""
    result = await db.execute(
        select(AdminUser).order_by(AdminUser.email)
    )
    users = result.scalars().all()
    
    return [
        {
            "id": u.id,
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "active": u.active,
            "created_at": u.created_at,
            "last_login": u.last_login,
        }
        for u in users
    ]


@router.post("/users", status_code=201)
async def create_admin_user(
    data: AdminUserCreate,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Create an admin user."""
    # Check if email exists
    existing = await db.execute(
        select(AdminUser).where(AdminUser.email == data.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already exists")
    
    user = AdminUser(
        email=data.email,
        password_hash=hash_password(data.password),
        name=data.name,
        role=data.role,
        active=1,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
    }


@router.put("/users/{user_id}")
async def update_admin_user(
    user_id: int,
    data: AdminUserUpdate,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Update an admin user."""
    result = await db.execute(
        select(AdminUser).where(AdminUser.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    if data.name is not None:
        user.name = data.name
    if data.role is not None:
        user.role = data.role
    if data.active is not None:
        user.active = 1 if data.active else 0
    if data.password is not None:
        user.password_hash = hash_password(data.password)
    
    await db.commit()
    await db.refresh(user)
    
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "last_login": user.last_login,
    }


@router.delete("/users/{user_id}")
async def delete_admin_user(
    user_id: int,
    admin: AdminUser = Depends(require_superadmin),
    db: AsyncSession = Depends(get_master_db),
):
    """Delete an admin user."""
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    
    result = await db.execute(
        select(AdminUser).where(AdminUser.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    await db.delete(user)
    await db.commit()
    
    return {"success": True}
