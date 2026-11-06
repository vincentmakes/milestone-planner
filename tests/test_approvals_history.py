"""
The approval history: ``GET /approval-requests`` with ``scope=decided``,
``closed``, the ``project_id`` / ``requester_id`` / ``decided_by`` filters and
the ``before_id`` keyset cursor (app/services/approvals.py ``list_requests``).

The route tests pin the HTTP contract (the 403, the two 422s, what reaches the
query); the SQLite tests pin the meaning: whose decisions ``decided`` holds,
the ordering by ``coalesce(decided_at, updated_at)`` (a cleanup-expired row has
no ``decided_at``) and that the cursor pages without gaps or duplicates.
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.project import Project, ProjectPhase
from app.models.rbac import ApprovalRequest, Role
from app.models.site import Site
from app.models.user import User, UserSite
from app.services import approvals
from app.services.approvals import ACTION_CREATE
from app.services.permissions import permission_required_detail
from tests.conftest import FakeUser
from tests.sqlite_support import AsyncSessionFacade, sqlite_session

ADMIN = 1  # C: an admin who decided r4
REQ = 3  # A: the requester of r1, r2, r3, r5
OTHER_REQ = 4  # D: the requester of r4, r6, r7
APPROVER = 7  # B: approved r1 and r7, rejected r2; PM of project 1

# ---------------------------------------------------------
# Route contract (mocked session)
# ---------------------------------------------------------


def _request(**fields) -> ApprovalRequest:
    values = {
        "id": 50,
        "requester_id": REQ,
        "action": ACTION_CREATE,
        "project_id": 1,
        "level": "phase",
        "target_id": 11,
        "requested": '{"allocation": 80}',
        "status": "approved",
        "decided_by": APPROVER,
        "decided_at": datetime(2026, 10, 2, 9, 0),
        "created_at": datetime(2026, 10, 1, 9, 30),
        "updated_at": datetime(2026, 10, 2, 9, 0),
    }
    values.update(fields)
    return ApprovalRequest(**values)


def _row(request: ApprovalRequest, *, pm_id=APPROVER, site_id=1):
    return (request, "Alpha", pm_id, site_id, "Test User3", "Test User7", "Design")


def _rows_result(rows):
    result = MagicMock()
    result.all.return_value = rows
    result.first.return_value = rows[0] if rows else None
    return result


def _policies_result():
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    return result


def _sql(mock_db_session, index: int) -> str:
    return str(mock_db_session.execute.await_args_list[index].args[0])


@pytest.mark.asyncio
async def test_decided_lists_the_callers_decisions(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(APPROVER, "user"))
    mock_db_session.execute.side_effect = [_rows_result([_row(_request())]), _policies_result()]

    response = await client.get("/api/approval-requests?scope=decided")

    assert response.status_code == 200
    (item,) = response.json()
    assert item["status"] == "approved" and item["decided_by"] == APPROVER
    assert item["decided_by_name"] == "Test User7" and item["requester_name"] == "Test User3"
    assert item["decided_at"] == "2026-10-02T09:00:00.000Z"
    assert item["can_decide"] is False
    sql = _sql(mock_db_session, 0)
    assert "approval_requests.decided_by = " in sql
    assert "approval_requests.requester_id != " in sql  # own withdrawals are no decision
    assert "projects.site_id IN" not in sql  # one's own decisions, at any site
    assert (
        "ORDER BY coalesce(approval_requests.decided_at, approval_requests.updated_at) DESC" in sql
    )


@pytest.mark.asyncio
async def test_decided_skips_the_visible_sites_lookup(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(APPROVER, "user"))
    mock_db_session.execute.side_effect = [_rows_result([_row(_request())]), _policies_result()]

    with patch("app.services.approvals.visible_site_ids", AsyncMock()) as lookup:
        response = await client.get("/api/approval-requests?scope=decided")
        assert response.status_code == 200
        lookup.assert_not_awaited()
        assert response.json()[0]["can_decide"] is False

        mock_db_session.execute.side_effect = [_rows_result([])]
        await client.get("/api/approval-requests?scope=mine")
    lookup.assert_awaited_once()  # every other scope still reads them


@pytest.mark.asyncio
async def test_closed_combines_with_status(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    mock_db_session.execute.side_effect = [_rows_result([_row(_request())]), _policies_result()]

    response = await client.get("/api/approval-requests?scope=all&closed=true&status=approved")

    assert response.status_code == 200
    # An admin may decide anything pending; a closed row never.
    assert response.json()[0]["can_decide"] is False
    sql = _sql(mock_db_session, 0)
    assert "approval_requests.status = " in sql and "approval_requests.status != " in sql
    assert "ORDER BY coalesce(" in sql


@pytest.mark.asyncio
async def test_closed_all_needs_approvals_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))

    response = await client.get("/api/approval-requests?scope=all&closed=true")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("approvals.view_all")
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query",
    [
        "scope=mine&before_id=5",
        "scope=all&before_id=5",
        "scope=to_decide&before_id=5",
        # to_decide is pending only: closed does not make it the history.
        "scope=to_decide&closed=true&before_id=5",
    ],
)
async def test_before_id_needs_the_history_ordering(authed_client, mock_db_session, query):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))

    response = await client.get(f"/api/approval-requests?{query}")

    assert response.status_code == 422
    assert response.json() == {"detail": "before_id requires scope=decided or closed=true"}
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_before_id_is_422(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(APPROVER, "user"))
    mock_db_session.execute.side_effect = [_rows_result([])]

    response = await client.get("/api/approval-requests?scope=decided&before_id=999")

    assert response.status_code == 422
    assert response.json() == {"detail": "Unknown before_id"}
    assert "approval_requests.id = " in _sql(mock_db_session, 0)


@pytest.mark.asyncio
async def test_before_id_continues_after_the_cursor_row(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(REQ, "user"))
    cursor = (datetime(2026, 10, 2, 9, 0), 50)
    mock_db_session.execute.side_effect = [
        _rows_result([cursor]),
        _rows_result([_row(_request(id=49))]),
        _policies_result(),
    ]

    response = await client.get("/api/approval-requests?scope=mine&closed=true&before_id=50")

    assert response.status_code == 200 and [i["id"] for i in response.json()] == [49]
    sql = _sql(mock_db_session, 1)
    assert (
        "(coalesce(approval_requests.decided_at, approval_requests.updated_at), "
        "approval_requests.id) < " in sql
    )
    assert "approval_requests.status != " in sql


@pytest.mark.asyncio
async def test_to_decide_with_closed_is_empty(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(APPROVER, "user"))

    response = await client.get("/api/approval-requests?scope=to_decide&closed=true")

    assert response.status_code == 200 and response.json() == []
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_every_filter_reaches_the_query(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(ADMIN, "admin"))
    mock_db_session.execute.side_effect = [_rows_result([]), _policies_result()]

    response = await client.get(
        "/api/approval-requests?scope=all&closed=true&project_id=2&requester_id=4&decided_by=7"
    )

    assert response.status_code == 200 and response.json() == []
    sql = _sql(mock_db_session, 0)
    assert "approval_requests.project_id = " in sql
    assert "approval_requests.requester_id = " in sql
    assert "approval_requests.decided_by = " in sql


@pytest.mark.asyncio
async def test_mine_ignores_requester_and_decided_ignores_decided_by(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(FakeUser(REQ, "user"))
    mock_db_session.execute.side_effect = [
        _rows_result([]),
        _rows_result([]),
    ]

    await client.get("/api/approval-requests?scope=mine&requester_id=4")
    await client.get("/api/approval-requests?scope=decided&decided_by=1")

    mine, decided = _sql(mock_db_session, 0), _sql(mock_db_session, 1)
    assert mine.count("approval_requests.requester_id = ") == 1  # the caller only
    assert decided.count("approval_requests.decided_by = ") == 1  # the caller only


@pytest.mark.asyncio
async def test_list_rejects_a_non_integer_filter(authed_client, mock_db_session):
    client, _ = authed_client
    response = await client.get("/api/approval-requests?scope=decided&project_id=abc")
    assert response.status_code == 422


# ---------------------------------------------------------
# Query meaning (in-memory SQLite)
# ---------------------------------------------------------

_DATES = {"start_date": date(2026, 10, 1), "end_date": date(2026, 12, 1)}


def _at(minute: int) -> datetime:
    return datetime(2026, 10, 2, 10, minute)


@pytest.fixture
def history_db():
    """
    Projects 1 and 2 at site 1, project 3 at site 2. Closed requests, by the
    history key (newest first): r4 (10:04), r6 (10:03, cleanup-expired: no
    ``decided_at``, placed by ``updated_at``; tied with r3, so ``id`` breaks
    it), r3, r2, r1 (decided 10:01 though touched at 11:00), r7 (09:59); r5
    is pending.
    """
    with sqlite_session() as session:
        session.add_all(
            [
                Role(id=1, key="user", name="User"),
                Role(id=2, key="admin", name="Admin"),
                Site(id=1, name="One"),
                Site(id=2, name="Two"),
            ]
        )
        session.flush()

        def person(user_id, first, role="user"):
            return User(
                id=user_id,
                email=f"{first.lower()}@x",
                password="x",
                first_name=first,
                last_name="X",
                role=role,
            )

        session.add_all(
            [
                person(ADMIN, "Cora", "admin"),
                person(REQ, "Ada"),
                person(OTHER_REQ, "Dan"),
                person(APPROVER, "Bea"),
            ]
        )
        session.flush()
        session.add_all(
            [
                UserSite(user_id=APPROVER, site_id=1),
                UserSite(user_id=REQ, site_id=1),
                Project(id=1, name="P1", site_id=1, pm_id=APPROVER, **_DATES),
                Project(id=2, name="P2", site_id=1, pm_id=ADMIN, **_DATES),
                Project(id=3, name="P3", site_id=2, pm_id=APPROVER, **_DATES),
                ProjectPhase(id=11, project_id=1, type="Design", **_DATES),
                ProjectPhase(id=21, project_id=2, type="Build", **_DATES),
                ProjectPhase(id=31, project_id=3, type="Test", **_DATES),
            ]
        )
        session.flush()

        def request(request_id, requester, project_id, status, *, by=None, decided=None, touched):
            return ApprovalRequest(
                id=request_id,
                requester_id=requester,
                action=ACTION_CREATE,
                project_id=project_id,
                level="phase",
                target_id=project_id * 10 + 1,
                requested='{"allocation": 50}',
                status=status,
                decided_by=by,
                decided_at=decided,
                created_at=datetime(2026, 10, 1, 9, request_id),
                updated_at=touched,
            )

        session.add_all(
            [
                request(1, REQ, 1, "approved", by=APPROVER, decided=_at(1), touched=_at(59)),
                request(2, REQ, 1, "rejected", by=APPROVER, decided=_at(2), touched=_at(2)),
                # Withdrawn by its own requester: cancelled, decided_by = requester.
                request(3, REQ, 1, "cancelled", by=REQ, decided=_at(3), touched=_at(3)),
                request(4, OTHER_REQ, 2, "approved", by=ADMIN, decided=_at(4), touched=_at(4)),
                request(5, REQ, 1, "pending", touched=_at(5)),
                # APPROVAL_REQUESTS_ORPHAN_CLEANUP_SQL's shape: no decided_at.
                request(6, OTHER_REQ, 2, "expired", touched=_at(3)),
                request(
                    7,
                    OTHER_REQ,
                    3,
                    "approved",
                    by=APPROVER,
                    decided=datetime(2026, 10, 2, 9, 59),
                    touched=datetime(2026, 10, 2, 9, 59),
                ),
            ]
        )
        session.commit()
        yield AsyncSessionFacade(session)


def _http():
    return SimpleNamespace(state=SimpleNamespace())


async def _ids(db, user, **params) -> list[int]:
    return [i["id"] for i in await approvals.list_requests(db, _http(), user, **params)]


@pytest.mark.asyncio
async def test_decided_holds_only_the_callers_decisions_of_others(history_db):
    approver = FakeUser(APPROVER, "user", site_ids=[1])
    items = await approvals.list_requests(history_db, _http(), approver, scope="decided")
    # r7 sits at a site Bea does not see: her own decision still shows.
    assert [i["id"] for i in items] == [2, 1, 7]
    assert all(not i["can_decide"] for i in items)
    assert items[0]["decided_by_name"] == "Bea X" and items[0]["requester_name"] == "Ada X"

    # Ada's own withdrawal (r3) is no decision.
    assert await _ids(history_db, FakeUser(REQ, "user"), scope="decided") == []
    assert await _ids(history_db, FakeUser(ADMIN, "admin"), scope="decided") == [4]


@pytest.mark.asyncio
async def test_all_closed_orders_by_when_the_request_closed(history_db):
    admin = FakeUser(ADMIN, "admin")
    # r6 has no decided_at: it sorts by updated_at (tied with r3, the higher
    # id first), not first nor last; r1 by decided_at despite its late touch.
    assert await _ids(history_db, admin, scope="all", closed=True) == [4, 6, 3, 2, 1, 7]
    # Without closed the list keeps created_at ordering and the pending row.
    assert await _ids(history_db, admin, scope="all") == [7, 6, 5, 4, 3, 2, 1]


@pytest.mark.asyncio
async def test_all_closed_keeps_the_site_clause(history_db):
    auditor = FakeUser(APPROVER, "user", {"approvals.view_all"}, site_ids=[1])
    assert await _ids(history_db, auditor, scope="all", closed=True) == [4, 6, 3, 2, 1]


@pytest.mark.asyncio
async def test_mine_closed_drops_the_pending_request(history_db):
    requester = FakeUser(REQ, "user")
    assert await _ids(history_db, requester, scope="mine", closed=True) == [3, 2, 1]
    assert (
        await _ids(history_db, requester, scope="mine", closed=True, status_filter="pending") == []
    )


@pytest.mark.asyncio
async def test_cursor_pages_without_gaps_or_duplicates(history_db):
    admin = FakeUser(ADMIN, "admin")
    pages: list[list[int]] = []
    before_id = None
    while True:
        page = await _ids(history_db, admin, scope="all", closed=True, limit=2, before_id=before_id)
        if not page:
            break
        pages.append(page)
        before_id = page[-1]
    # The first boundary splits the r6/r3 tie and follows the NULL-decided_at row.
    assert pages == [[4, 6], [3, 2], [1, 7]]

    approver = FakeUser(APPROVER, "user", site_ids=[1])
    assert await _ids(history_db, approver, scope="decided", limit=1) == [2]
    assert await _ids(history_db, approver, scope="decided", limit=1, before_id=2) == [1]
    assert await _ids(history_db, approver, scope="decided", limit=1, before_id=1) == [7]
    # A cursor outside the caller's list still works as a position.
    assert await _ids(history_db, approver, scope="decided", before_id=6) == [2, 1, 7]


@pytest.mark.asyncio
async def test_filters_narrow(history_db):
    admin = FakeUser(ADMIN, "admin")
    closed_all = {"scope": "all", "closed": True}
    assert await _ids(history_db, admin, **closed_all, project_id=2) == [4, 6]
    assert await _ids(history_db, admin, **closed_all, requester_id=OTHER_REQ) == [4, 6, 7]
    assert await _ids(history_db, admin, **closed_all, decided_by=APPROVER) == [2, 1, 7]
    assert (await _ids(history_db, admin, **closed_all, requester_id=REQ, decided_by=APPROVER)) == [
        2,
        1,
    ]

    approver = FakeUser(APPROVER, "user", site_ids=[1])
    assert await _ids(history_db, approver, scope="decided", project_id=1) == [2, 1]
    assert await _ids(history_db, approver, scope="decided", requester_id=OTHER_REQ) == [7]
    # decided ignores decided_by, mine ignores requester_id: both are the caller.
    assert await _ids(history_db, approver, scope="decided", decided_by=ADMIN) == [2, 1, 7]
    requester = FakeUser(REQ, "user")
    assert await _ids(history_db, requester, scope="mine", requester_id=OTHER_REQ) == [5, 3, 2, 1]

    # to_decide takes the filters too: Bea manages project 1 (r5 pending).
    assert await _ids(history_db, approver, scope="to_decide") == [5]
    assert await _ids(history_db, approver, scope="to_decide", project_id=2) == []
    assert await _ids(history_db, approver, scope="to_decide", requester_id=REQ) == [5]
