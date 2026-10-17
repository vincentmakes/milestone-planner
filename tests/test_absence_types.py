"""
Route-level tests for absence types (/api/absence-types).

Types are tenant-wide, so every write is admin-only; superusers are refused
like plain users. Deleting a type still referenced by a vacation is refused
with 409 so absences never silently lose their category.
"""

import re
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.models.absence_type import DEFAULT_ABSENCE_TYPES, AbsenceType
from app.services.tenant_provisioner import ABSENCE_TYPES_SEED_SQL
from tests.conftest import FakeUser

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def _type(type_id: int, name: str, sort_order: int = 0, **kwargs) -> AbsenceType:
    return AbsenceType(
        id=type_id,
        name=name,
        color=kwargs.get("color", "#8b5cf6"),
        counts_as_unavailable=kwargs.get("counts_as_unavailable", True),
        sort_order=sort_order,
        is_active=kwargs.get("is_active", True),
        created_at=STAMP,
        updated_at=STAMP,
    )


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    result.scalar.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


@pytest.fixture
def stamp_on_refresh(mock_db_session):
    """Simulate the DB filling id/timestamps when a new row is refreshed."""

    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        if getattr(obj, "created_at", None) is None:
            obj.created_at = STAMP
        if getattr(obj, "updated_at", None) is None:
            obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------
# Read
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_any_user_can_list_types_including_inactive(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result(
        [_type(1, "Holidays"), _type(2, "Old type", sort_order=1, is_active=False)]
    )

    response = await client.get("/api/absence-types")

    assert response.status_code == 200
    body = response.json()
    assert [t["name"] for t in body] == ["Holidays", "Old type"]
    assert body[1]["is_active"] is False
    assert set(body[0]) == {
        "id",
        "name",
        "color",
        "counts_as_unavailable",
        "sort_order",
        "is_active",
        "created_at",
        "updated_at",
    }


# ---------------------------------------------------------
# Role gating
# ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "/api/absence-types", {"name": "Sabbatical", "color": "#123456"}),
        ("put", "/api/absence-types/reorder", {"type_order": [2, 1]}),
        ("put", "/api/absence-types/1", {"name": "Renamed"}),
        ("delete", "/api/absence-types/1", None),
    ],
)
async def test_writes_are_admin_only(authed_client, role, method, path, body):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 403


# ---------------------------------------------------------
# Create / update / reorder
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_creates_a_type_at_the_end(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [_scalar_result(None), _scalar_result(4)]

    response = await client.post(
        "/api/absence-types",
        json={"name": " Sabbatical ", "color": "#123456", "counts_as_unavailable": False},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Sabbatical"
    assert body["counts_as_unavailable"] is False
    assert body["is_active"] is True
    assert body["sort_order"] == 5
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_duplicate_name_is_rejected(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(1)]

    response = await client.post(
        "/api/absence-types", json={"name": "Holidays", "color": "#123456"}
    )

    assert response.status_code == 400
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_color_is_rejected(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post("/api/absence-types", json={"name": "X", "color": "purple"})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_partial_update(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    home_office = _type(2, "Home Office", counts_as_unavailable=False)
    mock_db_session.get.return_value = home_office

    response = await client.put("/api/absence-types/2", json={"is_active": False})

    assert response.status_code == 200
    assert home_office.is_active is False
    # Untouched fields stay as they were.
    assert home_office.name == "Home Office"
    assert response.json()["counts_as_unavailable"] is False


@pytest.mark.asyncio
async def test_reorder_applies_the_new_order(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    first, second = _type(1, "Holidays", 0), _type(2, "Illness", 1)
    mock_db_session.execute.return_value = _scalars_result([first, second])

    response = await client.put("/api/absence-types/reorder", json={"type_order": [2, 1]})

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert (second.sort_order, first.sort_order) == (0, 1)


# ---------------------------------------------------------
# Delete
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_deleting_a_type_in_use_is_refused(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = _type(1, "Holidays")
    mock_db_session.execute.return_value = _scalar_result(17)  # a vacation uses it

    response = await client.delete("/api/absence-types/1")

    assert response.status_code == 409
    assert response.json()["detail"] == "This absence type is in use; deactivate it instead"
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_deleting_an_unused_type(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.get.return_value = _type(9, "Unused")
    mock_db_session.execute.return_value = _scalar_result(None)

    response = await client.delete("/api/absence-types/9")

    assert response.status_code == 200
    assert response.json() == {"success": True}
    mock_db_session.delete.assert_awaited()


# ---------------------------------------------------------
# Seed
# ---------------------------------------------------------


def test_seed_sql_matches_the_model_defaults():
    """The provisioner/auto-migration seed must not drift from the model constant."""
    rows = re.findall(
        r"\('([^']+)', '(#[0-9a-f]{6})', (TRUE|FALSE), (\d+)\)", ABSENCE_TYPES_SEED_SQL
    )
    assert [(name, color, flag == "TRUE") for name, color, flag, _ in rows] == DEFAULT_ABSENCE_TYPES
    assert [int(order) for *_, order in rows] == list(range(len(DEFAULT_ABSENCE_TYPES)))
