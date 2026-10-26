"""
Project fields API (app/routers/project_fields.py, 2.0.0).

- Every authenticated user reads the fields (with their items) and a field's
  usage count; every write needs ``project_fields.manage`` (admin-only by
  default: superusers and users are refused).
- Fields: name trimmed, non-empty, unique case-insensitively (400); the type is
  fixed at creation (a different type on PUT is a 422); appended at the end;
  reorder; delete cascades in the database.
- Items (select / multiselect fields only, 400 otherwise): name unique per
  field (400), colour ``#rrggbb`` (422), the tag scoping rules (restricted
  needs a site 400, unknown site / team 404, a team outside the item's sites
  400) and the 409s that protect projects holding the item.
- Commit-time unique violations are a 400 with a rollback.
- Deleting a site deletes the site-restricted items it leaves without a site.

Mock-based: each test lays out the ``db.execute`` results in the order the
handler consumes them and inspects the compiled statements.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import IntegrityError

from app.models.project_field import ProjectField, ProjectFieldOption
from app.models.site import Site
from app.models.team import Team
from app.routers.project_fields import (
    DUPLICATE_FIELD_NAME_DETAIL,
    DUPLICATE_OPTION_NAME_DETAIL,
    EMPTY_FIELD_NAME_DETAIL,
    EMPTY_OPTION_NAME_DETAIL,
    FIELD_NOT_FOUND_DETAIL,
    FIELD_TYPE_IMMUTABLE_DETAIL,
    NOT_A_DROPDOWN_DETAIL,
    OPTION_NO_SITE_DETAIL,
    OPTION_NOT_FOUND_DETAIL,
)
from app.services.team_rules import TEAM_NOT_FOUND_DETAIL, team_outside_sites_detail
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
ADMIN = FakeUser(1, "admin")
MANAGER = FakeUser(3, "custom", {"project_fields.manage"})


def _site(site_id: int) -> Site:
    return Site(id=site_id, name=f"Site {site_id}")


def _team(team_id: int, site_id: int = 1) -> Team:
    return Team(id=team_id, site_id=site_id, name=f"Team {team_id}")


def _option(option_id: int = 9, name: str = "Internal", field_id: int = 5, **kw):
    return ProjectFieldOption(
        id=option_id,
        field_id=field_id,
        name=name,
        color=kw.get("color", "#6366f1"),
        all_sites=kw.get("all_sites", True),
        sort_order=kw.get("sort_order", 0),
        sites=kw.get("sites", []),
        teams=kw.get("teams", []),
        created_at=STAMP,
        updated_at=STAMP,
    )


def _field(field_id: int = 5, name: str = "Project type", field_type: str = "select", **kw):
    return ProjectField(
        id=field_id,
        name=name,
        field_type=field_type,
        sort_order=kw.get("sort_order", 0),
        options=kw.get("options", []),
        created_at=STAMP,
        updated_at=STAMP,
    )


def _sql(mock_db_session) -> list[str]:
    return [
        " ".join(str(call.args[0].compile(compile_kwargs={"literal_binds": True})).split())
        for call in mock_db_session.execute.await_args_list
    ]


@pytest.fixture
def stamp_on_refresh(mock_db_session):
    """Simulate the DB filling the id and timestamps when a new row is refreshed."""

    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        for attr in ("created_at", "updated_at"):
            if getattr(obj, attr, None) is None:
                setattr(obj, attr, STAMP)

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


def _integrity_error() -> IntegrityError:
    return IntegrityError("INSERT ...", {}, Exception("unique violation"))


# ---------------------------------------------------------
# Gating
# ---------------------------------------------------------

WRITES = [
    ("post", "/api/project-fields", {"name": "Budget", "field_type": "number"}),
    ("put", "/api/project-fields/reorder", {"field_order": [2, 1]}),
    ("put", "/api/project-fields/5", {"name": "Renamed"}),
    ("delete", "/api/project-fields/5", None),
    ("post", "/api/project-fields/5/options", {"name": "Internal"}),
    ("put", "/api/project-fields/5/options/reorder", {"option_order": [2, 1]}),
    ("put", "/api/project-fields/options/9", {"name": "Renamed"}),
    ("delete", "/api/project-fields/options/9", None),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
@pytest.mark.parametrize(("method", "path", "body"), WRITES)
async def test_writes_need_project_fields_manage(
    authed_client, mock_db_session, role, method, path, body
):
    client, set_user = authed_client
    set_user(FakeUser(2, role))

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: project_fields.manage"
    mock_db_session.execute.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_any_user_lists_the_fields_with_their_items(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(2, "user"))
    select_field = _field(
        5,
        options=[
            _option(9, "Internal"),
            _option(
                10,
                "Customer",
                color="#0ea5e9",
                all_sites=False,
                sort_order=1,
                sites=[_site(2), _site(1)],
                teams=[_team(8), _team(7)],
            ),
        ],
    )
    budget = _field(6, "Budget", "number", sort_order=1)
    mock_db_session.execute.return_value = scalars_result([select_field, budget])

    response = await client.get("/api/project-fields")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": 5,
            "name": "Project type",
            "field_type": "select",
            "sort_order": 0,
            "options": [
                {
                    "id": 9,
                    "name": "Internal",
                    "color": "#6366f1",
                    "sort_order": 0,
                    "all_sites": True,
                    "site_ids": [],
                    "team_ids": [],
                },
                {
                    "id": 10,
                    "name": "Customer",
                    "color": "#0ea5e9",
                    "sort_order": 1,
                    "all_sites": False,
                    "site_ids": [1, 2],
                    "team_ids": [7, 8],
                },
            ],
        },
        {"id": 6, "name": "Budget", "field_type": "number", "sort_order": 1, "options": []},
    ]
    (sql,) = _sql(mock_db_session)
    assert sql.endswith("ORDER BY project_fields.sort_order, project_fields.id")


@pytest.mark.asyncio
async def test_any_user_reads_the_usage_count(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(2, "user"))
    mock_db_session.execute.side_effect = [scalar_result(_field(5)), scalar_result(4)]

    response = await client.get("/api/project-fields/5/usage")

    assert response.status_code == 200
    assert response.json() == {"projects": 4}
    count = _sql(mock_db_session)[1]
    assert "project_field_values.field_id = 5" in count
    assert "project_field_options.field_id = 5" in count
    assert " UNION " in count


@pytest.mark.asyncio
async def test_usage_of_an_unknown_field_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(2, "user"))
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await client.get("/api/project-fields/99/usage")

    assert response.status_code == 404
    assert response.json()["detail"] == FIELD_NOT_FOUND_DETAIL


# ---------------------------------------------------------
# Fields
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_key_holder_creates_a_field_appended_at_the_end(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(MANAGER)
    db = stamp_on_refresh
    db.execute.side_effect = [scalar_result(None), scalar_result(3)]

    response = await client.post(
        "/api/project-fields", json={"name": "  Budget ", "field_type": "number"}
    )

    assert response.status_code == 201, response.text
    assert response.json() == {
        "id": 42,
        "name": "Budget",
        "field_type": "number",
        "sort_order": 4,
        "options": [],
    }
    taken, max_order = _sql(db)
    assert "lower(project_fields.name) = 'budget'" in taken
    assert max_order.startswith("SELECT max(project_fields.sort_order)")
    db.add.assert_called_once()
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_the_first_field_gets_sort_order_zero(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(ADMIN)
    stamp_on_refresh.execute.side_effect = [scalar_result(None), scalar_result(None)]

    response = await client.post(
        "/api/project-fields", json={"name": "Area", "field_type": "multiselect"}
    )

    assert response.status_code == 201
    assert response.json()["sort_order"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "status", "detail"),
    [
        ({"name": "   ", "field_type": "text"}, 400, EMPTY_FIELD_NAME_DETAIL),
        ({"name": "Budget", "field_type": "date"}, 422, None),
        ({"name": "", "field_type": "text"}, 422, None),
        ({"name": "x" * 101, "field_type": "text"}, 422, None),
        ({"name": "Budget"}, 422, None),
    ],
    ids=["blank", "unknown-type", "empty", "too-long", "no-type"],
)
async def test_create_rejects_bad_input(authed_client, mock_db_session, body, status, detail):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.post("/api/project-fields", json=body)

    assert response.status_code == status
    if detail:
        assert response.json()["detail"] == detail
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_duplicate_field_name_is_a_400_case_insensitively(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(7)]

    response = await client.post(
        "/api/project-fields", json={"name": "PROJECT TYPE", "field_type": "select"}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_FIELD_NAME_DETAIL
    assert "lower(project_fields.name) = 'project type'" in _sql(mock_db_session)[0]
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_a_create_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error()

    response = await client.post(
        "/api/project-fields", json={"name": "Budget", "field_type": "number"}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_FIELD_NAME_DETAIL
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_rename_a_field(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    field = _field(5, options=[_option(9)])
    mock_db_session.execute.side_effect = [scalar_result(field), scalar_result(None)]

    # Sending the field's own type back is fine.
    response = await client.put(
        "/api/project-fields/5", json={"name": " Kind ", "field_type": "select"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Kind"
    assert [o["id"] for o in response.json()["options"]] == [9]
    assert field.name == "Kind"
    assert "project_fields.id != 5" in _sql(mock_db_session)[1]
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_a_case_only_rename_checks_other_fields(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    field = _field(5, "Area")
    mock_db_session.execute.side_effect = [scalar_result(field), scalar_result(None)]

    response = await client.put("/api/project-fields/5", json={"name": "AREA"})

    assert response.status_code == 200
    assert field.name == "AREA"


@pytest.mark.asyncio
async def test_renaming_to_the_same_name_needs_no_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5))]

    response = await client.put("/api/project-fields/5", json={"name": "Project type"})

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_renaming_to_a_taken_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    field = _field(5)
    mock_db_session.execute.side_effect = [scalar_result(field), scalar_result(6)]

    response = await client.put("/api/project-fields/5", json={"name": "budget"})

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_FIELD_NAME_DETAIL
    assert field.name == "Project type"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_renaming_to_blank_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5))]

    response = await client.put("/api/project-fields/5", json={"name": "  "})

    assert response.status_code == 400
    assert response.json()["detail"] == EMPTY_FIELD_NAME_DETAIL


@pytest.mark.asyncio
async def test_the_type_of_a_field_cannot_change(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    field = _field(5, field_type="select")
    mock_db_session.execute.side_effect = [scalar_result(field)]

    response = await client.put(
        "/api/project-fields/5", json={"name": "Kind", "field_type": "multiselect"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == FIELD_TYPE_IMMUTABLE_DETAIL
    assert (field.name, field.field_type) == ("Project type", "select")
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/project-fields/99", {"name": "X"}),
        ("delete", "/api/project-fields/99", None),
        ("post", "/api/project-fields/99/options", {"name": "X"}),
        ("put", "/api/project-fields/99/options/reorder", {"option_order": [1]}),
    ],
)
async def test_an_unknown_field_is_a_404(authed_client, mock_db_session, method, path, body):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(None)]

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 404
    assert response.json()["detail"] == FIELD_NOT_FOUND_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_a_field(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(MANAGER)
    field = _field(5)
    mock_db_session.execute.side_effect = [scalar_result(field)]

    response = await client.delete("/api/project-fields/5")

    assert response.status_code == 204
    mock_db_session.delete.assert_awaited_once_with(field)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_reorder_sets_sort_order_to_the_index(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    first, second = _field(1, "A", sort_order=0), _field(2, "B", "text", sort_order=1)
    mock_db_session.execute.return_value = scalars_result([first, second])

    response = await client.put("/api/project-fields/reorder", json={"field_order": [2, 1, 99]})

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert (second.sort_order, first.sort_order) == (0, 1)
    assert "project_fields.id IN (1, 2, 99)" in _sql(mock_db_session)[0]
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_an_empty_reorder_needs_no_query(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.put("/api/project-fields/reorder", json={"field_order": []})

    assert response.status_code == 200
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_reorder_lists_are_bounded(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.put(
        "/api/project-fields/reorder", json={"field_order": list(range(501))}
    )

    assert response.status_code == 422


# ---------------------------------------------------------
# Items: create
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_add_an_item_scoped_to_sites_and_teams(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(MANAGER)
    db = stamp_on_refresh
    db.execute.side_effect = [
        scalar_result(_field(5, field_type="multiselect")),  # the field
        scalar_result(None),  # name free in the field
        scalars_result([_site(1), _site(2)]),  # the sites
        scalars_result([_team(7, 1)]),  # the teams
        scalar_result(1),  # max sort_order in the field
    ]

    response = await client.post(
        "/api/project-fields/5/options",
        json={"name": " Process ", "color": "#0ea5e9", "site_ids": [2, 1, 2], "team_ids": [7]},
    )

    assert response.status_code == 201, response.text
    assert response.json() == {
        "id": 42,
        "name": "Process",
        "color": "#0ea5e9",
        "sort_order": 2,
        "all_sites": False,  # omitted all_sites + sites = restricted
        "site_ids": [1, 2],
        "team_ids": [7],
    }
    sql = _sql(db)
    assert "project_field_options.field_id = 5" in sql[1]
    assert "lower(project_field_options.name) = 'process'" in sql[1]
    assert "sites.id IN (1, 2)" in sql[2]
    assert "max(project_field_options.sort_order)" in sql[4]
    assert "project_field_options.field_id = 5" in sql[4]
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_an_all_sites_item_clears_the_sites_and_may_carry_any_team(
    authed_client, stamp_on_refresh
):
    client, set_user = authed_client
    set_user(ADMIN)
    db = stamp_on_refresh
    db.execute.side_effect = [
        scalar_result(_field(5)),
        scalar_result(None),
        scalars_result([_team(7, 3)]),
        scalar_result(None),  # the field's first item
    ]

    response = await client.post(
        "/api/project-fields/5/options",
        json={"name": "Internal", "all_sites": True, "site_ids": [1], "team_ids": [7]},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["all_sites"], body["site_ids"], body["team_ids"], body["sort_order"]) == (
        True,
        [],
        [7],
        0,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("field_type", ["text", "number", "toggle"])
async def test_only_dropdown_fields_have_items(authed_client, mock_db_session, field_type):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(6, "Budget", field_type))]

    response = await client.post("/api/project-fields/6/options", json={"name": "X"})

    assert response.status_code == 400
    assert response.json()["detail"] == NOT_A_DROPDOWN_DETAIL
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_a_duplicate_item_name_in_the_field_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5)), scalar_result(9)]

    response = await client.post("/api/project-fields/5/options", json={"name": "internal"})

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_OPTION_NAME_DETAIL


@pytest.mark.asyncio
async def test_a_blank_item_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5))]

    response = await client.post("/api/project-fields/5/options", json={"name": "  "})

    assert response.status_code == 400
    assert response.json()["detail"] == EMPTY_OPTION_NAME_DETAIL


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"name": "X", "color": "red"},
        {"name": "X", "color": "#12345"},
        {"name": "X", "site_ids": list(range(201))},
        {"name": "X", "team_ids": list(range(201))},
    ],
    ids=["named-colour", "short-hex", "too-many-sites", "too-many-teams"],
)
async def test_bad_item_input_is_a_422(authed_client, mock_db_session, body):
    client, set_user = authed_client
    set_user(ADMIN)

    response = await client.post("/api/project-fields/5/options", json=body)

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_restricted_item_needs_a_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5)), scalar_result(None)]

    response = await client.post(
        "/api/project-fields/5/options", json={"name": "Nowhere", "all_sites": False}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == OPTION_NO_SITE_DETAIL


@pytest.mark.asyncio
async def test_an_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [
        scalar_result(_field(5)),
        scalar_result(None),
        scalars_result([_site(1)]),
    ]

    response = await client.post(
        "/api/project-fields/5/options", json={"name": "X", "site_ids": [1, 99]}
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Site not found"


@pytest.mark.asyncio
async def test_an_unknown_team_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [
        scalar_result(_field(5)),
        scalar_result(None),
        scalars_result([]),  # team 99 does not exist
    ]

    response = await client.post(
        "/api/project-fields/5/options", json={"name": "X", "team_ids": [99]}
    )

    assert response.status_code == 404
    assert response.json()["detail"] == TEAM_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_a_team_outside_the_item_sites_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [
        scalar_result(_field(5)),
        scalar_result(None),
        scalars_result([_site(1)]),
        scalars_result([_team(8, 2)]),
    ]

    response = await client.post(
        "/api/project-fields/5/options", json={"name": "X", "site_ids": [1], "team_ids": [8]}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_sites_detail("Team 8")
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_an_item_create_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [
        scalar_result(_field(5)),
        scalar_result(None),
        scalar_result(None),
    ]
    mock_db_session.commit.side_effect = _integrity_error()

    response = await client.post("/api/project-fields/5/options", json={"name": "Internal"})

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_OPTION_NAME_DETAIL
    mock_db_session.rollback.assert_awaited()


# ---------------------------------------------------------
# Items: update
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_rename_and_recolour_an_item(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, "Internal")
    mock_db_session.execute.side_effect = [scalar_result(option), scalar_result(None)]

    response = await client.put(
        "/api/project-fields/options/9", json={"name": " In-house ", "color": "#123456"}
    )

    assert response.status_code == 200, response.text
    assert (option.name, option.color) == ("In-house", "#123456")
    name_check = _sql(mock_db_session)[1]
    assert "project_field_options.field_id = 5" in name_check
    assert "project_field_options.id != 9" in name_check
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_renaming_an_item_to_a_taken_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, "Internal")
    mock_db_session.execute.side_effect = [scalar_result(option), scalar_result(10)]

    response = await client.put("/api/project-fields/options/9", json={"name": "Customer"})

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_OPTION_NAME_DETAIL
    assert option.name == "Internal"


@pytest.mark.asyncio
async def test_renaming_an_item_to_blank_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_option(9))]

    response = await client.put("/api/project-fields/options/9", json={"name": " "})

    assert response.status_code == 400
    assert response.json()["detail"] == EMPTY_OPTION_NAME_DETAIL


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/project-fields/options/99", {"name": "X"}),
        ("delete", "/api/project-fields/options/99", None),
    ],
)
async def test_an_unknown_item_is_a_404(authed_client, mock_db_session, method, path, body):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(None)]

    kwargs = {"json": body} if body is not None else {}
    response = await client.request(method.upper(), path, **kwargs)

    assert response.status_code == 404
    assert response.json()["detail"] == OPTION_NOT_FOUND_DETAIL


@pytest.mark.asyncio
async def test_restricting_an_item_held_at_other_sites_is_a_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=True)
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_site(1)]),
        scalar_result(3),  # projects outside site 1 hold the item
    ]

    response = await client.put("/api/project-fields/options/9", json={"site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "3 projects at other sites use this item"
    assert option.all_sites is True  # nothing applied
    count = _sql(mock_db_session)[2]
    assert (
        "JOIN project_field_selections ON project_field_selections.project_id = projects.id "
        "AND project_field_selections.option_id = 9"
    ) in count
    assert "projects.site_id IS NULL OR (projects.site_id NOT IN (1))" in count
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_shrinking_the_sites_is_a_409_with_a_singular_detail(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1), _site(2)])
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_site(1)]),
        scalar_result(1),
    ]

    response = await client.put("/api/project-fields/options/9", json={"site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "1 project at another site uses this item"


@pytest.mark.asyncio
async def test_widening_the_sites_needs_no_usage_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_site(1), _site(2)]),
    ]

    response = await client.put("/api/project-fields/options/9", json={"site_ids": [1, 2]})

    assert response.status_code == 200, response.text
    assert response.json()["site_ids"] == [1, 2]
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_making_an_item_global_clears_its_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)], teams=[_team(7, 1)])
    mock_db_session.execute.side_effect = [scalar_result(option)]

    response = await client.put(
        "/api/project-fields/options/9", json={"all_sites": True, "site_ids": [1, 2]}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["all_sites"], body["site_ids"], body["team_ids"]) == (True, [], [7])
    assert mock_db_session.execute.await_count == 1  # no site lookup, no count


@pytest.mark.asyncio
async def test_restricting_without_sites_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)

    for option, body in (
        (_option(9, all_sites=True), {"all_sites": False}),
        (_option(9, all_sites=True), {"all_sites": False, "site_ids": []}),
    ):
        mock_db_session.execute.side_effect = [scalar_result(option)]
        response = await client.put("/api/project-fields/options/9", json=body)
        assert response.status_code == 400, body
        assert response.json()["detail"] == OPTION_NO_SITE_DETAIL


@pytest.mark.asyncio
async def test_restricting_keeps_the_current_sites_when_none_are_sent(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=True, sites=[_site(2)])  # stale links of a global item
    mock_db_session.execute.side_effect = [scalar_result(option), scalar_result(0)]

    response = await client.put("/api/project-fields/options/9", json={"all_sites": False})

    assert response.status_code == 200, response.text
    assert (option.all_sites, option.site_ids) == (False, [2])


@pytest.mark.asyncio
async def test_limiting_an_item_to_teams_used_elsewhere_is_a_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_team(7, 1)]),
        scalar_result(1),  # one project at site 1 outside team 7 holds it
    ]

    response = await client.put("/api/project-fields/options/9", json={"team_ids": [7]})

    assert response.status_code == 409
    assert response.json()["detail"] == "1 project outside these teams uses this item"
    assert option.teams == []
    count = _sql(mock_db_session)[2]
    assert "project_field_selections.option_id = 9" in count
    assert "projects.site_id IN (1)" in count
    assert "project_teams.team_id IN (7)" in count


@pytest.mark.asyncio
async def test_limiting_an_item_to_teams(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_team(7, 1)]),
        scalar_result(0),
    ]

    response = await client.put("/api/project-fields/options/9", json={"team_ids": [7]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [7]


@pytest.mark.asyncio
async def test_resending_the_teams_needs_no_usage_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)], teams=[_team(7, 1)])
    mock_db_session.execute.side_effect = [scalar_result(option), scalars_result([_team(7, 1)])]

    response = await client.put("/api/project-fields/options/9", json={"team_ids": [7]})

    assert response.status_code == 200, response.text
    assert mock_db_session.execute.await_count == 2


@pytest.mark.asyncio
async def test_an_update_with_a_team_outside_the_item_sites_is_a_400(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(9, all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [scalar_result(option), scalars_result([_team(8, 2)])]

    response = await client.put("/api/project-fields/options/9", json={"team_ids": [8]})

    assert response.status_code == 400
    assert response.json()["detail"] == team_outside_sites_detail("Team 8")


@pytest.mark.asyncio
async def test_narrowing_the_sites_prunes_their_teams_without_a_query(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(ADMIN)
    option = _option(
        9, all_sites=False, sites=[_site(1), _site(2)], teams=[_team(7, 1), _team(8, 2)]
    )
    mock_db_session.execute.side_effect = [
        scalar_result(option),
        scalars_result([_site(1)]),
        scalar_result(0),  # nobody at site 2 holds it
    ]

    response = await client.put("/api/project-fields/options/9", json={"site_ids": [1]})

    assert response.status_code == 200, response.text
    assert response.json()["team_ids"] == [7]
    assert mock_db_session.execute.await_count == 3


@pytest.mark.asyncio
async def test_an_item_update_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_option(9)), scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error()

    response = await client.put("/api/project-fields/options/9", json={"name": "Customer"})

    assert response.status_code == 400
    assert response.json()["detail"] == DUPLICATE_OPTION_NAME_DETAIL
    mock_db_session.rollback.assert_awaited()


# ---------------------------------------------------------
# Items: delete, reorder
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_an_item(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(MANAGER)
    option = _option(9)
    mock_db_session.execute.side_effect = [scalar_result(option)]

    response = await client.delete("/api/project-fields/options/9")

    assert response.status_code == 204
    mock_db_session.delete.assert_awaited_once_with(option)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_reorder_the_items_of_a_field(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    first, second = _option(9, "A", sort_order=0), _option(10, "B", sort_order=1)
    mock_db_session.execute.side_effect = [
        scalar_result(_field(5)),
        scalars_result([first, second]),
    ]

    response = await client.put(
        "/api/project-fields/5/options/reorder", json={"option_order": [10, 9, 77]}
    )

    assert response.status_code == 200
    assert response.json() == {"success": True}
    assert (second.sort_order, first.sort_order) == (0, 1)
    # Only the field's own items move.
    reorder = _sql(mock_db_session)[1]
    assert "project_field_options.field_id = 5" in reorder
    assert "project_field_options.id IN (9, 10, 77)" in reorder
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_reordering_the_items_of_a_text_field_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(6, "Notes", "text"))]

    response = await client.put("/api/project-fields/6/options/reorder", json={"option_order": [1]})

    assert response.status_code == 400
    assert response.json()["detail"] == NOT_A_DROPDOWN_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_empty_item_reorder_only_checks_the_field(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [scalar_result(_field(5))]

    response = await client.put("/api/project-fields/5/options/reorder", json={"option_order": []})

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 1


# ---------------------------------------------------------
# Site delete removes orphaned restricted items
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_site_delete_removes_restricted_items_left_without_a_site(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(ADMIN)
    site = _site(1)
    mock_db_session.execute.side_effect = [
        scalar_result(site),
        scalars_result([]),  # events
        scalars_result([]),  # equipment
        scalars_result([]),  # projects
        scalars_result([]),  # tags linked to the site
        scalars_result([9, 10]),  # items linked to the site
        MagicMock(),  # delete orphaned restricted items
    ]

    response = await client.delete("/api/sites/1")

    assert response.status_code == 200, response.text
    sql = _sql(mock_db_session)
    assert "FROM project_field_option_sites" in sql[5]
    assert "project_field_option_sites.site_id = 1" in sql[5]
    assert sql[6].startswith("DELETE FROM project_field_options ")
    assert "project_field_options.id IN (9, 10)" in sql[6]
    assert "project_field_options.all_sites IS false" in sql[6]
    assert "NOT (EXISTS" in sql[6]
    assert "project_field_option_sites.option_id = project_field_options.id" in sql[6]
    mock_db_session.delete.assert_awaited_once_with(site)
    mock_db_session.commit.assert_awaited()
