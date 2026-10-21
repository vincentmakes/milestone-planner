"""
Route tests for /api/skills — skill CRUD and per-user skill assignment.

Mock-based, house style (tests/conftest.py): reads are open to any
authenticated user; definitions need ``skills.manage``, per-user assignment
``skills.assign`` on a user the caller may edit.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy.sql.dml import Delete

from app.models.skill import Skill, UserSkill
from app.models.user import User
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_skill(skill_id: int = 1, name: str = "Python", color: str = "#112233") -> Skill:
    return Skill(
        id=skill_id,
        name=name,
        description=f"{name} skill",
        color=color,
        created_at=STAMP,
        updated_at=STAMP,
    )


def make_user(user_id: int = 9) -> User:
    return User(id=user_id, email=f"u{user_id}@example.com", first_name="A", last_name="B")


def rows_result(rows):
    """Result of ``select(Skill, UserSkill.proficiency)`` read with ``.all()``."""
    result = MagicMock()
    result.all.return_value = rows
    return result


def rowcount_result(count: int):
    result = MagicMock()
    result.rowcount = count
    return result


def added(db, model):
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj):
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
async def test_list_skills_returns_compact_rows(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalars_result(
        [make_skill(1, "Chemistry"), make_skill(2, "Python", "#abcdef")]
    )

    response = await client.get("/api/skills")

    assert response.status_code == 200
    assert response.json() == [
        {"id": 1, "name": "Chemistry", "color": "#112233"},
        {"id": 2, "name": "Python", "color": "#abcdef"},
    ]
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "ORDER BY skills.name" in sql


@pytest.mark.asyncio
async def test_get_skill_returns_detail(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalar_result(make_skill(3, "HPLC"))

    response = await client.get("/api/skills/3")

    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["name"], body["description"]) == (3, "HPLC", "HPLC skill")
    # Node toISOString() shape (the hour depends on the host TZ)
    assert body["created_at"].startswith("2026-01-01T")
    assert body["created_at"].endswith(":00:00.000Z")


@pytest.mark.asyncio
async def test_get_skill_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.get("/api/skills/99")

    assert response.status_code == 404
    assert response.json()["detail"] == "Skill not found"


# ---------------------------------------------------------------------------
# Create / update / delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_skill_as_superuser(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    db.execute.return_value = scalar_result(None)  # no duplicate

    response = await client.post(
        "/api/skills", json={"name": "Mass spec", "description": "MS", "color": "#00FF00"}
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["name"], body["color"]) == (42, "Mass spec", "#00FF00")
    (skill,) = added(db, Skill)
    assert skill.description == "MS"
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_skill_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.post("/api/skills", json={"name": "Mass spec"})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_skill_rejects_duplicate_name(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(make_skill(1, "Python"))

    response = await client.post("/api/skills", json={"name": "Python"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A skill with this name already exists"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload", [{"name": ""}, {"name": "X", "color": "red"}, {"description": "no name"}]
)
async def test_create_skill_validates_input(authed_client, mock_db_session, payload):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post("/api/skills", json=payload)

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_skill_renames_and_recolours(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    skill = make_skill(5, "Old")
    db.execute.side_effect = [scalar_result(skill), scalar_result(None)]

    response = await client.put("/api/skills/5", json={"name": "New", "color": "#000000"})

    assert response.status_code == 200
    assert (skill.name, skill.color) == ("New", "#000000")
    assert skill.description == "Old skill"  # untouched: not in the payload
    assert response.json()["name"] == "New"
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_skill_same_name_skips_duplicate_check(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    skill = make_skill(5, "Same")
    db.execute.side_effect = [scalar_result(skill)]

    response = await client.put("/api/skills/5", json={"name": "Same", "description": "d"})

    assert response.status_code == 200
    assert db.execute.await_count == 1
    assert skill.description == "d"


@pytest.mark.asyncio
async def test_update_skill_rejects_name_taken_by_another(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    skill = make_skill(5, "Old")
    mock_db_session.execute.side_effect = [
        scalar_result(skill),
        scalar_result(make_skill(6, "Taken")),
    ]

    response = await client.put("/api/skills/5", json={"name": "Taken"})

    assert response.status_code == 400
    assert skill.name == "Old"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_skill_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/skills/5", json={"name": "X"})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_skill_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.put("/api/skills/5", json={"name": "X"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    skill = make_skill(5)
    mock_db_session.execute.return_value = scalar_result(skill)

    response = await client.delete("/api/skills/5")

    assert response.status_code == 204
    mock_db_session.delete.assert_awaited_once_with(skill)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_skill_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/skills/5")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_skill_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.delete("/api/skills/5")).status_code == 403
    mock_db_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# User skill assignments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_user_skills_returns_proficiency(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        rows_result([(make_skill(1, "Chemistry"), 4), (make_skill(2, "Python"), 2)]),
    ]

    response = await client.get("/api/skills/user/9")

    assert response.status_code == 200
    assert response.json() == [
        {"id": 1, "name": "Chemistry", "color": "#112233", "proficiency": 4},
        {"id": 2, "name": "Python", "color": "#112233", "proficiency": 2},
    ]
    sql = str(mock_db_session.execute.await_args_list[1].args[0])
    assert "JOIN user_skills" in sql


@pytest.mark.asyncio
async def test_get_user_skills_unknown_user_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.get("/api/skills/user/9")

    assert response.status_code == 404
    assert response.json()["detail"] == "User not found"


@pytest.mark.asyncio
async def test_replace_user_skills_deletes_then_adds_deduplicated(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        scalars_result([make_skill(1), make_skill(2, "Python")]),
        MagicMock(),  # DELETE FROM user_skills
        scalar_result(make_user(9)),  # re-read for the response
        rows_result([(make_skill(1), 3), (make_skill(2, "Python"), 3)]),
    ]

    response = await client.put("/api/skills/user/9", json={"skill_ids": [2, 1, 2]})

    assert response.status_code == 200
    assert [s["id"] for s in response.json()] == [1, 2]
    delete_stmt = mock_db_session.execute.await_args_list[2].args[0]
    assert isinstance(delete_stmt, Delete)
    assert "user_skills.user_id" in str(delete_stmt)
    links = added(mock_db_session, UserSkill)
    assert [(link.user_id, link.skill_id, link.proficiency) for link in links] == [
        (9, 2, 3),
        (9, 1, 3),
    ]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_replace_user_skills_with_empty_list_clears(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        MagicMock(),  # DELETE (no skill lookup for an empty list)
        scalar_result(make_user(9)),
        rows_result([]),
    ]

    response = await client.put("/api/skills/user/9", json={"skill_ids": []})

    assert response.status_code == 200
    assert response.json() == []
    assert isinstance(mock_db_session.execute.await_args_list[1].args[0], Delete)
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_replace_user_skills_rejects_unknown_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        scalars_result([make_skill(1)]),
    ]

    response = await client.put("/api/skills/user/9", json={"skill_ids": [1, 77]})

    assert response.status_code == 400
    assert response.json()["detail"] == "Skills not found: [77]"
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_replace_user_skills_unknown_user_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.put("/api/skills/user/9", json={"skill_ids": [1]})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_replace_user_skills_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.put("/api/skills/user/9", json={"skill_ids": [1]})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_add_user_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        scalar_result(make_skill(4, "GMP")),
        scalar_result(None),  # not yet assigned
        scalar_result(make_user(9)),
        rows_result([(make_skill(4, "GMP"), 3)]),
    ]

    response = await client.post("/api/skills/user/9/4")

    assert response.status_code == 200
    assert response.json() == [{"id": 4, "name": "GMP", "color": "#112233", "proficiency": 3}]
    (link,) = added(mock_db_session, UserSkill)
    assert (link.user_id, link.skill_id, link.proficiency) == (9, 4, 3)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_add_user_skill_already_assigned(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result(make_user(9)),
        scalar_result(make_skill(4)),
        scalar_result(UserSkill(user_id=9, skill_id=4, proficiency=3)),
    ]

    response = await client.post("/api/skills/user/9/4")

    assert response.status_code == 400
    assert response.json()["detail"] == "Skill already assigned to user"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_user_skill_unknown_user_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.post("/api/skills/user/9/4")

    assert response.status_code == 404
    assert response.json()["detail"] == "User not found"


@pytest.mark.asyncio
async def test_add_user_skill_unknown_skill_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_user(9)), scalar_result(None)]

    response = await client.post("/api/skills/user/9/4")

    assert response.status_code == 404
    assert response.json()["detail"] == "Skill not found"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_user_skill_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.post("/api/skills/user/9/4")).status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_remove_user_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        rowcount_result(1),
        scalar_result(make_user(9)),
        rows_result([]),
    ]

    response = await client.delete("/api/skills/user/9/4")

    assert response.status_code == 200
    assert response.json() == []
    stmt = mock_db_session.execute.await_args_list[0].args[0]
    assert isinstance(stmt, Delete)
    assert sorted(stmt.compile().params.values()) == [4, 9]
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_remove_user_skill_not_assigned_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [rowcount_result(0)]

    response = await client.delete("/api/skills/user/9/4")

    assert response.status_code == 404
    assert response.json()["detail"] == "Skill assignment not found"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_remove_user_skill_forbidden_for_plain_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.delete("/api/skills/user/9/4")).status_code == 403
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# skills.assign: only on users the caller may edit
# ---------------------------------------------------------------------------


def make_admin(user_id: int = 2) -> User:
    user = make_user(user_id)
    user.role = "admin"
    return user


@pytest.mark.asyncio
async def test_superuser_cannot_set_an_admins_skills(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_admin())]

    response = await client.put("/api/skills/user/2", json={"skill_ids": [1]})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: users.edit_admins"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_add_a_skill_to_an_admin(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(make_admin())]

    response = await client.post("/api/skills/user/2/4")

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_superuser_cannot_remove_an_admins_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result("admin")]  # the target's role

    response = await client.delete("/api/skills/user/2/4")

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1  # the DELETE never ran
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_removes_a_plain_users_skill(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute.side_effect = [
        scalar_result("user"),  # the target's role
        rowcount_result(1),
        scalar_result(make_user(9)),
        rows_result([]),
    ]

    response = await client.delete("/api/skills/user/9/4")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_removing_a_skill_of_an_unknown_user_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.delete("/api/skills/user/9/4")

    assert response.status_code == 404
    assert response.json()["detail"] == "User not found"


@pytest.mark.asyncio
async def test_skills_assign_without_users_edit_is_refused(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "skills_clerk", {"skills.assign"}))
    mock_db_session.execute.side_effect = [scalar_result(make_user(9))]

    response = await client.put("/api/skills/user/9", json={"skill_ids": [1]})

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: users.edit"
