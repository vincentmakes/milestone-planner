"""
API routers package.
"""

from app.routers import (
    admin,
    admin_organizations,
    assignments,
    auth,
    custom_columns,
    equipment,
    export,
    health,
    mpp_import,
    notes,
    predefined_phases,
    projects,
    settings,
    sites,
    skills,
    staff,
    users,
    vacations,
)

__all__ = [
    "health",
    "settings",
    "predefined_phases",
    "sites",
    "staff",
    "equipment",
    "vacations",
    "notes",
    "auth",
    "users",
    "projects",
    "assignments",
    "mpp_import",
    "export",
    "admin",
    "custom_columns",
    "skills",
    "admin_organizations",
]
