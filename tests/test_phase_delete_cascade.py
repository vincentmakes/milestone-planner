"""
DELETE /phases/{id} and DELETE /subphases/{id} must remove the whole subtree.

``project_subphases.parent_id`` is polymorphic with no FK, and card comments /
custom-column values are polymorphic ``(entity_type, entity_id)`` rows with no
FK either -- nothing cascades from the database, so the handlers must issue
the cleanup for every descendant explicitly. Mock-based (no live DB): each
test lays out the `db.execute` results in the order the handler consumes them
and then inspects the compiled DELETE statements.
"""

from unittest.mock import MagicMock

import pytest

from tests.conftest import FakeUser


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _ids_result(*ids: int):
    result = MagicMock()
    result.all.return_value = [(i,) for i in ids]
    return result


def _phase():
    phase = MagicMock()
    phase.id = 1
    phase.project_id = 1
    phase.type = "Design"
    return phase


def _subphase():
    sp = MagicMock()
    sp.id = 10
    sp.project_id = 1
    sp.name = "Sub"
    return sp


def _executed_sql(mock_db_session) -> list[str]:
    return [
        str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
        for call in mock_db_session.execute.await_args_list
    ]


def _deletes(sql: list[str]) -> list[str]:
    return [s for s in sql if s.lstrip().upper().startswith("DELETE")]


def _find(deletes: list[str], table: str, *needles: str) -> str:
    for stmt in deletes:
        if f"DELETE FROM {table}" in stmt and all(n in stmt for n in needles):
            return stmt
    raise AssertionError(f"no DELETE FROM {table} containing {needles}: {deletes}")


@pytest.mark.asyncio
async def test_delete_phase_cleans_up_every_nested_subphase(authed_client, mock_db_session):
    """Phase 1 -> subphases 10, 11 -> 12 (under 10) -> 13 (under 12)."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_phase()),  # phase load
        _ids_result(10, 11),  # children of the phase
        _ids_result(12),  # children of 10/11
        _ids_result(13),  # children of 12
        _ids_result(),  # children of 13
        MagicMock(),  # subphase staff assignments
        MagicMock(),  # subphase card comments
        MagicMock(),  # subphase custom-column values
        MagicMock(),  # subphase rows
        MagicMock(),  # phase card comments
        MagicMock(),  # phase custom-column values
    ]

    response = await client.delete("/api/phases/1")

    assert response.status_code == 200
    deletes = _deletes(_executed_sql(mock_db_session))
    ids = "IN (10, 11, 12, 13)"
    _find(deletes, "subphase_staff_assignments", ids)
    _find(deletes, "card_comments", "'subphase'", ids)
    _find(deletes, "custom_column_values", "'subphase'", ids)
    _find(deletes, "project_subphases", ids)
    _find(deletes, "card_comments", "'phase'", "entity_id = 1")
    _find(deletes, "custom_column_values", "'phase'", "entity_id = 1")
    # Subtree first, phase row last (ORM delete, cascades its staff rows).
    mock_db_session.delete.assert_awaited_once()
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_delete_phase_starts_the_walk_from_the_phase(authed_client, mock_db_session):
    """The first level is `parent_type = 'phase'`, deeper levels are 'subphase'."""
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_phase()),
        _ids_result(10),
        _ids_result(),
        *[MagicMock() for _ in range(6)],
    ]

    response = await client.delete("/api/phases/1")

    assert response.status_code == 200
    sql = _executed_sql(mock_db_session)
    assert "parent_type = 'phase'" in sql[1]
    assert "parent_id = 1" in sql[1]
    assert "parent_type = 'subphase'" in sql[2]
    assert "IN (10)" in sql[2]


@pytest.mark.asyncio
async def test_delete_phase_without_subphases_skips_subtree_cleanup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_phase()),
        _ids_result(),
        MagicMock(),  # phase card comments
        MagicMock(),  # phase custom-column values
    ]

    response = await client.delete("/api/phases/1")

    assert response.status_code == 200
    deletes = _deletes(_executed_sql(mock_db_session))
    assert not any("project_subphases" in d for d in deletes)
    _find(deletes, "card_comments", "'phase'")


@pytest.mark.asyncio
async def test_delete_missing_phase_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [_scalar_result(None)]

    response = await client.delete("/api/phases/404")

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_subphase_includes_itself_and_its_descendants(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_subphase()),
        _ids_result(20, 21),
        _ids_result(),
        *[MagicMock() for _ in range(4)],
    ]

    response = await client.delete("/api/subphases/10")

    assert response.status_code == 200
    deletes = _deletes(_executed_sql(mock_db_session))
    ids = "IN (10, 20, 21)"
    _find(deletes, "subphase_staff_assignments", ids)
    _find(deletes, "card_comments", "'subphase'", ids)
    _find(deletes, "custom_column_values", "'subphase'", ids)
    _find(deletes, "project_subphases", ids)
