"""
More route tests for /api/users: the list and detail reads, user creation
(duplicate email, unknown sites/skills), site/skill replacement on update and
the remaining self/system-account guards of update, delete and toggle-active.

The superuser/admin permission matrix and session revocation are covered in
tests/test_users_routes.py. Mock-based, house style (tests/conftest.py).
"""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.sql.dml import Delete

from app.models.site import Site
from app.models.skill import Skill, UserSkill
from app.models.user import User, UserSite
from app.services.encryption import verify_user_password
from app.services.session import SessionService
from tests.conftest import FakeUser
from tests.support import _ScalarList, scalar_result, scalars_result, unique_scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
SITE_1 = Site(id=1, name="Winterthur")
SITE_2 = Site(id=2, name="Basel")
SKILL_3 = Skill(id=3, name="HPLC", color="#123456")


def make_user(user_id: int, role: str = "user", *, is_system: int = 0, active: int = 1) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password="$2b$12$existinghashexistinghashexistinghashexistinghashexist",
        first_name="First",
        last_name=f"Last{user_id}",
        job_title="Engineer",
        role=role,
        max_capacity=80,
        active=active,
        is_system=is_system,
        created_at=STAMP,
    )
    user.sites = []
    user.skills = []
    return user


class SiteAwareUser(FakeUser):
    """FakeUser plus the ``sites`` list SessionUser exposes (site-assign checks read it)."""

    @property
    def sites(self):
        return [SimpleNamespace(id=i, name=f"Site {i}") for i in self._site_ids]


def unique_scalars_result(values):
    """``result.unique().scalars().all()`` (eager-loaded list queries)."""
    result = MagicMock()
    result.unique.return_value.scalars.return_value = _ScalarList(values)
    return result


def sql(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


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
async def test_list_users_paginates_and_hides_disabled(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    alice = make_user(7)
    alice.sites = [SITE_2, SITE_1]
    alice.skills = [SKILL_3]
    alice.is_system = None
    mock_db_session.execute.side_effect = [scalar_result(12), unique_scalars_result([alice])]

    response = await client.get("/api/users?offset=10&limit=5")

    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["offset"], body["limit"]) == (12, 10, 5)
    (item,) = body["items"]
    assert item["site_ids"] == [1, 2]  # sorted by id
    assert item["site_names"] == ["Winterthur", "Basel"]
    assert item["skills"] == [{"id": 3, "name": "HPLC", "color": "#123456"}]
    assert item["is_system"] == 0  # NULL normalised
    count_sql = sql(mock_db_session.execute.await_args_list[0].args[0])
    list_sql = sql(mock_db_session.execute.await_args_list[1].args[0])
    assert "users.active = 1" in count_sql
    assert "LIMIT 5 OFFSET 10" in list_sql


@pytest.mark.asyncio
async def test_list_users_can_include_disabled(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None), unique_scalars_result([])]

    response = await client.get("/api/users?includeDisabled=true")

    assert response.status_code == 200
    assert response.json()["total"] == 0  # NULL count -> 0
    assert "WHERE" not in sql(mock_db_session.execute.await_args_list[0].args[0])


@pytest.mark.asyncio
async def test_list_users_rejects_oversized_page(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.get("/api/users?limit=500")

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_list_users_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.get("/api/users")).status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_user_detail_lists_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    target = make_user(7)
    target.sites = [SITE_2, SITE_1]
    mock_db_session.execute.return_value = unique_scalar_result(target)

    response = await client.get("/api/users/7")

    assert response.status_code == 200
    body = response.json()
    assert body["sites"] == [{"id": 1, "name": "Winterthur"}, {"id": 2, "name": "Basel"}]
    assert body["site_ids"] == [1, 2]
    assert "password" not in body


@pytest.mark.asyncio
async def test_get_user_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = unique_scalar_result(None)

    response = await client.get("/api/users/7")

    assert response.status_code == 404
    assert response.json()["detail"] == "User not found"


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


