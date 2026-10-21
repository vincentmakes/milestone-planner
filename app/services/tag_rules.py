"""
Project-tag rules shared by the project and tag routers.

- A tag restricted to some sites (``all_sites = false``) is only applicable to
  projects at one of those sites; a project without a site may only carry
  tags available at every site.
- A tag linked to teams at a site applies to a project at that site only when
  the project shares one of those teams (a team-less project does not
  qualify). Team rows at other sites do not restrict it there.
- A single-select tag group allows at most one of its tags per project.

``validate_project_tags`` enforces all three when a project's tags are written. The
count helpers back the 409s that keep existing data consistent when a group or
tag definition changes underneath projects that already use it.

Error details are plain strings (the frontend renders ``detail`` as text).
"""

from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload

from app.models.project import Project
from app.models.tag import ProjectTag, Tag
from app.models.team import ProjectTeam, Team


def _projects(count: int) -> str:
    return "1 project" if count == 1 else f"{count} projects"


def tag_not_applicable_detail(tag_name: str) -> str:
    return f'The tag "{tag_name}" is not available at this project\'s site'


def tag_not_applicable_to_teams_detail(tag_name: str) -> str:
    return f'The tag "{tag_name}" is limited to teams this project is not part of'


def single_select_detail(group_name: str) -> str:
    return f'Only one tag from the group "{group_name}" can be assigned to a project'


def multiple_tags_conflict_detail(count: int) -> str:
    verb = "has" if count == 1 else "have"
    return f"{_projects(count)} {verb} more than one tag from this group"


def group_peer_conflict_detail(count: int) -> str:
    verb = "has" if count == 1 else "have"
    return f"{_projects(count)} already {verb} another tag from this group"


def other_sites_conflict_detail(count: int) -> str:
    where = "at another site uses" if count == 1 else "at other sites use"
    return f"{_projects(count)} {where} this tag"


def other_teams_conflict_detail(count: int) -> str:
    verb = "uses" if count == 1 else "use"
    return f"{_projects(count)} outside these teams {verb} this tag"


def tag_applies_to_site(tag: Tag, site_id: int | None) -> bool:
    """Whether ``tag`` may be carried by a project at ``site_id``."""
    if tag.all_sites:
        return True
    return site_id is not None and site_id in tag.site_ids


def tag_applies_to_project(tag: Tag, site_id: int | None, team_ids: Iterable[int]) -> bool:
    """Whether ``tag`` may be carried by a project at ``site_id`` in teams ``team_ids``."""
    if not tag_applies_to_site(tag, site_id):
        return False
    scoped = {team.id for team in tag.teams if team.site_id == site_id}
    return not scoped or bool(scoped & set(team_ids))


async def validate_project_tags(
    db: AsyncSession,
    site_id: int | None,
    tag_ids: list[int],
    team_ids: Iterable[int] = (),
) -> list[Tag]:
    """
    Load the tags for a project at ``site_id`` in teams ``team_ids`` and check the tag rules.

    Unknown ids are dropped silently (deliberate: a What-If replay may carry
    the id of a tag deleted in the meantime). Raises 400 when a tag is not
    available at the project's site, is limited to teams the project is not
    part of, or two tags share a single-select group.
    """
    if not tag_ids:
        return []
    # Tag.sites / Tag.teams loaded explicitly (the checks need them): do not rely
    # on the relationship default, which a response loader may override (noload).
    result = await db.execute(
        select(Tag)
        .options(selectinload(Tag.sites), selectinload(Tag.teams))
        .where(Tag.id.in_(set(tag_ids)))
        .order_by(Tag.id)
    )
    tags = list(result.scalars().all())

    for tag in tags:
        if not tag_applies_to_site(tag, site_id):
            raise HTTPException(status_code=400, detail=tag_not_applicable_detail(tag.name))

    project_team_ids = set(team_ids)
    for tag in tags:
        if not tag_applies_to_project(tag, site_id, project_team_ids):
            raise HTTPException(
                status_code=400, detail=tag_not_applicable_to_teams_detail(tag.name)
            )

    seen_groups: set[int] = set()
    for tag in tags:
        group = tag.group
        if group is None or not group.single_select:
            continue
        if group.id in seen_groups:
            raise HTTPException(status_code=400, detail=single_select_detail(group.name))
        seen_groups.add(group.id)

    return tags


async def count_projects_with_multiple_group_tags(db: AsyncSession, group_id: int) -> int:
    """Projects holding two or more tags of ``group_id``."""
    per_project = (
        select(ProjectTag.project_id)
        .join(Tag, Tag.id == ProjectTag.tag_id)
        .where(Tag.group_id == group_id)
        .group_by(ProjectTag.project_id)
        .having(func.count() > 1)
        .subquery()
    )
    result = await db.execute(select(func.count()).select_from(per_project))
    return int(result.scalar() or 0)


async def count_projects_with_group_peer(db: AsyncSession, tag_id: int, group_id: int) -> int:
    """Projects holding ``tag_id`` together with another tag of ``group_id``."""
    peer_link = aliased(ProjectTag)
    peer_tag = aliased(Tag)
    query = (
        select(func.count(func.distinct(ProjectTag.project_id)))
        .select_from(ProjectTag)
        .join(peer_link, peer_link.project_id == ProjectTag.project_id)
        .join(peer_tag, peer_tag.id == peer_link.tag_id)
        .where(
            ProjectTag.tag_id == tag_id,
            peer_tag.group_id == group_id,
            peer_tag.id != tag_id,
        )
    )
    result = await db.execute(query)
    return int(result.scalar() or 0)


async def count_projects_outside_sites(db: AsyncSession, tag_id: int, site_ids: list[int]) -> int:
    """Projects using ``tag_id`` that are not at one of ``site_ids`` (incl. site-less ones)."""
    outside = Project.site_id.is_(None)
    if site_ids:
        outside = or_(outside, Project.site_id.not_in(site_ids))
    query = (
        select(func.count(func.distinct(Project.id)))
        .select_from(Project)
        .join(ProjectTag, and_(ProjectTag.project_id == Project.id, ProjectTag.tag_id == tag_id))
        .where(outside)
    )
    result = await db.execute(query)
    return int(result.scalar() or 0)


async def count_projects_outside_teams(db: AsyncSession, tag_id: int, teams: list[Team]) -> int:
    """
    Projects using ``tag_id`` at a site of ``teams`` that share none of ``teams``.

    These are the projects a team restriction of the tag would leave holding a
    tag they no longer qualify for. No query for no teams.
    """
    if not teams:
        return 0
    site_ids = {team.site_id for team in teams}
    team_ids = {team.id for team in teams}
    shares_a_team = exists().where(
        ProjectTeam.project_id == Project.id, ProjectTeam.team_id.in_(team_ids)
    )
    query = (
        select(func.count(func.distinct(Project.id)))
        .select_from(Project)
        .join(ProjectTag, and_(ProjectTag.project_id == Project.id, ProjectTag.tag_id == tag_id))
        .where(Project.site_id.in_(site_ids), not_(shares_a_team))
    )
    result = await db.execute(query)
    return int(result.scalar() or 0)
