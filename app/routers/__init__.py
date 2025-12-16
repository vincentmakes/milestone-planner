"""
API routers package.
"""

from app.routers import (
    health,
    settings,
    predefined_phases,
    sites,
    staff,
    equipment,
    vacations,
    notes,
    auth,
    users,
    projects,
    assignments,
    mpp_import,
    export,
    admin,
    custom_columns,
    skills,
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
]
