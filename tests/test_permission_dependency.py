"""
The permission dependencies (app/middleware/auth.py): ``require_permission``,
``require_any_permission`` and ``require_project_permission``.

A small app mounts one route per dependency; ``get_current_user`` and
``get_db`` are overridden, so the dependencies see the FakeUser's
PermissionSet exactly as they would see a live-resolved one.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.database import get_db
from app.middleware.auth import (
    get_current_user,
    require_any_permission,
    require_permission,
    require_project_permission,
)
from tests.conftest import FakeUser


def build_app(db) -> tuple[FastAPI, dict]:
    app = FastAPI()
    state = {"user": FakeUser(1, "user")}

    @app.get("/create")
    async def create(user=Depends(require_permission("projects.create"))):
        return {"id": user.id}

    @app.get("/any")
    async def any_of(user=Depends(require_any_permission("sites.manage", "sites.export"))):
        return {"id": user.id}

    @app.get("/projects/{project_id}/edit")
    async def edit(project_id: int, user=Depends(require_project_permission("projects.edit_any"))):
        return {"id": user.id, "project": project_id}

    @app.get("/projects/{project_id}/delete")
    async def delete(project_id: int, user=Depends(require_project_permission("projects.delete"))):
        return {"id": user.id}

    # A misnamed path parameter: the dependency's ``project_id`` is not in the path.
    @app.get("/misnamed/{pid}")
    async def misnamed(pid: int, user=Depends(require_project_permission("projects.edit_any"))):
        return {"id": user.id}

    app.dependency_overrides[get_current_user] = lambda: state["user"]
    app.dependency_overrides[get_db] = lambda: db
    return app, state


@pytest.fixture
def pm_db():
    """A db whose ``SELECT pm_id`` answers ``pm_db.pm_id`` (None row = missing project)."""
    db = MagicMock()
    db.pm_row = (7,)

    async def execute(_stmt):
        result = MagicMock()
        result.first.return_value = db.pm_row
        return result

    db.execute = AsyncMock(side_effect=execute)
    return db


@pytest.fixture
async def client(pm_db):
    app, state = build_app(pm_db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:

        def set_user(user):
            state["user"] = user

        yield c, set_user


# ---------------------------------------------------------------------------
# require_permission
# ---------------------------------------------------------------------------


async def test_missing_permission_is_403_naming_the_key(client):
    c, set_user = client
    set_user(FakeUser(3, "user"))  # the user role does not create projects

    resp = await c.get("/create")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: projects.create"


async def test_held_permission_passes(client):
    c, set_user = client
    set_user(FakeUser(3, "user", {"projects.create"}))

    resp = await c.get("/create")

    assert resp.status_code == 200
    assert resp.json() == {"id": 3}


async def test_admin_passes_without_rows(client):
    c, set_user = client
    set_user(FakeUser(1, "admin", set()))

    assert (await c.get("/create")).status_code == 200
    assert (await c.get("/any")).status_code == 200


async def test_approval_mode_is_not_an_allow(client):
    c, set_user = client
    set_user(FakeUser(3, "custom", {"projects.create": "approval"}))

    assert (await c.get("/create")).status_code == 403


def test_unknown_key_fails_at_definition_time():
    with pytest.raises(ValueError, match="Unknown permission"):
        require_permission("projects.creat")
    with pytest.raises(ValueError, match="Unknown permission"):
        require_any_permission("sites.manage", "nope")
    with pytest.raises(ValueError, match="Unknown permission"):
        require_project_permission("projects.edti_any")
    with pytest.raises(ValueError, match="at least one"):
        require_any_permission()


# ---------------------------------------------------------------------------
# require_any_permission
# ---------------------------------------------------------------------------


async def test_any_permission_passes_with_one_of_the_keys(client):
    c, set_user = client
    set_user(FakeUser(3, "user", {"sites.export"}))

    assert (await c.get("/any")).status_code == 200


async def test_any_permission_403_names_every_key(client):
    c, set_user = client
    set_user(FakeUser(3, "user", set()))

    resp = await c.get("/any")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: sites.manage or sites.export"


# ---------------------------------------------------------------------------
# require_project_permission: the PM bundle, resolved server-side
# ---------------------------------------------------------------------------


async def test_project_permission_held_outright_skips_the_pm_lookup(client, pm_db):
    c, set_user = client
    set_user(FakeUser(3, "superuser"))

    resp = await c.get("/projects/5/edit")

    assert resp.status_code == 200
    pm_db.execute.assert_not_awaited()


async def test_project_manager_passes_through_the_bundle(client, pm_db):
    c, set_user = client
    set_user(FakeUser(7, "user"))  # user role holds projects.manage_as_pm; pm_id is 7

    resp = await c.get("/projects/5/edit")

    assert resp.status_code == 200
    assert resp.json() == {"id": 7, "project": 5}
    pm_db.execute.assert_awaited_once()
    sql = str(pm_db.execute.await_args.args[0])
    assert "projects.pm_id" in sql


async def test_other_users_project_is_403(client, pm_db):
    c, set_user = client
    set_user(FakeUser(8, "user"))  # pm_id is 7

    resp = await c.get("/projects/5/edit")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: projects.edit_any"


async def test_pm_without_manage_as_pm_is_403_without_a_lookup(client, pm_db):
    c, set_user = client
    set_user(FakeUser(7, "custom", set()))

    resp = await c.get("/projects/5/edit")

    assert resp.status_code == 403
    pm_db.execute.assert_not_awaited()


async def test_key_outside_the_bundle_is_never_granted_to_the_pm(client, pm_db):
    c, set_user = client
    set_user(FakeUser(7, "user"))

    resp = await c.get("/projects/5/delete")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: projects.delete"
    pm_db.execute.assert_not_awaited()


async def test_missing_project_is_404_for_a_pm_candidate(client, pm_db):
    c, set_user = client
    set_user(FakeUser(7, "user"))
    pm_db.pm_row = None

    resp = await c.get("/projects/99/edit")

    assert resp.status_code == 404
    assert resp.json()["detail"] == "Project not found"


async def test_a_misnamed_path_parameter_never_reads_a_query_string(client, pm_db):
    """
    The project id is bound as ``Path()``: on a route whose parameter is named
    differently, a ``?project_id=`` the PM controls cannot steer the PM check.
    """
    c, set_user = client
    set_user(FakeUser(7, "user"))  # PM of the project pm_db answers (7)

    resp = await c.get("/misnamed/5?project_id=1")

    assert resp.status_code == 422
    pm_db.execute.assert_not_awaited()
