"""
Project-tag rules shared by the project and tag routers.

- A tag restricted to some sites (``all_sites = false``) is only applicable to
  projects at one of those sites; a project without a site may only carry
  tags available at every site.
- A tag linked to teams at a site applies to a project at that site only when
  the project shares one of those teams (a team-less project does not
  qualify). Team rows at other sites do not restrict it there.

``validate_project_tags`` enforces both when a project's tags are written. The
count helpers back the 409s that keep existing data consistent when a tag
definition changes underneath projects that already use it; their generic
forms (``count_linked_projects_outside_*``) serve the project-field items too
(``project_field_rules``), with the same detail texts.

Tag groups became project fields in 2.0.0 (their single-select rule is the
``select`` field type).

Error details are plain strings (the frontend renders ``detail`` as text).
"""

from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute, selectinload

from app.models.project import Project
from app.models.tag import ProjectTag, Tag
from app.models.team import ProjectTeam, Team


def _projects(count: int) -> str:
    return "1 project" if count == 1 else f"{count} projects"


def tag_not_applicable_detail(tag_name: str) -> str:
    return f'The tag "{tag_name}" is not available at this project\'s site'


def tag_not_applicable_to_teams_detail(tag_name: str) -> str:
    return f'The tag "{tag_name}" is limited to teams this project is not part of'


def other_sites_conflict_detail(count: int, noun: str = "tag") -> str:
    where = "at another site uses" if count == 1 else "at other sites use"
    return f"{_projects(count)} {where} this {noun}"


def other_teams_conflict_detail(count: int, noun: str = "tag") -> str:
    verb = "uses" if count == 1 else "use"
    return f"{_projects(count)} outside these teams {verb} this {noun}"


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
    available at the project's site or is limited to teams the project is not
    part of.
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

    return tags


async def count_linked_projects_outside_sites(
    db: AsyncSession,
    link_project: InstrumentedAttribute[int],
    link_entity: InstrumentedAttribute[int],
    entity_id: int,
    site_ids: list[int],
) -> int:
    """
    Projects linked to ``entity_id`` that are not at one of ``site_ids`` (incl. site-less ones).

    ``link_project`` / ``link_entity`` are the two columns of the junction
    (``project_tags``, ``project_field_selections``).
    """
    outside = Project.site_id.is_(None)
    if site_ids:
        outside = or_(outside, Project.site_id.not_in(site_ids))
    query = (
        select(func.count(func.distinct(Project.id)))
        .select_from(Project)
        .join(
            link_project.class_,
            and_(link_project == Project.id, link_entity == entity_id),
        )
        .where(outside)
    )
    result = await db.execute(query)
    return int(result.scalar() or 0)


async def count_linked_projects_outside_teams(
    db: AsyncSession,
    link_project: InstrumentedAttribute[int],
    link_entity: InstrumentedAttribute[int],
    entity_id: int,
    teams: list[Team],
) -> int:
    """
    Projects linked to ``entity_id`` at a site of ``teams`` that share none of ``teams``.

    These are the projects a team restriction of the tag / item would leave
    holding something they no longer qualify for. No query for no teams.
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
        .join(
            link_project.class_,
            and_(link_project == Project.id, link_entity == entity_id),
        )
        .where(Project.site_id.in_(site_ids), not_(shares_a_team))
    )
    result = await db.execute(query)
    return int(result.scalar() or 0)


async def count_projects_outside_sites(db: AsyncSession, tag_id: int, site_ids: list[int]) -> int:
    """Projects using ``tag_id`` that are not at one of ``site_ids`` (incl. site-less ones)."""
    return await count_linked_projects_outside_sites(
        db, ProjectTag.project_id, ProjectTag.tag_id, tag_id, site_ids
    )


async def count_projects_outside_teams(db: AsyncSession, tag_id: int, teams: list[Team]) -> int:
    """
    Projects using ``tag_id`` at a site of ``teams`` that share none of ``teams``.

    These are the projects a team restriction of the tag would leave holding a
    tag they no longer qualify for. No query for no teams.
    """
    return await count_linked_projects_outside_teams(
        db, ProjectTag.project_id, ProjectTag.tag_id, tag_id, teams
    )
