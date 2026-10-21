"""
Site-level access for multi-site data (company events, equipment).

Role gating itself is done by require_superuser on the route; these helpers
decide which sites a superuser may write to. They only read ``is_admin`` and
``site_ids``, so they work with both the ORM User and the session user.

``visible_site_ids`` is the live, permission-aware set of sites a user may
see (``sites.view_all`` = every site); the synchronous helpers below move onto
it when the routers are re-gated.
"""

from collections.abc import Iterable

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserSite

# request.state attribute holding (user id, visible set) for this request.
_VISIBLE_SITES_STATE = "visible_site_ids"


async def visible_site_ids(request: Request, db: AsyncSession, user: User) -> frozenset[int] | None:
    """
    The ids of the sites ``user`` may see, or None for every site.

    None with ``sites.view_all`` (the admin holds it), without a query.
    Otherwise the user's live ``user_sites`` rows -- not the session's
    login-time snapshot, so a membership change applies on the next request --
    read once per request and cached on ``request.state``.
    """
    if user.permissions.has("sites.view_all"):
        return None

    state = request.state
    cached = getattr(state, _VISIBLE_SITES_STATE, None)
    if cached is not None and cached[0] == user.id:
        visible: frozenset[int] = cached[1]
        return visible

    rows = await db.execute(select(UserSite.site_id).where(UserSite.user_id == user.id))
    visible = frozenset(rows.scalars().all())
    setattr(state, _VISIBLE_SITES_STATE, (user.id, visible))
    return visible


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
