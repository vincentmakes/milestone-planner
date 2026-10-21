"""
visible_site_ids (app/services/site_access.py): the sites a user may see, and
the checks built on it (sites, projects, equipment, people).

``None`` with ``sites.view_all`` (every site, no query); otherwise the user's
live ``user_sites`` rows -- not the login-time session snapshot -- read once
per request and cached on ``request.state``.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.site_access import (
    EQUIPMENT_NOT_FOUND_DETAIL,
    PROJECT_NOT_VISIBLE_DETAIL,
    can_access_sites,
    ensure_equipment_visible,
    ensure_person_visible,
    ensure_project_visible,
    ensure_site_access,
    ensure_site_visible,
    person_is_visible,
    site_is_visible,
    visible_site_ids,
    visible_sites_clause,
)
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


# ---------------------------------------------------------
# can_access_sites / ensure_site_access: the live visible set
# ---------------------------------------------------------


async def test_view_all_may_write_to_any_site_without_a_query(mock_db_session):
    user = FakeUser(1, "custom", {"sites.view_all"})

    assert await can_access_sites(make_request(), mock_db_session, user, [1, 2, 99]) is True
    mock_db_session.execute.assert_not_awaited()


async def test_others_may_write_only_to_their_live_sites(mock_db_session):
    # The snapshot says site 1; the live rows say 2 -- the live rows win.
    user = FakeUser(5, "superuser", site_ids=[1])
    mock_db_session.execute = AsyncMock(return_value=scalars_result([2]))
    request = make_request()

    assert await can_access_sites(request, mock_db_session, user, [2]) is True
    assert await can_access_sites(request, mock_db_session, user, [1]) is False
    assert await can_access_sites(request, mock_db_session, user, iter([2, 1])) is False


async def test_no_sites_needs_no_query(mock_db_session):
    assert await can_access_sites(make_request(), mock_db_session, FakeUser(5), []) is True
    mock_db_session.execute.assert_not_awaited()


async def test_ensure_site_access_raises_403_with_the_given_detail(mock_db_session):
    mock_db_session.execute = AsyncMock(return_value=scalars_result([2]))

    with pytest.raises(HTTPException) as exc:
        await ensure_site_access(make_request(), mock_db_session, FakeUser(5), [3], "nope")
    assert exc.value.status_code == 403
    assert exc.value.detail == "nope"

    await ensure_site_access(make_request(), mock_db_session, FakeUser(5), [2], "nope")


# ---------------------------------------------------------
# The visibility checks built on the set (RBAC Task 4). Route tests serve the
# project / equipment / person lookups from conftest's site_links; these pin
# the real queries.
# ---------------------------------------------------------


def _first(row):
    result = MagicMock()
    result.first.return_value = row
    return result


def test_site_is_visible():
    assert site_is_visible(None, 7) and site_is_visible(None, None)
    assert site_is_visible(frozenset({1}), 1)
    assert not site_is_visible(frozenset({1}), 2)
    assert not site_is_visible(frozenset({1}), None)  # site-less: view_all only


def test_visible_sites_clause():
    from app.models.project import Project

    assert visible_sites_clause(Project.site_id, None) is None
    clause = visible_sites_clause(Project.site_id, frozenset({3, 1}))
    assert " ".join(str(clause.compile(compile_kwargs={"literal_binds": True})).split()) == (
        "projects.site_id IN (1, 3)"
    )


async def test_ensure_site_visible(mock_db_session):
    mock_db_session.execute = AsyncMock(return_value=scalars_result([1]))

    await ensure_site_visible(make_request(), mock_db_session, FakeUser(5), 1)
    with pytest.raises(HTTPException) as exc:
        await ensure_site_visible(make_request(), mock_db_session, FakeUser(5), None, "x")
    assert (exc.value.status_code, exc.value.detail) == (403, "x")


async def test_project_visibility_reads_the_projects_site(mock_db_session):
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1]), _first((2,))])

    with pytest.raises(HTTPException) as exc:
        await ensure_project_visible(make_request(), mock_db_session, FakeUser(5), 4)

    assert (exc.value.status_code, exc.value.detail) == (403, PROJECT_NOT_VISIBLE_DETAIL)
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "projects.site_id" in sql and "projects.id" in sql


async def test_project_visibility_passes_at_a_visible_site(mock_db_session):
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1]), _first((1,))])

    await ensure_project_visible(make_request(), mock_db_session, FakeUser(5), 4)


async def test_a_missing_project_is_404(mock_db_session):
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1]), _first(None)])

    with pytest.raises(HTTPException) as exc:
        await ensure_project_visible(make_request(), mock_db_session, FakeUser(5), 4)
    assert exc.value.status_code == 404


async def test_view_all_sees_every_project_equipment_and_person_without_a_query(
    mock_db_session,
):
    user = FakeUser(1, "admin")
    request = make_request()

    await ensure_project_visible(request, mock_db_session, user, 4)
    await ensure_equipment_visible(request, mock_db_session, user, 7)
    assert await person_is_visible(request, mock_db_session, user, 9) is True
    mock_db_session.execute.assert_not_awaited()


async def test_equipment_visibility_reads_its_sites(mock_db_session):
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1]), scalars_result([2, 3])])

    with pytest.raises(HTTPException) as exc:
        await ensure_equipment_visible(make_request(), mock_db_session, FakeUser(5), 7)

    assert (exc.value.status_code, exc.value.detail) == (404, EQUIPMENT_NOT_FOUND_DETAIL)
    assert "FROM equipment_sites" in str(mock_db_session.execute.await_args.args[0])

    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1]), scalars_result([1, 2])])
    await ensure_equipment_visible(make_request(), mock_db_session, FakeUser(5), 7)


async def test_oneself_is_visible_without_a_query(mock_db_session):
    assert await person_is_visible(make_request(), mock_db_session, FakeUser(5), 5) is True
    mock_db_session.execute.assert_not_awaited()


async def test_a_person_is_visible_when_sharing_a_visible_site(mock_db_session):
    request = make_request()
    # The caller's live sites, then the person's.
    mock_db_session.execute = AsyncMock(side_effect=[scalars_result([1, 2]), scalars_result([2])])
    assert await person_is_visible(request, mock_db_session, FakeUser(5), 9) is True

    mock_db_session.execute = AsyncMock(return_value=scalars_result([3]))  # cached caller set
    assert await person_is_visible(request, mock_db_session, FakeUser(5), 9) is False

    with pytest.raises(HTTPException) as exc:
        await ensure_person_visible(
            request, mock_db_session, FakeUser(5), 9, status_code=404, detail="gone"
        )
    assert (exc.value.status_code, exc.value.detail) == (404, "gone")
