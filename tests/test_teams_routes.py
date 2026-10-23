"""
Route tests for /api/teams -- team CRUD.

Mock-based, house style (tests/conftest.py): reads are open to any
authenticated user; writes need superuser/admin, and a superuser may only
manage teams at the sites they belong to (FakeUser site_ids default [1]).
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql.dml import Delete

from app.models.team import Team
from app.models.user import User
from app.services.team_rules import (
    MEMBER_NOT_AT_SITE_DETAIL,
    TEAM_NOT_FOUND_DETAIL,
    TEAM_SITE_ACCESS_DETAIL,
    team_delete_strands_projects_detail,
)
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_user(user_id: int) -> User:
    return User(id=user_id, email=f"u{user_id}@example.com", first_name="A", last_name="B")


def make_team(
    team_id: int = 3,
    site_id: int = 1,
    name: str = "Upstream",
    members: list[User] | None = None,
    **fields,
) -> Team:
    return Team(
        id=team_id,
        site_id=site_id,
        name=name,
        description=fields.get("description"),
        color=fields.get("color"),
        active=fields.get("active", True),
        created_at=STAMP,
        updated_at=STAMP,
        members=list(members or []),
    )


def added(db, model):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]


def compiled(db, index: int = 0) -> str:
    statement = db.execute.await_args_list[index].args[0]
    return " ".join(str(statement.compile(compile_kwargs={"literal_binds": True})).split())


def loader_strategies(db, index: int = 0) -> dict[str, str]:
    """A statement's loader options as {"Team.members -> User.sites": "noload", ...}."""
    statement = db.execute.await_args_list[index].args[0]
    return {
        " -> ".join(str(attr) for attr in element.path.natural_path[1::2]): dict(
            element.strategy or ()
        )["lazy"]
        for option in statement._with_options
        for element in option.context
    }


