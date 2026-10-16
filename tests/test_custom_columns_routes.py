"""
Route tests for /api/custom-columns — column definitions (admin only) and
single-value writes (any authenticated user).

The batch write is covered in tests/test_domain_routes_misc.py; this file
covers the rest of the router. Mock-based, house style (tests/conftest.py).
"""

import json
from datetime import datetime

import pytest

from app.models.custom_column import CustomColumn, CustomColumnValue
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


def make_column(
    column_id: int = 1,
    column_type: str = "text",
    options: list[str] | None = None,
    site_id: int | None = None,
    display_order: int = 1,
    name: str | None = None,
) -> CustomColumn:
    return CustomColumn(
        id=column_id,
        name=name or f"Col{column_id}",
        column_type=column_type,
        list_options=json.dumps(options) if options is not None else None,
        site_id=site_id,
        display_order=display_order,
        width=120,
        created_at=STAMP,
        updated_at=STAMP,
    )


def make_value(column_id: int, entity_type: str, entity_id: int, value: str | None, vid=50):
    return CustomColumnValue(
        id=vid,
        custom_column_id=column_id,
        entity_type=entity_type,
        entity_id=entity_id,
        value=value,
        created_at=STAMP,
        updated_at=STAMP,
    )


def sql(db, index: int = -1) -> str:
    stmt = db.execute.await_args_list[index].args[0]
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


@pytest.fixture
def db_assigns_ids(mock_db_session):
    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 77
        obj.created_at = obj.created_at or STAMP
        obj.updated_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------------------------
# Column reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_columns_for_site_includes_global(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalars_result(
        [make_column(1), make_column(2, "list", ["Low", "High"], site_id=3)]
    )

    response = await client.get("/api/custom-columns?site_id=3")

    assert response.status_code == 200
    body = response.json()
    assert [(c["id"], c["column_type"], c["list_options"]) for c in body] == [
        (1, "text", None),
        (2, "list", ["Low", "High"]),
    ]
    query = sql(mock_db_session)
    assert "custom_columns.site_id IS NULL OR custom_columns.site_id = 3" in query
    assert "ORDER BY custom_columns.display_order, custom_columns.id" in query


