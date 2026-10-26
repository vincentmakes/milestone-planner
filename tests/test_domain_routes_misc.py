"""
Route behaviour of the smaller domain fixes:

- B2-19  GET /vacations without siteId: their own absences and, with
         absences.view_others, those of the members of their visible sites
         (admins: all). With siteId: absences.view_others and a visible site
         (RBAC Task 4; the cross-site details are in test_site_visibility.py).
- B2-7   PUT /custom-columns/values/batch validates like the single write,
         is bounded, and loads one query per column.
- B2-21  import uploads are capped (413) and the parse runs in a thread.
- B2-22  project export: PM from project.project_manager, one subphase query.
- B2-24  equipment-type rename/delete for superusers is limited to types whose
         every item is within their sites.
- B2-20  comments of a deleted author serialise with author_id/name null.
- F3-13  PUT /sites/{id} clears city/region/country on an explicit null.

Mock-based, house style (tests/conftest.py).
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.equipment import Equipment
from app.models.site import Site
from tests.conftest import FakeUser
from tests.support import card_target_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)


class _ScalarList(list):
    def all(self):
        return list(self)


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value = _ScalarList(values)
    return result


def _sql(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


# ---------------------------------------------------------------------------
# B2-19 vacations scope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "superuser"])
async def test_vacation_list_is_limited_to_visible_colleagues(authed_client, mock_db_session, role):
    client, set_user = authed_client
    set_user(FakeUser(5, role, site_ids=[1, 3]))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/vacations")

    assert response.status_code == 200
    sql = _sql(mock_db_session.execute.await_args.args[0])
    assert "vacations.staff_id = 5" in sql
    assert "vacations.staff_id IN (SELECT user_sites.user_id" in sql
    assert "user_sites.site_id IN (1, 3)" in sql


@pytest.mark.asyncio
async def test_admin_vacation_list_is_unchanged(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "admin"))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/vacations")

    assert response.status_code == 200
    sql = _sql(mock_db_session.execute.await_args.args[0])
    assert "WHERE" not in sql


@pytest.mark.asyncio
async def test_vacation_list_for_a_site_needs_a_visible_site(authed_client, mock_db_session):
    # Behaviour change (RBAC decision 6): any user used to read any site's
    # absences through ?siteId=; now only a visible site's, with
    # absences.view_others (allowed for plain users by default).
    client, set_user = authed_client
    set_user(FakeUser(5, "user", site_ids=[1]))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/vacations?siteId=1")

    assert response.status_code == 200
    sql = _sql(mock_db_session.execute.await_args.args[0])
    assert "user_sites.site_id = 1" in sql
    assert "vacations.staff_id = 5" not in sql

    mock_db_session.execute.reset_mock()
    assert (await client.get("/api/vacations?siteId=2")).status_code == 403
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# B2-7 custom-column batch writes
# ---------------------------------------------------------------------------


def _column(column_id, column_type="text", options=None):
    col = CustomColumn(id=column_id, name=f"C{column_id}", column_type=column_type)
    if options is not None:
        col.set_list_options(options)
    return col


def _phase_projects(*phase_ids):
    """The phase -> project lookup behind the value writes' site check (all project 1)."""
    result = MagicMock()
    result.all.return_value = [(pid, 1) for pid in phase_ids]
    return result


