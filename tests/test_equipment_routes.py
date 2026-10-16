"""
Route-level tests for multi-site equipment.

Mock-based, following the house style: no live DB, dependencies overridden in
tests/conftest.py. FakeUser belongs to site 1 only, which drives the superuser
site-membership checks.
"""

from datetime import date, datetime
from unittest.mock import MagicMock

import pytest

from app.models.equipment import Equipment, EquipmentBlock
from app.models.site import Site
from tests.conftest import FakeUser

STAMP = datetime(2026, 1, 1, 12, 0, 0)

SITE_A = Site(id=1, name="Winterthur")
SITE_B = Site(id=2, name="Frankfurt")


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


def _pairs_result(rows):
    """Rows of (Equipment, Site), as GET /equipment reads them."""
    result = MagicMock()
    result.all.return_value = rows
    return result


def _equipment(equipment_id=7, name="HPLC", sites=(SITE_A,)):
    sites = list(sites)
    return Equipment(
        id=equipment_id,
        name=name,
        type="Analytical",
        site_id=sites[0].id if sites else None,
        description=None,
        active=1,
        created_at=STAMP,
        sites=sites,
    )


def _added(db, model):
    found = [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], model)]
    for c in db.add_all.call_args_list:
        found.extend(obj for obj in c.args[0] if isinstance(obj, model))
    return found


def _statements(db) -> list[str]:
    return [str(c.args[0]) for c in db.execute.call_args_list]


@pytest.fixture
def db_assigns_ids(mock_db_session):
    """Simulate refresh() assigning an id and loading created_at."""

    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 100
        if getattr(obj, "created_at", None) is None:
            obj.created_at = STAMP

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


# ---------------------------------------------------------
# Reads
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_equipment_list_returns_one_row_per_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    shared = _equipment(7, "HPLC", sites=[SITE_A, SITE_B])
    local = _equipment(8, "Centrifuge", sites=[SITE_B])
    mock_db_session.execute.return_value = _pairs_result(
        [(local, SITE_B), (shared, SITE_A), (shared, SITE_B)]
    )

    response = await client.get("/api/equipment?includeAllSites=true")

    assert response.status_code == 200
    rows = response.json()
    assert isinstance(rows, list)  # no pagination envelope, like /staff
    assert [(r["id"], r["site_id"], r["site_name"], r["site_ids"]) for r in rows] == [
        (8, 2, "Frankfurt", [2]),
        (7, 1, "Winterthur", [1, 2]),
        (7, 2, "Frankfurt", [1, 2]),
    ]
    assert rows[1]["site_names"] == ["Winterthur", "Frankfurt"]


