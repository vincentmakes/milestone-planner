"""
DELETE /api/sites/{id} refuses to delete the last active site (2.1.0).

Every active site row is locked FOR UPDATE, in id order, before they are
counted, so two concurrent deletes of the last two active sites cannot both
pass. An inactive site never lowers the count and takes no lock. The cleanup
after a delete is covered by the site-delete tests of the equipment, tags,
project-field and project-cleanup suites.
"""

from unittest.mock import MagicMock

import pytest
from sqlalchemy.dialects import postgresql

from app.models.site import Site
from app.routers.sites import LAST_SITE_DETAIL
from tests.conftest import FakeUser

ADMIN = FakeUser(1, "admin")


def _scalar(value):
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    return result


def _scalars(values):
    result = MagicMock()
    result.scalars.return_value.all.return_value = list(values)
    return result


def _sql(mock_db_session) -> list[str]:
    return [
        " ".join(
            str(
                call.args[0].compile(
                    dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
                )
            ).split()
        )
        for call in mock_db_session.execute.await_args_list
    ]


@pytest.mark.asyncio
async def test_the_last_active_site_cannot_be_deleted(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    site = Site(id=3, name="Frankfurt", active=1)
    mock_db_session.execute.side_effect = [_scalar(site), _scalars([3])]

    response = await client.delete("/api/sites/3")

    assert response.status_code == 409
    assert response.json()["detail"] == LAST_SITE_DETAIL
    lock = _sql(mock_db_session)[1]
    assert lock == (
        "SELECT sites.id FROM sites WHERE sites.active = 1 ORDER BY sites.id FOR UPDATE"
    )
    mock_db_session.delete.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_active_site_left_at_all_is_still_the_last_one(authed_client, mock_db_session):
    # A concurrent delete removed every other active row while this one waited.
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [
        _scalar(Site(id=3, name="Frankfurt", active=1)),
        _scalars([]),
    ]

    response = await client.delete("/api/sites/3")

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_an_active_site_goes_while_another_one_is_active(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    site = Site(id=3, name="Frankfurt", active=1)
    mock_db_session.execute.side_effect = [
        _scalar(site),
        _scalars([1, 3]),  # the active sites, locked
        _scalars([]),  # events
        _scalars([]),  # equipment
        _scalars([]),  # projects
        _scalars([]),  # tags restricted to the site
        _scalars([]),  # project-field items restricted to the site
    ]

    response = await client.delete("/api/sites/3")

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True}
    assert "FOR UPDATE" in _sql(mock_db_session)[1]
    mock_db_session.delete.assert_awaited_once_with(site)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_an_inactive_site_is_deleted_without_the_lock(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    site = Site(id=4, name="Old lab", active=0)
    mock_db_session.execute.side_effect = [
        _scalar(site),
        _scalars([]),  # events
        _scalars([]),  # equipment
        _scalars([]),  # projects
        _scalars([]),  # tags
        _scalars([]),  # project-field items
    ]

    response = await client.delete("/api/sites/4")

    assert response.status_code == 200, response.text
    assert not any("FOR UPDATE" in sql for sql in _sql(mock_db_session))
    mock_db_session.delete.assert_awaited_once_with(site)


@pytest.mark.asyncio
async def test_an_unknown_site_is_a_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(ADMIN)
    mock_db_session.execute.side_effect = [_scalar(None)]

    response = await client.delete("/api/sites/99")

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_deleting_a_site_needs_sites_manage(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))

    response = await client.delete("/api/sites/3")

    assert response.status_code == 403
    mock_db_session.execute.assert_not_awaited()
