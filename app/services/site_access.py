"""
Site-level access for site-scoped data (calendar, equipment, teams, users).

``visible_site_ids`` is the live, permission-aware set of sites a user may
see (``sites.view_all`` = every site, otherwise the user's ``user_sites``).
Site-scoped writes are evaluated within it: the route gates the permission key
(``require_permission``), and ``can_access_sites`` / ``ensure_site_access``
decide whether the user may act on the given sites. They only read
``permissions`` and ``id``, so they work with both the ORM User and the
session user.
"""

from collections.abc import Iterable

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserSite

# request.state attribute holding (user id, visible set) for this request.
_VISIBLE_SITES_STATE = "visible_site_ids"


async def _load_user_site_ids(db: AsyncSession, user_id: int) -> frozenset[int]:
    """The user's live ``user_sites`` rows (one query)."""
    rows = await db.execute(select(UserSite.site_id).where(UserSite.user_id == user_id))
    return frozenset(rows.scalars().all())


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

    visible = await _load_user_site_ids(db, user.id)
    setattr(state, _VISIBLE_SITES_STATE, (user.id, visible))
    return visible


async def can_access_sites(
    request: Request, db: AsyncSession, user: User, site_ids: Iterable[int]
) -> bool:
    """
    Whether every given site is visible to the user (no sites: True, no query).

    With ``sites.view_all`` every site is; otherwise only the user's live sites.
    """
    wanted = list(site_ids)
    if not wanted:
        return True
    visible = await visible_site_ids(request, db, user)
    return visible is None or all(site_id in visible for site_id in wanted)


async def ensure_site_access(
    request: Request, db: AsyncSession, user: User, site_ids: Iterable[int], detail: str
) -> None:
    """Raise 403 ``detail`` unless every given site is visible to the user."""
    if not await can_access_sites(request, db, user, site_ids):
        raise HTTPException(status_code=403, detail=detail)