@pytest.mark.asyncio
async def test_list_columns_without_site_returns_only_global(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = scalars_result([])

    response = await client.get("/api/custom-columns")

    assert response.status_code == 200
    assert response.json() == []
    query = sql(mock_db_session)
    assert "custom_columns.site_id IS NULL" in query
    assert "custom_columns.site_id =" not in query


@pytest.mark.asyncio
async def test_with_values_keys_values_by_column_entity(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [
        scalars_result([make_column(1), make_column(2, "boolean")]),
        scalars_result(
            [
                make_value(1, "project", 10, "hello"),
                make_value(2, "phase", 11, "true"),
            ]
        ),
    ]

    response = await client.get("/api/custom-columns/with-values?site_id=3")

    assert response.status_code == 200
    body = response.json()
    assert [c["id"] for c in body["columns"]] == [1, 2]
    assert body["values"] == {"1-project-10": "hello", "2-phase-11": "true"}
    assert "custom_column_values.custom_column_id IN (1, 2)" in sql(mock_db_session)


@pytest.mark.asyncio
async def test_with_values_skips_value_query_when_no_columns(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.side_effect = [scalars_result([])]

    response = await client.get("/api/custom-columns/with-values?site_id=3")

    assert response.status_code == 200
    assert response.json() == {"columns": [], "values": {}}
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_with_values_requires_site_id(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.get("/api/custom-columns/with-values")

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Column create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_list_column_appends_after_last_order(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    db.execute.side_effect = [
        scalars_result([make_column(1), make_column(2)]),  # 2 existing (limit check)
        scalar_result(4),  # current max display_order
    ]

    response = await client.post(
        "/api/custom-columns",
        json={
            "name": "Priority",
            "column_type": "list",
            "list_options": ["Low", "High"],
            "site_id": 3,
            "width": 200,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["display_order"], body["list_options"]) == (77, 5, ["Low", "High"])
    (column,) = (c.args[0] for c in db.add.call_args_list)
    assert column.list_options == '["Low", "High"]'
    assert (column.site_id, column.width) == (3, 200)
    assert "custom_columns.site_id = 3" in sql(db, 0)
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_first_global_column_starts_at_order_one(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    db.execute.side_effect = [scalars_result([]), scalar_result(None)]

    response = await client.post("/api/custom-columns", json={"name": "Notes"})

    assert response.status_code == 200
    body = response.json()
    assert (body["column_type"], body["display_order"], body["site_id"]) == ("text", 1, None)
    assert body["list_options"] is None
    assert "custom_columns.site_id IS NULL" in sql(db, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("options", [None, []])
async def test_create_list_column_requires_options(authed_client, mock_db_session, options):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post(
        "/api/custom-columns",
        json={"name": "Priority", "column_type": "list", "list_options": options},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "list_options is required for list type columns"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_column_enforces_limit(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [scalars_result([make_column(i) for i in range(10)])]

    response = await client.post("/api/custom-columns", json={"name": "Eleventh"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Maximum of 10 custom columns allowed"
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"name": "X", "column_type": "date"},
        {"name": "X", "width": 10},
        {"name": ""},
    ],
)
async def test_create_column_validates_schema(authed_client, mock_db_session, payload):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.post("/api/custom-columns", json=payload)

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
async def test_create_column_is_admin_only(authed_client, mock_db_session, role):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    response = await client.post("/api/custom-columns", json={"name": "Notes"})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------------------------
# Column update / delete / reorder
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_list_column(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    column = make_column(4, "list", ["A"])
    db.execute.return_value = scalar_result(column)

    response = await client.patch(
        "/api/custom-columns/4", json={"name": "Renamed", "list_options": ["A", "B"], "width": 300}
    )

    assert response.status_code == 200
    assert (column.name, column.width) == ("Renamed", 300)
    assert column.list_options == '["A", "B"]'
    assert response.json()["list_options"] == ["A", "B"]
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_rejects_options_on_non_list_column(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    column = make_column(4, "text")
    mock_db_session.execute.return_value = scalar_result(column)

    response = await client.patch("/api/custom-columns/4", json={"list_options": ["A"]})

    assert response.status_code == 400
    assert column.list_options is None
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_column_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.patch("/api/custom-columns/4", json={"name": "X"})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_column_is_admin_only(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.patch("/api/custom-columns/4", json={"name": "X"})

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_column(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    column = make_column(4)
    mock_db_session.execute.return_value = scalar_result(column)

    response = await client.delete("/api/custom-columns/4")

    assert response.status_code == 200
    assert response.json() == {"success": True, "message": "Custom column deleted"}
    mock_db_session.delete.assert_awaited_once_with(column)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_column_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/custom-columns/4")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_column_is_admin_only(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (await client.delete("/api/custom-columns/4")).status_code == 403
    mock_db_session.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_reorder_route_is_shadowed_by_patch_column_id(authed_client, mock_db_session):
    """PATCH /custom-columns/reorder is registered after PATCH /{column_id}.

    Starlette matches /{column_id} first and the int conversion fails, so the
    reorder handler is unreachable over HTTP today (422). Pinned here so a fix
    (registering /reorder first) shows up as a deliberate test change.
    """
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    response = await client.patch("/api/custom-columns/reorder", json={"column_order": [2, 1]})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["path", "column_id"]
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_reorder_handler_sets_display_order_and_ignores_unknown(mock_db_session):
    """The reorder handler itself (called directly, see the shadowing test above)."""
    from app.routers.custom_columns import reorder_custom_columns
    from app.schemas.custom_column import CustomColumnReorderRequest

    first, second = make_column(1, display_order=1), make_column(2, display_order=2)
    mock_db_session.execute.side_effect = [
        scalars_result([first, second]),
        scalars_result([second, first]),
    ]

    result = await reorder_custom_columns(
        request=None,
        data=CustomColumnReorderRequest(column_order=[2, 99, 1]),
        db=mock_db_session,
        _user=FakeUser(1, "admin"),
    )

    assert (second.display_order, first.display_order) == (0, 2)
    assert [c.id for c in result] == [2, 1]
    mock_db_session.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# Single value writes
# ---------------------------------------------------------------------------


def _value_payload(value, column_id=1, entity_type="project", entity_id=10):
    return {
        "custom_column_id": column_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "value": value,
    }


@pytest.mark.asyncio
async def test_set_value_creates_new_row(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    db = db_assigns_ids
    db.execute.side_effect = [scalar_result(make_column(1)), scalar_result(None)]

    response = await client.put("/api/custom-columns/values", json=_value_payload("hello"))

    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["value"], body["entity_type"]) == (77, "hello", "project")
    (value,) = (c.args[0] for c in db.add.call_args_list)
    assert (value.custom_column_id, value.entity_id) == (1, 10)
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_set_value_updates_existing_row(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    db = db_assigns_ids
    existing = make_value(1, "phase", 10, "Low", vid=60)
    db.execute.side_effect = [
        scalar_result(make_column(1, "list", ["Low", "High"])),
        scalar_result(existing),
    ]

    response = await client.put(
        "/api/custom-columns/values", json=_value_payload("High", entity_type="phase")
    )

    assert response.status_code == 200
    assert existing.value == "High"
    assert response.json()["id"] == 60
    db.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("column", "value", "detail"),
    [
        (make_column(1, "boolean"), "yes", "Boolean values must be 'true' or 'false'"),
        (make_column(1, "list", ["Low", "High"]), "Mid", "Value must be one of: Low, High"),
    ],
)
async def test_set_value_rejects_value_outside_column_type(
    authed_client, mock_db_session, column, value, detail
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(column)]

    response = await client.put("/api/custom-columns/values", json=_value_payload(value))

    assert response.status_code == 400
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_set_value_accepts_boolean_case_insensitively(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    db = db_assigns_ids
    db.execute.side_effect = [scalar_result(make_column(1, "boolean")), scalar_result(None)]

    response = await client.put("/api/custom-columns/values", json=_value_payload("TRUE"))

    assert response.status_code == 200
    assert response.json()["value"] == "TRUE"


@pytest.mark.asyncio
async def test_set_value_unknown_column_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.put("/api/custom-columns/values", json=_value_payload("x"))

    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_set_value_rejects_unknown_entity_type(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.put(
        "/api/custom-columns/values", json=_value_payload("x", entity_type="site")
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_value(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    value = make_value(1, "subphase", 12, "x")
    mock_db_session.execute.return_value = scalar_result(value)

    response = await client.delete("/api/custom-columns/values/1/subphase/12")

    assert response.status_code == 200
    assert response.json()["success"] is True
    mock_db_session.delete.assert_awaited_once_with(value)
    query = sql(mock_db_session)
    assert "custom_column_values.entity_type = 'subphase'" in query
    assert "custom_column_values.entity_id = 12" in query


@pytest.mark.asyncio
async def test_delete_value_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.return_value = scalar_result(None)

    response = await client.delete("/api/custom-columns/values/1/phase/12")

    assert response.status_code == 404
    assert response.json()["detail"] == "Custom column value not found"
    mock_db_session.delete.assert_not_awaited()