# Reads load members for member_ids only, not each member's own collections.
READ_LOADERS = {
    "Team.members": "selectin",
    "Team.members -> User.sites": "noload",
    "Team.members -> User.skills": "noload",
    "Team.members -> User.teams": "noload",
}


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj, attribute_names=None):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        obj.created_at = obj.created_at or STAMP
        obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_teams_in_one_query_ordered_by_site_then_name(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user", site_ids=[1, 2]))
    mock_db_session.execute.return_value = scalars_result(
        [
            make_team(3, 1, "Analytics", [make_user(7), make_user(4)]),
            make_team(4, 2, "Upstream", active=False),
        ]
    )

    response = await client.get("/api/teams")

    assert response.status_code == 200, response.text
    body = response.json()
    assert [t["id"] for t in body] == [3, 4]
    assert body[0]["member_ids"] == [4, 7]
    assert body[1]["active"] is False
    assert mock_db_session.execute.await_count == 1
    sql = compiled(mock_db_session)
    assert "ORDER BY teams.site_id, teams.name" in sql
    assert "WHERE teams.site_id IN (1, 2)" in sql  # the visible sites
    assert loader_strategies(mock_db_session) == READ_LOADERS


@pytest.mark.asyncio
async def test_list_teams_filters_by_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user", site_ids=[2]))
    mock_db_session.execute.return_value = scalars_result([])

    response = await client.get("/api/teams?siteId=2")

    assert response.status_code == 200
    assert response.json() == []
    assert "teams.site_id = 2" in compiled(mock_db_session)


@pytest.mark.asyncio
async def test_get_team(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalar_result(
        make_team(3, 1, "Upstream", [make_user(5)], description="Cell culture", color="#112233")
    )

    response = await client.get("/api/teams/3")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Upstream"
    assert body["description"] == "Cell culture"
    assert body["color"] == "#112233"
    assert body["member_ids"] == [5]
    assert body["created_at"].startswith("2026-01-01T12:00:00")
    assert loader_strategies(mock_db_session) == READ_LOADERS


@pytest.mark.asyncio
async def test_get_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.get("/api/teams/99")

    assert response.status_code == 404
    assert response.json()["detail"] == TEAM_NOT_FOUND_DETAIL


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_creates_a_team_with_members(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    members = [make_user(4), make_user(7)]
    db_assigns_ids.execute.side_effect = [
        scalar_result(2),  # the site exists
        scalar_result(None),  # the name is free at the site
        scalars_result(members),  # the members belong to the site
    ]

    response = await client.post(
        "/api/teams",
        json={
            "site_id": 2,
            "name": "  Upstream  ",
            "description": "Cell culture",
            "color": "#112233",
            "member_ids": [7, 4],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == 42
    assert body["site_id"] == 2
    assert body["name"] == "Upstream"
    assert body["description"] == "Cell culture"
    assert body["color"] == "#112233"
    assert body["active"] is True
    assert body["member_ids"] == [4, 7]
    (team,) = added(db_assigns_ids, Team)
    assert team.members == members
    db_assigns_ids.commit.assert_awaited_once()
    db_assigns_ids.refresh.assert_awaited_with(team, attribute_names=["members"])


@pytest.mark.asyncio
async def test_superuser_creates_a_team_at_their_site_without_members(
    authed_client, db_assigns_ids
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db_assigns_ids.execute.side_effect = [scalar_result(1), scalar_result(None)]

    response = await client.post("/api/teams", json={"site_id": 1, "name": "Analytics"})

    assert response.status_code == 201, response.text
    assert response.json()["member_ids"] == []
    assert db_assigns_ids.execute.await_count == 2


@pytest.mark.asyncio
async def test_superuser_cannot_create_a_team_at_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(2)]

    response = await client.post("/api/teams", json={"site_id": 2, "name": "Analytics"})

    assert response.status_code == 403
    assert response.json()["detail"] == TEAM_SITE_ACCESS_DETAIL
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_plain_user_cannot_create_a_team(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.post("/api/teams", json={"site_id": 1, "name": "Analytics"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_team_at_an_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post("/api/teams", json={"site_id": 9, "name": "Analytics"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"


@pytest.mark.asyncio
async def test_create_team_with_a_blank_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post("/api/teams", json={"site_id": 1, "name": "   "})

    assert response.status_code == 400
    assert isinstance(response.json()["detail"], str)
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_team_with_a_taken_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(1), scalar_result(8)]

    response = await client.post("/api/teams", json={"site_id": 1, "name": "Upstream"})

    assert response.status_code == 400
    assert response.json()["detail"] == 'A team named "Upstream" already exists at this site'
    sql = compiled(mock_db_session, 1)
    assert "teams.site_id = 1" in sql
    assert "teams.name = 'Upstream'" in sql
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_team_with_a_member_outside_the_site_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(1),
        scalar_result(None),
        scalars_result([make_user(4)]),  # user 7 is not at site 1
    ]

    response = await client.post(
        "/api/teams", json={"site_id": 1, "name": "Upstream", "member_ids": [4, 7]}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == MEMBER_NOT_AT_SITE_DETAIL
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_team_losing_a_unique_race_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(1), scalar_result(None)]
    mock_db_session.commit.side_effect = IntegrityError("INSERT", {}, Exception("duplicate"))

    response = await client.post("/api/teams", json={"site_id": 1, "name": "Upstream"})

    assert response.status_code == 400
    assert response.json()["detail"] == 'A team named "Upstream" already exists at this site'
    mock_db_session.rollback.assert_awaited()


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_team_renames_and_replaces_members(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    team = make_team(3, 1, "Upstream", [make_user(4)])
    new_members = [make_user(5), make_user(6)]
    db_assigns_ids.execute.side_effect = [
        scalar_result(team),
        scalar_result(None),  # the new name is free at the site
        scalars_result(new_members),
    ]

    response = await client.put(
        "/api/teams/3", json={"name": "Downstream", "member_ids": [5, 6], "active": False}
    )

    assert response.status_code == 200, response.text
    assert team.name == "Downstream"
    assert team.members == new_members
    assert team.active is False
    assert response.json()["member_ids"] == [5, 6]
    db_assigns_ids.commit.assert_awaited_once()
    db_assigns_ids.refresh.assert_awaited_with(team, attribute_names=["members"])


@pytest.mark.asyncio
async def test_update_team_explicit_null_clears_description(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    team = make_team(3, 1, "Upstream", [make_user(4)], description="Old", color="#112233")
    db_assigns_ids.execute.side_effect = [scalar_result(team)]

    response = await client.put("/api/teams/3", json={"description": None})

    assert response.status_code == 200, response.text
    assert team.description is None
    assert team.color == "#112233"
    assert [u.id for u in team.members] == [4]
    assert db_assigns_ids.execute.await_count == 1  # no name or member query


@pytest.mark.asyncio
async def test_superuser_cannot_update_a_team_at_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_team(3, 2))]

    response = await client.put("/api/teams/3", json={"name": "Renamed"})

    assert response.status_code == 403
    assert response.json()["detail"] == TEAM_SITE_ACCESS_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.put("/api/teams/99", json={"name": "Renamed"})

    assert response.status_code == 404
    assert response.json()["detail"] == TEAM_NOT_FOUND_DETAIL


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_team(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_team(3, 1)),
        scalar_result(0),  # no project stranded
        MagicMock(),
    ]

    response = await client.delete("/api/teams/3")

    assert response.status_code == 204
    assert "tag_teams.team_id = 3" in compiled(mock_db_session, 1)
    statement = mock_db_session.execute.await_args_list[2].args[0]
    assert isinstance(statement, Delete)
    assert "teams.id = 3" in compiled(mock_db_session, 2)
    assert statement.get_execution_options()["synchronize_session"] is False
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 3])
async def test_delete_team_stranding_tagged_projects_is_a_409(
    authed_client, mock_db_session, count
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(make_team(3, 1)), scalar_result(count)]

    response = await client.delete("/api/teams/3")

    assert response.status_code == 409
    assert response.json()["detail"] == team_delete_strands_projects_detail(count)
    assert mock_db_session.execute.await_count == 2
    assert not any(
        isinstance(call.args[0], Delete) for call in mock_db_session.execute.await_args_list
    )
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_team_stranding_a_project_by_a_field_item_is_a_409(
    authed_client, mock_db_session
):
    # A project holding a dropdown item limited to this team and another one at
    # the site, while not in that other team, would be stranded like a tag.
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(make_team(3, 1)), scalar_result(1)]

    response = await client.delete("/api/teams/3")

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "1 project would keep a tag or field item limited to other teams; "
        "move it to another of those teams or widen the tag or item first"
    )
    strand_sql = compiled(mock_db_session, 1)
    assert "project_field_selections" in strand_sql
    assert "project_field_option_teams.team_id = 3" in strand_sql
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.delete("/api/teams/99")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_superuser_cannot_delete_a_team_at_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_team(3, 2))]

    response = await client.delete("/api/teams/3")

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1
    mock_db_session.commit.assert_not_awaited()
