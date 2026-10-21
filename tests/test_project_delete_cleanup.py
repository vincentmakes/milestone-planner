"""
B2-8: deleting a project -- directly or with its site -- removes the rows that
hang off it without an FK: custom-column values of the project, its phases and
subphases, and its card comments (plus the subphase subtree's assignments).

Mock-based: each test lays out the `db.execute` results in the order the
handler consumes them and inspects the compiled statements.
"""

from unittest.mock import MagicMock

import pytest

from app.models.site import Site
from tests.conftest import FakeUser


def _scalar_result(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _scalars_result(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = values
    return result


def _sql(mock_db_session) -> list[str]:
    return [
        str(call.args[0].compile(compile_kwargs={"literal_binds": True}))
        for call in mock_db_session.execute.await_args_list
    ]


def _project():
    project = MagicMock()
    project.id = 1
    project.site_id = 1  # the caller's site
    project.name = "Bioprocess"
    return project


def _find(statements: list[str], *needles: str) -> str:
    for stmt in statements:
        if all(n in stmt for n in needles):
            return stmt
    raise AssertionError(f"no statement with {needles}: {statements}")


@pytest.mark.asyncio
async def test_delete_project_removes_values_and_comments(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_project()),  # project load
        _scalars_result([]),  # its pending approval requests: none
        _scalars_result([10, 11]),  # the project's subphases
        *[MagicMock() for _ in range(4)],  # subphase subtree cleanup
        MagicMock(),  # custom-column values of project + phases
        MagicMock(),  # card comments of the project
        *[MagicMock() for _ in range(3)],  # phases, project assignments, equipment bookings
    ]

    response = await client.delete("/api/projects/1")

    assert response.status_code == 200, response.text
    sql = _sql(mock_db_session)
    _find(sql, "DELETE FROM subphase_staff_assignments", "IN (10, 11)")
    _find(sql, "DELETE FROM custom_column_values", "'subphase'", "IN (10, 11)")
    _find(sql, "DELETE FROM card_comments", "'subphase'", "IN (10, 11)")
    _find(sql, "DELETE FROM project_subphases", "IN (10, 11)")
    values = _find(sql, "DELETE FROM custom_column_values", "'project'")
    assert "'phase'" in values and "project_phases.project_id IN (1)" in values
    _find(sql, "DELETE FROM card_comments", "card_comments.project_id IN (1)")
    _find(sql, "DELETE FROM project_phases", "project_id = 1")
    mock_db_session.delete.assert_awaited_once()
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_delete_project_without_subphases_still_cleans_values(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    mock_db_session.execute.side_effect = [
        _scalar_result(_project()),
        _scalars_result([]),  # no pending approval requests
        _scalars_result([]),  # no subphases: no subtree statements
        MagicMock(),  # values
        MagicMock(),  # comments
        *[MagicMock() for _ in range(3)],
    ]

    response = await client.delete("/api/projects/1")

    assert response.status_code == 200
    sql = _sql(mock_db_session)
    assert not any("project_subphases" in s and s.startswith("DELETE") for s in sql)
    _find(sql, "DELETE FROM custom_column_values", "'project'")


@pytest.mark.asyncio
async def test_delete_site_cleans_up_after_its_projects(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    site = Site(id=3, name="Winterthur")
    mock_db_session.execute.side_effect = [
        _scalar_result(site),
        _scalars_result([]),  # events
        _scalars_result([]),  # equipment
        _scalars_result([21, 22]),  # the site's projects
        _scalars_result([]),  # their subphases
        MagicMock(),  # values
        MagicMock(),  # comments
        _scalars_result([]),  # tags restricted to the site
    ]

    response = await client.delete("/api/sites/3")

    assert response.status_code == 200, response.text
    sql = _sql(mock_db_session)
    assert "projects.site_id = 3" in sql[3]
    _find(sql, "DELETE FROM custom_column_values", "'project'", "IN (21, 22)")
    _find(sql, "DELETE FROM card_comments", "card_comments.project_id IN (21, 22)")
    # The site row itself still goes through the ORM (projects cascade).
    mock_db_session.delete.assert_awaited_once_with(site)
