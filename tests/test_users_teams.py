"""
Route tests for team membership on the user and staff APIs.

/api/users carries ``team_ids`` / ``team_names`` and accepts ``team_ids`` on
create and update: a user's teams must be at the user's sites, a superuser may
only assign teams at sites they belong to, and removing a user from a site
drops them from that site's teams. /api/staff rows (one per user-site pair)
carry the teams at the row's site; the staff detail carries all of them.

Mock-based, house style (tests/conftest.py).
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.sql.dml import Delete

from app.models.site import Site
from app.models.team import Team, TeamMember
from app.models.user import User
from app.services.session import SessionService
from app.services.team_rules import TEAM_SITE_ACCESS_DETAIL, team_outside_user_sites_detail
from tests.conftest import FakeUser
from tests.support import _ScalarList, scalar_result, scalars_result, unique_scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
SITE_1 = Site(id=1, name="Winterthur")
SITE_2 = Site(id=2, name="Basel")


def make_team(team_id: int, site_id: int, name: str) -> Team:
    return Team(id=team_id, site_id=site_id, name=name)


def make_user(user_id: int, *, sites=(), teams=()) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password="$2b$12$existinghashexistinghashexistinghashexistinghashexist",
        first_name="First",
        last_name=f"Last{user_id}",
        job_title="Engineer",
        role="user",
        max_capacity=100,
        active=1,
        is_system=0,
        created_at=STAMP,
    )
    user.sites = list(sites)
    user.skills = []
    user.teams = list(teams)
    return user


def unique_scalars_result(values):
    result = MagicMock()
    result.unique.return_value.scalars.return_value = _ScalarList(values)
    return result


def unique_rows_result(rows):
    result = MagicMock()
    result.unique.return_value.all.return_value = rows
    return result


def sql(stmt) -> str:
    return " ".join(str(stmt.compile(compile_kwargs={"literal_binds": True})).split())


def added(db, model):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]


@pytest.fixture
def destroy_sessions():
    with patch.object(SessionService, "destroy_user_sessions", new_callable=AsyncMock) as mock:
        mock.return_value = 0
        yield mock


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_list_carries_team_ids_and_names(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    alice = make_user(
        7, sites=[SITE_1, SITE_2], teams=[make_team(9, 2, "QC"), make_team(4, 1, "Upstream")]
    )
    mock_db_session.execute.side_effect = [scalar_result(1), unique_scalars_result([alice])]

    response = await client.get("/api/users")

    assert response.status_code == 200
    (item,) = response.json()["items"]
    assert item["team_ids"] == [4, 9]
    assert item["team_names"] == ["Upstream", "QC"]


@pytest.mark.asyncio
async def test_user_detail_carries_team_ids_and_names(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    target = make_user(7, sites=[SITE_1], teams=[make_team(4, 1, "Upstream")])
    mock_db_session.execute.return_value = unique_scalar_result(target)

    response = await client.get("/api/users/7")

    assert response.status_code == 200
    body = response.json()
    assert (body["team_ids"], body["team_names"]) == ([4], ["Upstream"])


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


def _create_body(**overrides):
    body = {
        "email": "new@example.com",
        "password": "s3cret-pass",
        "first_name": "New",
        "last_name": "Person",
        "site_ids": [1],
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_user_with_teams_adds_memberships(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    teams = [make_team(4, 1, "Upstream"), make_team(6, 1, "Downstream")]
    mock_db_session.execute.side_effect = [
        scalar_result(None),  # email free
        scalars_result([SITE_1]),
        scalars_result(teams),
    ]

    async def flush():
        (user,) = added(mock_db_session, User)
        user.id = 55

    async def refresh(obj):
        obj.created_at = STAMP

    mock_db_session.flush.side_effect = flush
    mock_db_session.refresh.side_effect = refresh

    response = await client.post("/api/users", json=_create_body(team_ids=[6, 4]))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["team_ids"] == [4, 6]
    assert body["team_names"] == ["Upstream", "Downstream"]
    assert [(m.team_id, m.user_id) for m in added(mock_db_session, TeamMember)] == [
        (4, 55),
        (6, 55),
    ]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_user_with_a_team_outside_their_sites_is_a_400(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(None),
        scalars_result([SITE_1]),
        scalars_result([make_team(9, 2, "QC")]),
    ]

    response = await client.post("/api/users", json=_create_body(team_ids=[9]))

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_user_sites_detail("QC")
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_user_with_an_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(None),
        scalars_result([SITE_1]),
        scalars_result([]),
    ]

    response = await client.post("/api/users", json=_create_body(team_ids=[404]))

    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_replaces_teams(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, sites=[SITE_1, SITE_2], teams=[make_team(4, 1, "Upstream")])
    new_teams = [make_team(6, 1, "Downstream"), make_team(9, 2, "QC")]
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result(new_teams),
        MagicMock(),  # DELETE team_members
    ]

    response = await client.put("/api/users/7", json={"team_ids": [9, 6]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["team_ids"], body["team_names"]) == ([6, 9], ["Downstream", "QC"])
    statement = mock_db_session.execute.await_args_list[2].args[0]
    assert isinstance(statement, Delete)
    assert sql(statement) == "DELETE FROM team_members WHERE team_members.user_id = 7"
    assert [(m.team_id, m.user_id) for m in added(mock_db_session, TeamMember)] == [
        (6, 7),
        (9, 7),
    ]


@pytest.mark.asyncio
async def test_update_with_a_team_outside_the_users_sites_is_a_400(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, sites=[SITE_1])
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([make_team(9, 2, "QC")]),
    ]

    response = await client.put("/api/users/7", json={"team_ids": [9]})

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_user_sites_detail("QC")
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_assign_a_team_at_a_foreign_site(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))  # member of site 1 only
    target = make_user(7, sites=[SITE_1, SITE_2])
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([make_team(9, 2, "QC")]),
    ]

    response = await client.put("/api/users/7", json={"team_ids": [9]})

    assert response.status_code == 403
    assert response.json()["detail"] == TEAM_SITE_ACCESS_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_assigns_a_team_at_their_site(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    target = make_user(7, sites=[SITE_1, SITE_2])
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([make_team(4, 1, "Upstream")]),
        MagicMock(),
    ]

    response = await client.put("/api/users/7", json={"team_ids": [4]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [4]


@pytest.mark.asyncio
async def test_removing_a_site_drops_that_sites_teams(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    upstream, qc = make_team(4, 1, "Upstream"), make_team(9, 2, "QC")
    target = make_user(7, sites=[SITE_1, SITE_2], teams=[upstream, qc])
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([SITE_1]),  # _load_sites
        MagicMock(),  # DELETE user_sites
        MagicMock(),  # DELETE the memberships at the removed site
    ]

    response = await client.put("/api/users/7", json={"site_ids": [1]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["site_ids"], body["team_ids"]) == ([1], [4])
    statement = mock_db_session.execute.await_args_list[3].args[0]
    assert isinstance(statement, Delete)
    assert sql(statement) == (
        "DELETE FROM team_members WHERE team_members.user_id = 7 AND team_members.team_id IN (9)"
    )
    assert added(mock_db_session, TeamMember) == []


@pytest.mark.asyncio
async def test_site_change_keeping_every_team_needs_no_extra_query(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, sites=[SITE_1, SITE_2], teams=[make_team(4, 1, "Upstream")])
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([SITE_1]),
        MagicMock(),  # DELETE user_sites
    ]

    response = await client.put("/api/users/7", json={"site_ids": [1]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [4]
    assert mock_db_session.execute.await_count == 3


# ---------------------------------------------------------------------------
# Staff
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_staff_rows_carry_the_teams_at_their_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    member = make_user(
        7, sites=[SITE_1, SITE_2], teams=[make_team(9, 2, "QC"), make_team(4, 1, "Upstream")]
    )
    loner = make_user(8)
    mock_db_session.execute.side_effect = [
        unique_rows_result([(member, SITE_1), (member, SITE_2), (loner, None)])
    ]

    response = await client.get("/api/staff?includeAllSites=true")

    assert response.status_code == 200
    rows = [(r["id"], r["site_id"], r["team_ids"]) for r in response.json()]
    assert rows == [(7, 1, [4]), (7, 2, [9]), (8, None, [])]


@pytest.mark.asyncio
async def test_staff_detail_carries_all_teams(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    member = make_user(
        7, sites=[SITE_1, SITE_2], teams=[make_team(9, 2, "QC"), make_team(4, 1, "Upstream")]
    )
    mock_db_session.execute.side_effect = [scalar_result(member)]

    response = await client.get("/api/staff/7")

    assert response.status_code == 200
    assert response.json()["team_ids"] == [4, 9]
