"""
Shared response builder utilities.

Centralizes the common patterns for building API response dicts
from ORM models, eliminating duplication across routers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.site import Site
    from app.models.team import Team
    from app.models.user import User


def get_sorted_sites(user: User) -> list[Site]:
    """Get a user's sites sorted by ID (matches Node.js behavior)."""
    sites = user.sites if hasattr(user, "sites") and user.sites else []
    return sorted(sites, key=lambda s: s.id)


def get_sorted_teams(user: User) -> list[Team]:
    """Get a user's teams sorted by ID."""
    teams = user.teams if hasattr(user, "teams") and user.teams else []
    return sorted(teams, key=lambda t: t.id)


def build_skills_list(user: User) -> list[dict]:
    """Build a skills list from a user's skills relationship."""
    if not hasattr(user, "skills") or not user.skills:
        return []
    return [{"id": skill.id, "name": skill.name, "color": skill.color} for skill in user.skills]


def get_max_capacity(user: User) -> int:
    """Get user's max capacity with fallback."""
    return user.max_capacity if hasattr(user, "max_capacity") else 100


def get_is_resource(user: User) -> bool:
    """Bookable as a resource: the column default (True) until stored False."""
    return getattr(user, "is_resource", None) is not False


def build_user_base(user: User) -> dict:
    """Build common user fields shared across list/detail/staff views."""
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "job_title": user.job_title,
        "role": user.role,
        "max_capacity": get_max_capacity(user),
        "active": user.active,
        "is_resource": get_is_resource(user),
    }
