"""
Lists of people offered to pick from (2.1.0).

``shareable_users_statement`` is the one definition of "the people someone
working at these sites may name": the active members of the given sites plus
every active user whose role sees every site (the administrators, and any
role allowing ``sites.view_all``) -- those are often given one ``user_sites``
row only, so membership alone would hide them on every other site. It feeds
the @-mention picker (``GET /kanban/sites/{id}/mentionable-users``, one site)
and the dashboard people picker and its check (``GET
/dashboards/shareable-users``, ``PUT/POST /dashboards``, the caller's visible
sites). Callers add their own columns and ordering.
"""

from collections.abc import Iterable

from sqlalchemy import Select, or_, select

from app.models.rbac import Role, RolePermission
from app.models.user import User, UserSite
from app.services.permissions import ADMIN_ROLE_KEY


def shareable_users_statement(site_ids: Iterable[int] | None) -> Select[tuple[User]]:
    """
    Active users who are members of ``site_ids`` or whose role sees every site.

    ``None`` = no site restriction (the caller sees every site): every active
    user. Each user appears once (``IN`` subqueries, no join).
    """
    statement = select(User).where(User.active == 1)
    if site_ids is None:
        return statement
    site_member_ids = select(UserSite.user_id).where(UserSite.site_id.in_(sorted(set(site_ids))))
    all_sites_roles = (
        select(Role.key)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(RolePermission.permission == "sites.view_all", RolePermission.mode == "allow")
    )
    return statement.where(
        or_(
            User.id.in_(site_member_ids),
            User.role == ADMIN_ROLE_KEY,
            User.role.in_(all_sites_roles),
        )
    )
