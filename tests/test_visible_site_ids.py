"""
visible_site_ids (app/services/site_access.py): the sites a user may see.

``None`` with ``sites.view_all`` (every site, no query); otherwise the user's
live ``user_sites`` rows -- not the login-time session snapshot -- read once
per request and cached on ``request.state``.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.services.site_access import visible_site_ids
from tests.conftest import FakeUser
from tests.support import scalars_result


def make_request():
    return SimpleNamespace(state=SimpleNamespace())


async def test_view_all_sees_every_site_without_a_query(mock_db_session):
    user = FakeUser(1, "custom", {"sites.view_all"})

    assert await visible_site_ids(make_request(), mock_db_session, user) is None
    mock_db_session.execute.assert_not_awaited()


async def test_admin_sees_every_site(mock_db_session):
    assert await visible_site_ids(make_request(), mock_db_session, FakeUser(1, "admin")) is None
    mock_db_session.execute.assert_not_awaited()


async def test_others_see_their_live_memberships(mock_db_session):
    # The session snapshot says site 1; the live rows say 2 and 3.
    user = FakeUser(5, "superuser", site_ids=[1])
    mock_db_session.execute = AsyncMock(return_value=scalars_result([2, 3]))

    visible = await visible_site_ids(make_request(), mock_db_session, user)

    assert visible == frozenset({2, 3})
    sql = " ".join(str(mock_db_session.execute.await_args.args[0]).split())
    assert "FROM user_sites" in sql and "user_sites.user_id" in sql


async def test_the_set_is_read_once_per_request(mock_db_session):
    user = FakeUser(5, "user")
    mock_db_session.execute = AsyncMock(return_value=scalars_result([4]))
    request = make_request()

    first = await visible_site_ids(request, mock_db_session, user)
    second = await visible_site_ids(request, mock_db_session, user)

    assert first == second == frozenset({4})
    mock_db_session.execute.assert_awaited_once()


async def test_the_cache_is_per_user(mock_db_session):
    request = make_request()
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([4]), scalars_result([5])])

    assert await visible_site_ids(request, mock_db_session, FakeUser(5)) == frozenset({4})
    assert await visible_site_ids(request, mock_db_session, FakeUser(6)) == frozenset({5})


async def test_no_membership_is_an_empty_set(mock_db_session):
    mock_db_session.execute = AsyncMock(return_value=scalars_result([]))

    assert await visible_site_ids(make_request(), mock_db_session, FakeUser(5)) == frozenset()
