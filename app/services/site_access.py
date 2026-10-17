"""
Site-level write access for multi-site data (company events, equipment).

Role gating itself is done by require_superuser on the route; these helpers
decide which sites a superuser may write to. They only read ``is_admin`` and
``site_ids``, so they work with both the ORM User and the session user.
"""

from collections.abc import Iterable

from fastapi import HTTPException

from app.models.user import User


def can_access_sites(user: User, site_ids: Iterable[int]) -> bool:
    """
    Whether the user may write data for every given site.

    Admins may write to any site; superusers only to sites they belong to.
    (Role gating itself is done by require_superuser on the route.)
    """
    if user.is_admin:
        return True
    allowed = set(user.site_ids or [])
    return all(site_id in allowed for site_id in site_ids)


def ensure_site_access(user: User, site_ids: Iterable[int], detail: str) -> None:
    """Raise 403 unless the user may write data for every given site."""
    if not can_access_sites(user, site_ids):
        raise HTTPException(status_code=403, detail=detail)
