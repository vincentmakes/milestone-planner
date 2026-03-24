"""
Admin API Router package.

Splits the admin router into focused sub-modules:
- auth: Admin authentication (login, logout, session management)
- tenants: Tenant CRUD, provisioning, database management
- users: Admin user CRUD (superadmin only)
"""

from fastapi import APIRouter

from app.routers.admin.auth import router as auth_router
from app.routers.admin.tenants import router as tenants_router
from app.routers.admin.users import router as users_router

router = APIRouter(prefix="/admin", tags=["Admin"])

router.include_router(auth_router)
router.include_router(tenants_router)
router.include_router(users_router)
