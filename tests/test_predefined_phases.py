"""
Route-level tests for predefined-phase reordering.

The request field is `phase_order` on both ends: the modal sends it and the
router reads it. A schema that named it differently (it once said
`phaseOrder`) rejected every reorder with a 422 the modal swallowed.
"""

from unittest.mock import MagicMock

import pytest

from tests.conftest import FakeUser


def _phase(phase_id: int, sort_order: int):
    phase = MagicMock()
    phase.id = phase_id
    phase.sort_order = sort_order
    return phase


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


@pytest.mark.asyncio
async def test_reorder_applies_the_new_order(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    first, second = _phase(1, 0), _phase(2, 1)
    mock_db_session.execute.side_effect = [_scalar_result(second), _scalar_result(first)]

    response = await client.put("/api/predefined-phases/reorder", json={"phase_order": [2, 1]})

    assert response.status_code == 200
    assert second.sort_order == 0
    assert first.sort_order == 1
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_reorder_without_an_order_is_rejected(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.put("/api/predefined-phases/reorder", json={})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_reorder_requires_superuser(authed_client):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await client.put("/api/predefined-phases/reorder", json={"phase_order": [1]})

    assert response.status_code == 403