def _update(column_id, entity_id, value, entity_type="phase"):
    return {
        "custom_column_id": column_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "value": value,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("column", "value", "detail"),
    [
        (_column(1, "boolean"), "maybe", "Boolean values must be 'true' or 'false'"),
        (_column(1, "list", ["Low", "High"]), "Medium", "Value must be one of: Low, High"),
    ],
)
async def test_batch_rejects_invalid_values_before_writing(
    authed_client, mock_db_session, column, value, detail
):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [_phase_projects(10, 11), _scalars_result([column])]

    response = await client.put(
        "/api/custom-columns/values/batch",
        json={
            "updates": [
                _update(1, 10, "true" if column.column_type == "boolean" else "Low"),
                _update(1, 11, value),
            ]
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == detail
    mock_db_session.add.assert_not_called()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_is_bounded(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.put(
        "/api/custom-columns/values/batch",
        json={"updates": [_update(1, i, "x") for i in range(501)]},
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_queries_once_per_column_and_dedupes_keys(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    existing = CustomColumnValue(
        id=70,
        custom_column_id=1,
        entity_type="phase",
        entity_id=10,
        value="old",
        created_at=STAMP,
        updated_at=STAMP,
    )
    mock_db_session.execute.side_effect = [
        _phase_projects(10, 11),  # the phases' projects (site visibility)
        _scalars_result([_column(1), _column(2)]),  # the columns (one query)
        _scalars_result([existing]),  # column 1's existing values
        _scalars_result([]),  # column 2's existing values
    ]

    def add(obj):
        obj.id = 80 + len(mock_db_session.add.call_args_list)
        obj.created_at = obj.updated_at = STAMP

    mock_db_session.add.side_effect = add

    response = await client.put(
        "/api/custom-columns/values/batch",
        json={
            "updates": [
                _update(1, 10, "first"),
                _update(1, 11, "a"),
                _update(1, 10, "second"),  # same key: last one wins
                _update(2, 10, "b"),
                _update(3, 10, "c"),  # unknown column: skipped
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert mock_db_session.execute.await_count == 4  # + the phases' projects
    assert existing.value == "second"
    added = [c.args[0] for c in mock_db_session.add.call_args_list]
    assert sorted((v.custom_column_id, v.entity_id) for v in added) == [(1, 11), (2, 10)]
    body = response.json()
    assert len(body) == 3
    assert {(v["custom_column_id"], v["entity_id"], v["value"]) for v in body} == {
        (1, 10, "second"),
        (1, 11, "a"),
        (2, 10, "b"),
    }
    lookup = _sql(mock_db_session.execute.await_args_list[2].args[0])
    assert "custom_column_values.custom_column_id = 1" in lookup
    assert "('phase', 10)" in lookup and "('phase', 11)" in lookup


@pytest.mark.asyncio
async def test_batch_null_clears_any_column_type(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    mock_db_session.execute.side_effect = [
        _scalars_result([_column(1, "boolean")]),
        _scalars_result([]),
    ]

    def add(obj):
        obj.id = 1
        obj.created_at = obj.updated_at = STAMP

    mock_db_session.add.side_effect = add

    response = await client.put(
        "/api/custom-columns/values/batch", json={"updates": [_update(1, 10, None)]}
    )

    assert response.status_code == 200, response.text


# ---------------------------------------------------------------------------
# B2-21 import upload cap + threadpool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/api/import/mpp", "/api/import/test-upload", "/api/import/project"]
)
async def test_oversized_import_upload_is_413(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))

    with patch("app.routers.mpp_import.MAX_IMPORT_UPLOAD_BYTES", 16):
        response = await client.post(
            path,
            data={"site_id": "1"},
            files={"file": ("plan.mpp", b"x" * 17, "application/octet-stream")},
        )

    assert response.status_code == 413, response.text
    assert "too large" in response.json()["detail"]
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_upload_at_the_cap_is_accepted(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))

    with patch("app.routers.mpp_import.MAX_IMPORT_UPLOAD_BYTES", 16):
        response = await client.post(
            "/api/import/test-upload", files={"file": ("plan.mpp", b"x" * 16, "text/plain")}
        )

    assert response.status_code == 200
    assert response.json()["size"] == 16


@pytest.mark.asyncio
async def test_mpp_parse_runs_in_a_worker_thread(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    from app.routers import mpp_import

    calls = []

    async def fake_threadpool(func, *args):
        calls.append(func)
        return {"name": "Plan", "tasks": []}

    with (
        patch.object(mpp_import, "run_in_threadpool", side_effect=fake_threadpool),
        patch.object(mpp_import, "parse_mpp_file") as parse,
    ):
        response = await client.post(
            "/api/import/mpp", files={"file": ("plan.mpp", b"binary", "application/octet-stream")}
        )

    assert response.status_code == 200, response.text
    assert calls == [parse]
    parse.assert_not_called()  # only ever called through the threadpool


# ---------------------------------------------------------------------------
# B2-22 export hierarchy
# ---------------------------------------------------------------------------


def _sp(sp_id, parent_type, parent_id, sort_order=0):
    sp = MagicMock()
    sp.id = sp_id
    sp.parent_type = parent_type
    sp.parent_id = parent_id
    sp.sort_order = sort_order
    sp.name = f"S{sp_id}"
    sp.start_date = date(2026, 1, 1)
    sp.end_date = date(2026, 1, 9)
    sp.completion = 0
    sp.dependencies = None
    sp.is_milestone = 0
    return sp


@pytest.mark.asyncio
async def test_project_hierarchy_loads_all_subphases_in_one_query():
    from app.routers.export import build_task_list, get_project_with_hierarchy

    phase = MagicMock()
    phase.id = 1
    phase.sort_order = 0
    phase.type = "Design"
    phase.start_date = date(2026, 1, 1)
    phase.end_date = date(2026, 2, 1)
    phase.completion = 0
    phase.dependencies = None
    phase.is_milestone = 0
    project = MagicMock()
    project.id = 1
    project.name = "P"
    project.customer = "ACME"
    project.start_date = date(2026, 1, 1)
    project.end_date = date(2026, 3, 1)
    project.phases = [phase]
    project.project_manager.full_name = "Alice Martin"
    # 10, 11 under the phase; 12 under 10; 99 an orphan of a deleted phase.
    subphases = [
        _sp(10, "phase", 1),
        _sp(11, "phase", 1, 1),
        _sp(12, "subphase", 10),
        _sp(99, "phase", 404),
    ]

    db = AsyncMock()
    db.execute.side_effect = [_scalar_result(project), _scalars_result(subphases)]

    loaded = await get_project_with_hierarchy(db, 1)

    assert db.execute.await_count == 2
    assert [s.id for s in loaded.phases[0].subphases] == [10, 11]
    assert [s.id for s in subphases[0].children] == [12]
    tasks = build_task_list(loaded)
    assert [t["name"] for t in tasks] == ["P", "Design", "S10", "S12", "S11"]
    assert tasks[0]["notes"] == "Customer: ACME; PM: Alice Martin"
    first_query = _sql(db.execute.await_args_list[0].args[0])
    assert "project_subphases" not in first_query


# ---------------------------------------------------------------------------
# B2-24 equipment types
# ---------------------------------------------------------------------------

SITE_A = Site(id=1, name="Winterthur")
SITE_B = Site(id=2, name="Frankfurt")


def _equipment(equipment_id, sites):
    return Equipment(
        id=equipment_id,
        name=f"E{equipment_id}",
        type="HPLC",
        site_id=sites[0].id if sites else None,
        active=1,
        created_at=STAMP,
        sites=list(sites),
    )


@pytest.mark.asyncio
async def test_superuser_cannot_rename_a_type_used_at_other_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))  # member of site 1 only
    mock_db_session.execute.side_effect = [
        _scalars_result([_equipment(1, [SITE_A]), _equipment(2, [SITE_A, SITE_B])])
    ]

    response = await client.put("/api/equipment-types/HPLC?new_type=LC")

    assert response.status_code == 403
    assert mock_db_session.execute.await_count == 1  # no UPDATE
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_renames_a_type_used_only_at_their_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalars_result([_equipment(1, [SITE_A])]),
        MagicMock(),
    ]

    response = await client.put("/api/equipment-types/HPLC?new_type=LC")

    assert response.status_code == 200, response.text
    assert response.json()["updated_count"] == 1


@pytest.mark.asyncio
async def test_admin_renames_a_type_used_anywhere(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        _scalars_result([_equipment(1, [SITE_B]), _equipment(2, [])]),
        MagicMock(),
    ]

    response = await client.put("/api/equipment-types/HPLC?new_type=LC")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_deleting_a_type_in_use_is_409_or_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))

    mock_db_session.execute.side_effect = [_scalars_result([_equipment(1, [SITE_A])])]
    response = await client.delete("/api/equipment-types/HPLC")
    assert response.status_code == 409
    assert "still use this type" in response.json()["detail"]

    mock_db_session.execute.side_effect = [_scalars_result([_equipment(1, [SITE_B])])]
    response = await client.delete("/api/equipment-types/HPLC")
    assert response.status_code == 403

    mock_db_session.execute.side_effect = [_scalars_result([])]
    response = await client.delete("/api/equipment-types/HPLC")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# B2-20 comments of deleted authors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_comment_of_a_deleted_author_has_null_author(authed_client, mock_db_session):
    from app.models.card_comment import CardComment

    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    orphan = CardComment(
        id=3,
        entity_type="phase",
        entity_id=1,
        project_id=1,
        author_id=None,
        body="Still here",
        created_at=STAMP,
        updated_at=STAMP,
    )
    rows = MagicMock()
    rows.all.return_value = [(orphan, None, None)]
    card = SimpleNamespace(id=1, project_id=1, name=None, type="Design")
    mock_db_session.execute.side_effect = [card_target_result(card), rows]

    response = await client.get("/api/kanban/cards/phase/1/comments")

    assert response.status_code == 200, response.text
    (comment,) = response.json()
    assert comment["author_id"] is None
    assert comment["author_name"] is None
    assert comment["body"] == "Still here"


@pytest.mark.asyncio
async def test_nobody_but_moderators_can_touch_an_orphaned_comment(authed_client, mock_db_session):
    from app.models.card_comment import CardComment

    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    orphan = CardComment(
        id=3,
        entity_type="phase",
        entity_id=1,
        project_id=1,
        author_id=None,
        body="x",
        created_at=STAMP,
        updated_at=STAMP,
    )
    mock_db_session.execute.return_value = _scalar_result(orphan)

    assert (await client.put("/api/kanban/comments/3", json={"body": "y"})).status_code == 403
    assert (await client.delete("/api/kanban/comments/3")).status_code == 403


# ---------------------------------------------------------------------------
# F3-13 clearing optional site fields
# ---------------------------------------------------------------------------


def _site():
    return Site(
        id=1,
        name="Winterthur",
        location="Building 4",
        city="Winterthur",
        country_code="CH",
        region_code="ZH",
        timezone="Europe/Zurich",
        active=1,
        created_at=STAMP,
    )


@pytest.mark.asyncio
async def test_explicit_null_clears_optional_site_fields(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    site = _site()
    mock_db_session.execute.side_effect = [_scalar_result(site)]

    response = await client.put(
        "/api/sites/1", json={"city": None, "region_code": None, "country_code": None}
    )

    assert response.status_code == 200, response.text
    assert (site.city, site.region_code, site.country_code) == (None, None, None)
    assert site.location == "Building 4"  # not sent: unchanged
    assert site.name == "Winterthur"


@pytest.mark.asyncio
async def test_absent_or_null_required_site_fields_stay(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    site = _site()
    mock_db_session.execute.side_effect = [_scalar_result(site)]

    response = await client.put("/api/sites/1", json={"name": None, "timezone": None})

    assert response.status_code == 200, response.text
    assert (site.name, site.timezone, site.city, site.country_code) == (
        "Winterthur",
        "Europe/Zurich",
        "Winterthur",
        "CH",
    )