def _create_body(**overrides):
    body = {
        "email": "new@example.com",
        "password": "s3cret-pass",
        "first_name": "New",
        "last_name": "Person",
        "role": "superuser",
        "max_capacity": 60,
        "site_ids": [2, 1, 2],
        "skill_ids": [3],
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_create_user_links_sites_and_skills(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(None),  # email free
        scalars_result([SITE_1, SITE_2]),
        scalars_result([SKILL_3]),
    ]

    async def flush():
        (user,) = added(mock_db_session, User)
        user.id = 55

    async def refresh(obj):
        obj.created_at = STAMP

    mock_db_session.flush.side_effect = flush
    mock_db_session.refresh.side_effect = refresh

    response = await client.post("/api/users", json=_create_body())

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["role"], body["max_capacity"], body["active"]) == (
        55,
        "superuser",
        60,
        1,
    )
    assert body["site_ids"] == [1, 2]
    assert body["skills"] == [{"id": 3, "name": "HPLC", "color": "#123456"}]
    (user,) = added(mock_db_session, User)
    assert verify_user_password("s3cret-pass", user.password)
    # De-duplicated, request order kept (a repeated id would hit the PK)
    assert [(link.user_id, link.site_id) for link in added(mock_db_session, UserSite)] == [
        (55, 2),
        (55, 1),
    ]
    assert [(link.user_id, link.skill_id) for link in added(mock_db_session, UserSkill)] == [
        (55, 3)
    ]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_user_duplicate_email_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(make_user(7))]

    response = await client.post("/api/users", json=_create_body())

    assert response.status_code == 400
    assert response.json()["detail"] == "A user with this email already exists"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_user_unknown_site_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(None), scalars_result([SITE_1])]

    response = await client.post("/api/users", json=_create_body(site_ids=[1, 9, 8]))

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown site: 9, 8"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_user_unknown_skill_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(None),
        scalars_result([SITE_1, SITE_2]),
        scalars_result([]),
    ]

    response = await client.post("/api/users", json=_create_body(skill_ids=[4]))

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown skill: 4"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [{"email": "nope"}, {"password": "short"}, {"role": "owner"}, {"max_capacity": 0}],
)
async def test_create_user_validates_body(authed_client, mock_db_session, overrides):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post("/api/users", json=_create_body(**overrides))

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Update: sites, skills, email, self/system guards
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_replaces_sites_and_skills(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    target.sites = [SITE_1]
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalars_result([SITE_2]),  # _load_sites
        MagicMock(),  # DELETE user_sites
        scalars_result([SKILL_3]),  # _load_skills
        MagicMock(),  # DELETE user_skills
    ]

    response = await client.put("/api/users/7", json={"site_ids": [2], "skill_ids": [3]})

    assert response.status_code == 200
    body = response.json()
    assert body["site_ids"] == [2]
    assert [s["id"] for s in body["skills"]] == [3]
    calls = mock_db_session.execute.await_args_list
    assert isinstance(calls[2].args[0], Delete) and "user_sites" in str(calls[2].args[0])
    assert isinstance(calls[4].args[0], Delete) and "user_skills" in str(calls[4].args[0])
    assert [(x.user_id, x.site_id) for x in added(mock_db_session, UserSite)] == [(7, 2)]
    assert [(x.user_id, x.skill_id) for x in added(mock_db_session, UserSkill)] == [(7, 3)]
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_update_with_unknown_site_400(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [unique_scalar_result(make_user(7)), scalars_result([])]

    response = await client.put("/api/users/7", json={"site_ids": [9]})

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown site: 9"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_assigns_only_own_sites(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(SiteAwareUser(5, "superuser"))  # member of site 1 only
    mock_db_session.execute.side_effect = [unique_scalar_result(make_user(7))]

    response = await client.put("/api/users/7", json={"site_ids": [1, 2]})

    assert response.status_code == 403
    assert "site 2 not allowed" in response.json()["detail"]
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_assigns_own_site(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(SiteAwareUser(5, "superuser"))
    mock_db_session.execute.side_effect = [
        unique_scalar_result(make_user(7)),
        scalars_result([SITE_1]),
        MagicMock(),
    ]

    response = await client.put("/api/users/7", json={"site_ids": [1]})

    assert response.status_code == 200
    assert response.json()["site_ids"] == [1]


@pytest.mark.asyncio
async def test_admin_changes_email(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    mock_db_session.execute.side_effect = [unique_scalar_result(target), scalar_result(None)]

    response = await client.put("/api/users/7", json={"email": "renamed@example.com"})

    assert response.status_code == 200
    assert target.email == "renamed@example.com"
    dup_check = sql(mock_db_session.execute.await_args_list[1].args[0])
    assert "users.id != 7" in dup_check


@pytest.mark.asyncio
async def test_update_email_taken_by_another_user_400(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7)
    mock_db_session.execute.side_effect = [
        unique_scalar_result(target),
        scalar_result(make_user(8)),
    ]

    response = await client.put("/api/users/7", json={"email": "u8@example.com"})

    assert response.status_code == 400
    assert target.email == "u7@example.com"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_404(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [unique_scalar_result(None)]

    response = await client.put("/api/users/7", json={"first_name": "X"})

    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"role": "user"}, "Cannot change role of system administrator"),
        ({"active": 0}, "Cannot deactivate system administrator"),
    ],
)
async def test_system_admin_role_and_active_are_locked(
    authed_client, mock_db_session, destroy_sessions, payload, detail
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    system = make_user(2, "admin", is_system=1)
    mock_db_session.execute.side_effect = [unique_scalar_result(system)]

    response = await client.put("/api/users/2", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == detail
    assert (system.role, system.active) == ("admin", 1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ({"role": "superuser"}, "Cannot change your own admin role"),
        ({"active": 0}, "Cannot deactivate your own account"),
    ],
)
async def test_admin_cannot_demote_or_deactivate_self(
    authed_client, mock_db_session, destroy_sessions, payload, detail
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    me = make_user(1, "admin")
    mock_db_session.execute.side_effect = [unique_scalar_result(me)]

    response = await client.put("/api/users/1", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"] == detail
    assert (me.role, me.active) == ("admin", 1)
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Delete / toggle-active guards
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_cannot_delete_self(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.delete("/api/users/1")

    assert response.status_code == 400
    assert response.json()["detail"] == "Cannot delete your own account"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_unknown_user_404(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/users/7")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_system_admin_403(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(make_user(2, "admin", is_system=1))

    response = await client.delete("/api/users/2")

    assert response.status_code == 403
    assert "system administrator" in response.json()["detail"]
    mock_db_session.delete.assert_not_awaited()
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_active_self_400(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.put("/api/users/1/toggle-active")

    assert response.status_code == 400
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_active_unknown_user_404(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/users/7/toggle-active")

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_active_reenables_inactive_system_admin(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    system = make_user(2, "admin", is_system=1, active=0)
    mock_db_session.execute.return_value = scalar_result(system)

    response = await client.put("/api/users/2/toggle-active")

    assert response.status_code == 200
    assert system.active == 1
    assert response.json()["active"] == 1
    destroy_sessions.assert_not_awaited()
