"""
Site visibility: the sites a user may see, and the checks built on them.

``visible_site_ids`` is the live, permission-aware set of sites a user may
see (``sites.view_all`` = every site, otherwise the user's ``user_sites``).
Every site-scoped read and write is evaluated within it:

- ``can_access_sites`` / ``ensure_site_access`` / ``ensure_site_visible``: the
  given sites (a site parameter, a body ``site_id``, an entity's sites) must
  be visible (403);
- ``ensure_project_visible``: the project's site must be visible (403; a
  site-less project only with ``sites.view_all``);
- ``ensure_equipment_visible``: the equipment must be linked to a visible
  site (404; equipment without a site only with ``sites.view_all``);
- ``person_is_visible`` / ``ensure_person_visible``: oneself, or someone
  sharing a visible site;
- ``visible_sites_clause``: the SQL filter for list reads.

Holders of ``sites.view_all`` pass every check without a query. The helpers
only read ``permissions`` and ``id``, so they work with both the ORM User and
the session user.
"""

from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.equipment import EquipmentSite
from app.models.project import Project
from app.models.user import User, UserSite

SITE_NOT_VISIBLE_DETAIL = "You do not have access to this site"
PROJECT_NOT_VISIBLE_DETAIL = "You do not have access to this project's site"
EQUIPMENT_NOT_FOUND_DETAIL = "Equipment not found"

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


def site_is_visible(visible: frozenset[int] | None, site_id: int | None) -> bool:
    """Whether `site_id` is in the visible set (None = every site, site-less included)."""
    return visible is None or (site_id is not None and site_id in visible)


def visible_sites_clause(column: Any, visible: frozenset[int] | None) -> ColumnElement[bool] | None:
    """``column IN (visible)`` for list reads, or None when every site is visible."""
    if visible is None:
        return None
    return column.in_(sorted(visible))


async def ensure_site_visible(
    request: Request,
    db: AsyncSession,
    user: User,
    site_id: int | None,
    detail: str = SITE_NOT_VISIBLE_DETAIL,
) -> None:
    """403 `detail` unless `site_id` is visible (no site: only with ``sites.view_all``)."""
    if not site_is_visible(await visible_site_ids(request, db, user), site_id):
        raise HTTPException(status_code=403, detail=detail)


async def _load_project_site_id(db: AsyncSession, project_id: int) -> int | None:
    """The project's ``site_id`` (may be NULL), or 404 if the project does not exist."""
    row = (await db.execute(select(Project.site_id).where(Project.id == project_id))).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    site_id: int | None = row[0]
    return site_id


async def ensure_project_visible(
    request: Request, db: AsyncSession, user: User, project_id: int
) -> None:
    """
    403 unless the project's site is visible to the user.

    ``sites.view_all`` passes without a query; anyone else costs one
    ``SELECT site_id`` (404 if the project is missing). A site-less project is
    visible with ``sites.view_all`` only.
    """
    visible = await visible_site_ids(request, db, user)
    if visible is None:
        return
    if not site_is_visible(visible, await _load_project_site_id(db, project_id)):
        raise HTTPException(status_code=403, detail=PROJECT_NOT_VISIBLE_DETAIL)


async def _load_equipment_site_ids(db: AsyncSession, equipment_id: int) -> frozenset[int]:
    """The equipment's linked sites (``equipment_sites`` rows; one query)."""
    rows = await db.execute(
        select(EquipmentSite.site_id).where(EquipmentSite.equipment_id == equipment_id)
    )
    return frozenset(rows.scalars().all())


async def ensure_equipment_visible(
    request: Request, db: AsyncSession, user: User, equipment_id: int
) -> None:
    """
    404 unless the equipment is linked to one of the user's visible sites.

    ``sites.view_all`` passes without a query; anyone else costs one query
    (unknown equipment, or equipment without a site, is a 404 too).
    """
    visible = await visible_site_ids(request, db, user)
    if visible is None:
        return
    if visible.isdisjoint(await _load_equipment_site_ids(db, equipment_id)):
        raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)


async def person_is_visible(request: Request, db: AsyncSession, user: User, person_id: int) -> bool:
    """
    Whether `person_id` is oneself or a member of one of the user's visible sites.

    No query for oneself or with ``sites.view_all``; otherwise the person's
    live ``user_sites`` rows (a person without sites is visible to
    ``sites.view_all`` only).
    """
    if person_id == user.id:
        return True
    visible = await visible_site_ids(request, db, user)
    if visible is None:
        return True
    return not visible.isdisjoint(await _load_user_site_ids(db, person_id))


async def ensure_person_visible(
    request: Request,
    db: AsyncSession,
    user: User,
    person_id: int,
    *,
    status_code: int,
    detail: str,
) -> None:
    """Raise `status_code` / `detail` unless `person_id` is visible (``person_is_visible``)."""
    if not await person_is_visible(request, db, user, person_id):
        raise HTTPException(status_code=status_code, detail=detail)