@pytest.mark.asyncio
async def test_equipment_list_filters_through_the_junction(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _pairs_result([])

    response = await client.get("/api/equipment?siteId=2")

    assert response.status_code == 200
    assert response.json() == []
    (statement,) = _statements(mock_db_session)
    assert "LEFT OUTER JOIN equipment_sites" in statement
    assert "equipment_sites.site_id = " in statement


@pytest.mark.asyncio
async def test_equipment_detail_reports_every_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalar_result(_equipment(7, sites=[SITE_A, SITE_B]))

    response = await client.get("/api/equipment/7")

    assert response.status_code == 200
    body = response.json()
    assert (body["site_id"], body["site_name"]) == (1, "Winterthur")  # primary site
    assert body["site_ids"] == [1, 2]
    assert body["site_names"] == ["Winterthur", "Frankfurt"]


@pytest.mark.asyncio
async def test_all_equipment_lists_each_item_once(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalars_result(
        [_equipment(7, sites=[SITE_A, SITE_B]), _equipment(8, "Centrifuge", sites=[SITE_B])]
    )

    response = await client.get("/api/equipment/all")

    assert response.status_code == 200
    assert [(e["id"], e["site_ids"]) for e in response.json()] == [(7, [1, 2]), (8, [2])]


# ---------------------------------------------------------
# Create
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_equipment_on_several_sites(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = db_assigns_ids
    db.execute.return_value = _scalars_result([SITE_A, SITE_B])  # both sites exist

    response = await client.post(
        "/api/equipment", json={"name": "HPLC", "type": "Analytical", "site_ids": [2, 1, 2]}
    )

    assert response.status_code == 201
    body = response.json()
    assert body["id"] == 100
    assert body["site_ids"] == [1, 2]
    assert body["site_id"] == 1  # legacy field: first linked site
    (equipment,) = _added(db, Equipment)
    assert equipment.site_id == 1
    assert [s.id for s in equipment.sites] == [1, 2]
    db.commit.assert_awaited()


@pytest.mark.asyncio
async def test_create_equipment_accepts_legacy_site_id(authed_client, db_assigns_ids):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    db.execute.return_value = _scalars_result([SITE_A])

    response = await client.post("/api/equipment", json={"name": "HPLC", "site_id": 1})

    assert response.status_code == 201
    assert response.json()["site_ids"] == [1]


@pytest.mark.asyncio
async def test_create_equipment_requires_a_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))

    assert (await client.post("/api/equipment", json={"name": "HPLC"})).status_code == 422
    assert (
        await client.post("/api/equipment", json={"name": "HPLC", "site_ids": []})
    ).status_code == 422
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_create_equipment_on_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalars_result([SITE_A])

    response = await client.post("/api/equipment", json={"name": "HPLC", "site_ids": [1, 9]})

    assert response.status_code == 404
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_superuser_cannot_create_equipment_on_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))  # member of site 1 only
    mock_db_session.execute.return_value = _scalars_result([SITE_A, SITE_B])

    response = await client.post("/api/equipment", json={"name": "HPLC", "site_ids": [1, 2]})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_plain_users_cannot_write_equipment(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    assert (
        await client.post("/api/equipment", json={"name": "X", "site_ids": [1]})
    ).status_code == 403
    assert (await client.put("/api/equipment/7", json={"name": "X"})).status_code == 403
    assert (await client.delete("/api/equipment/7")).status_code == 403


# ---------------------------------------------------------
# Update / delete
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_update_equipment_replaces_site_links(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    equipment = _equipment(7, sites=[SITE_A])
    mock_db_session.execute.side_effect = [_scalar_result(equipment), _scalars_result([SITE_B])]

    response = await client.put("/api/equipment/7", json={"name": "HPLC 2", "site_ids": [2]})

    assert response.status_code == 200
    body = response.json()
    assert (body["name"], body["site_id"], body["site_ids"]) == ("HPLC 2", 2, [2])
    assert equipment.site_id == 2
    assert [s.id for s in equipment.sites] == [2]
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_update_equipment_without_sites_keeps_links(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    equipment = _equipment(7, sites=[SITE_A])
    mock_db_session.execute.return_value = _scalar_result(equipment)

    response = await client.put("/api/equipment/7", json={"active": 0})

    assert response.status_code == 200
    assert response.json()["site_ids"] == [1]
    assert equipment.active == 0
    assert mock_db_session.execute.await_count == 1  # no site lookup


@pytest.mark.asyncio
async def test_superuser_cannot_edit_equipment_shared_with_a_foreign_site(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalar_result(_equipment(7, sites=[SITE_A, SITE_B]))

    response = await client.put("/api/equipment/7", json={"name": "X"})

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_move_equipment_to_a_foreign_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    equipment = _equipment(7, sites=[SITE_A])
    mock_db_session.execute.side_effect = [_scalar_result(equipment), _scalars_result([SITE_B])]

    response = await client.put("/api/equipment/7", json={"site_ids": [2]})

    assert response.status_code == 403
    assert [s.id for s in equipment.sites] == [1]
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_update_unknown_equipment_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = _scalar_result(None)

    assert (await client.put("/api/equipment/7", json={"name": "X"})).status_code == 404
    assert (await client.delete("/api/equipment/7")).status_code == 404


@pytest.mark.asyncio
async def test_delete_equipment_needs_access_to_every_site(authed_client, mock_db_session):
    client, set_user = authed_client
    shared = _equipment(7, sites=[SITE_A, SITE_B])
    mock_db_session.execute.return_value = _scalar_result(shared)

    set_user(FakeUser(1, "superuser"))
    assert (await client.delete("/api/equipment/7")).status_code == 403
    mock_db_session.delete.assert_not_awaited()

    set_user(FakeUser(1, "admin"))
    assert (await client.delete("/api/equipment/7")).status_code == 200
    mock_db_session.delete.assert_awaited_once_with(shared)


# ---------------------------------------------------------
# Site delete keeps shared equipment
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_site_delete_removes_only_equipment_left_without_a_site(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        _scalar_result(SITE_A),  # the site
        _scalars_result([]),  # no events linked
        _scalars_result([7, 8]),  # equipment linked to the site
        _scalars_result([]),  # the site's projects (none: no comment/value cleanup)
        _scalars_result([]),  # tags restricted to the site (none: no tag cleanup)
        MagicMock(),  # delete orphaned equipment
        MagicMock(),  # re-point survivors' site_id
    ]

    response = await client.delete("/api/sites/1")

    assert response.status_code == 200
    mock_db_session.delete.assert_awaited_once_with(SITE_A)
    statements = _statements(mock_db_session)
    assert len(statements) == 7
    assert statements[5].startswith("DELETE FROM equipment ")
    assert "NOT (EXISTS" in statements[5] and "equipment_sites" in statements[5]
    assert statements[6].startswith("UPDATE equipment SET site_id=")
    assert "min(equipment_sites.site_id)" in statements[6]
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_site_delete_without_linked_equipment_skips_the_cleanup(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [
        _scalar_result(SITE_A),
        _scalars_result([]),  # events
        _scalars_result([]),  # equipment
        _scalars_result([]),  # projects
        _scalars_result([]),  # tags restricted to the site
    ]

    response = await client.delete("/api/sites/1")

    assert response.status_code == 200
    assert mock_db_session.execute.await_count == 5


# ---------------------------------------------------------
# Equipment blocks
# ---------------------------------------------------------


def _block(block_id=3, equipment=None):
    block = EquipmentBlock(
        id=block_id,
        equipment_id=(equipment or _equipment()).id,
        start_date=date(2026, 4, 1),
        end_date=date(2026, 4, 3),
        reason="maintenance",
        description="Calibration",
        created_at=STAMP,
    )
    block.equipment = equipment or _equipment()
    return block


@pytest.mark.asyncio
async def test_block_list_for_a_site_joins_through_equipment_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result(
        [_block(3, _equipment(7, sites=[SITE_A, SITE_B]))]
    )

    response = await client.get("/api/equipment-blocks?siteId=2")

    assert response.status_code == 200
    assert [(b["id"], b["equipment_id"], b["equipment_name"]) for b in response.json()] == [
        (3, 7, "HPLC")
    ]
    (statement,) = _statements(mock_db_session)
    assert (
        "JOIN equipment_sites ON equipment_sites.equipment_id = equipment_blocks.equipment_id"
        in statement
    )
    assert "equipment_sites.site_id = " in statement


@pytest.mark.asyncio
async def test_block_create_needs_access_to_every_site_of_the_equipment(
    authed_client, db_assigns_ids
):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    db = db_assigns_ids
    payload = {"equipment_id": 7, "start_date": "2026-04-01", "end_date": "2026-04-03"}

    db.get.return_value = _equipment(7, sites=[SITE_A, SITE_B])
    assert (await client.post("/api/equipment-blocks", json=payload)).status_code == 403
    db.add.assert_not_called()

    db.get.return_value = _equipment(7, sites=[SITE_A])
    response = await client.post("/api/equipment-blocks", json=payload)
    assert response.status_code == 201
    assert response.json()["equipment_name"] == "HPLC"
    (block,) = _added(db, EquipmentBlock)
    assert block.equipment_id == 7


@pytest.mark.asyncio
async def test_block_edit_and_delete_need_access_to_every_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    mock_db_session.execute.return_value = _scalar_result(
        _block(3, _equipment(7, sites=[SITE_A, SITE_B]))
    )

    assert (
        await client.put("/api/equipment-blocks/3", json={"description": "X"})
    ).status_code == 403
    assert (await client.delete("/api/equipment-blocks/3")).status_code == 403
    mock_db_session.commit.assert_not_awaited()

    mock_db_session.execute.return_value = _scalar_result(_block(3, _equipment(7, sites=[SITE_A])))
    assert (
        await client.put("/api/equipment-blocks/3", json={"description": "X"})
    ).status_code == 200
    assert (await client.delete("/api/equipment-blocks/3")).status_code == 200
