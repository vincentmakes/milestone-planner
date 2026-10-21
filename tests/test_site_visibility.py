"""
Site visibility on reads and writes (RBAC decision 6), and the view keys.

Without ``sites.view_all`` a user sees and acts on their visible sites only
(their live ``user_sites``); with it (the admin by default) every endpoint
behaves as before. The callers below sit at site 1; the data under test sits
at site 2 unless a case says otherwise. ``site_links`` (tests/conftest.py)
places other people and projects at their sites.

The view keys gate the reads of their view: ``views.kanban`` (``/kanban``
reads), ``views.staff`` (per-person availability and assignments),
``views.equipment`` (equipment and block reads), ``views.crosssite``
(``includeOtherSites``), ``views.archived`` (archived projects) and
``absences.view_others`` (colleagues' absences).
"""

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy.dialects import postgresql

from app.models.equipment import Equipment
from app.models.site import Site
from app.models.team import Team
from app.services.permissions import default_modes, permission_required_detail
from app.services.site_access import PROJECT_NOT_VISIBLE_DETAIL, SITE_NOT_VISIBLE_DETAIL
from tests.conftest import FakeUser
from tests.support import _ScalarList, scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
OTHER = 9  # a person at site 2
SPAN = {"start_date": "2026-01-05", "end_date": "2026-01-09"}
# Every users.* / skills key a superuser lacks, but still site 1 only.
HR = {
    **default_modes("superuser"),
    "users.create": "allow",
    "users.delete": "allow",
    "users.toggle_active": "allow",
}


def superuser() -> FakeUser:
    """The shipped superuser at site 1 (no ``sites.view_all``)."""
    return FakeUser(5, "superuser", site_ids=[1])


def admin() -> FakeUser:
    """The admin, member of site 1 only (``sites.view_all`` sees site 2 anyway)."""
    return FakeUser(1, "admin", site_ids=[1])


def without(role: str, *keys: str) -> FakeUser:
    """A role's shipped defaults minus `keys`, at site 1."""
    modes = {k: m for k, m in default_modes(role).items() if k not in keys}
    return FakeUser(5, role, modes, site_ids=[1])


def empty_result() -> MagicMock:
    """A result answering every list / scalar read with nothing."""
    result = MagicMock()
    result.scalars.return_value = _ScalarList([])
    result.all.return_value = []
    result.first.return_value = None
    result.scalar.return_value = 0
    result.scalar_one_or_none.return_value = None
    result.unique.return_value.all.return_value = []
    result.unique.return_value.scalars.return_value = _ScalarList([])
    result.unique.return_value.scalar_one_or_none.return_value = None
    result.__iter__.return_value = iter([])
    return result


def executed_sql(mock_db_session) -> str:
    """Every statement the handler ran, rendered with literal values."""
    return "\n".join(
        " ".join(
            str(
                call.args[0].compile(
                    dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
                )
            ).split()
        )
        for call in mock_db_session.execute.await_args_list
    )


def first_result(row) -> MagicMock:
    result = MagicMock()
    result.first.return_value = row
    return result


@pytest.fixture
def at_site_2(site_links):
    """Project 1 and person OTHER live at site 2."""
    site_links.projects[1] = 2
    site_links.people[OTHER] = [2]
    return site_links


# ---------------------------------------------------------
# Sites
# ---------------------------------------------------------


async def test_site_list_is_limited_to_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/sites")).status_code == 200
    assert "sites.id IN (1)" in executed_sql(mock_db_session)


async def test_site_list_is_unfiltered_with_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/sites")).status_code == 200
    assert "sites.id IN" not in executed_sql(mock_db_session)


async def test_a_site_outside_the_visible_ones_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get("/api/sites/2")

    assert response.status_code == 404
    mock_db_session.execute.assert_not_awaited()


async def test_view_all_reads_any_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = scalar_result(
        Site(id=2, name="Basel", timezone="Europe/Zurich", active=1, created_at=STAMP)
    )

    response = await client.get("/api/sites/2")

    assert response.status_code == 200
    assert response.json()["id"] == 2


# ---------------------------------------------------------
# GET /projects
# ---------------------------------------------------------


async def test_project_list_without_site_is_limited_to_visible_sites(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/projects")).status_code == 200
    sql = executed_sql(mock_db_session)
    assert sql.count("projects.site_id IN (1)") == 2  # the count and the page


async def test_project_list_is_unfiltered_with_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/projects")).status_code == 200
    assert "projects.site_id IN" not in executed_sql(mock_db_session)


async def test_project_list_for_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get("/api/projects?siteId=2")

    assert response.status_code == 403
    assert response.json()["detail"] == SITE_NOT_VISIBLE_DETAIL
    mock_db_session.execute.assert_not_awaited()


async def test_view_all_lists_projects_of_any_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/projects?siteId=2")).status_code == 200
    assert "projects.site_id = 2" in executed_sql(mock_db_session)


async def test_cross_site_list_is_limited_to_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser", site_ids=[1, 3]))
    mock_db_session.execute.return_value = empty_result()

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 200
    assert "projects.site_id IN (1, 3)" in executed_sql(mock_db_session)


async def test_cross_site_list_needs_views_crosssite(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without("user", "views.crosssite"))

    response = await client.get("/api/projects?siteId=1&includeOtherSites=true")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.crosssite")


async def test_archived_projects_need_views_archived(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without("user", "views.archived"))

    response = await client.get("/api/projects?archived=true")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.archived")


async def test_archived_all_without_views_archived_lists_active_projects_only(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(without("user", "views.archived"))
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/projects?archived=all")).status_code == 200
    assert "projects.archived = 0" in executed_sql(mock_db_session)


async def test_archived_all_with_views_archived_lists_everything(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/projects?archived=all")).status_code == 200
    assert "projects.archived =" not in executed_sql(mock_db_session)


# ---------------------------------------------------------
# GET /projects/{id}
# ---------------------------------------------------------


def _project(site_id: int, archived: int = 0) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        name="Project",
        site_id=site_id,
        customer=None,
        pm_id=None,
        sales_pm=None,
        confirmed=1,
        volume=None,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 3, 31),
        notes=None,
        archived=archived,
        created_at=STAMP,
        updated_at=STAMP,
        tags=[],
        team_ids=[],
    )


async def test_project_detail_outside_the_visible_sites_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.side_effect = [first_result((_project(2), "Basel", None))]

    response = await client.get("/api/projects/1")

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    assert mock_db_session.execute.await_count == 1


async def test_view_all_reads_any_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [first_result((_project(2), "Basel", None))] + [
        empty_result() for _ in range(6)
    ]

    response = await client.get("/api/projects/1")

    assert response.status_code == 200
    assert response.json()["site_id"] == 2


async def test_an_archived_project_needs_views_archived(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without("user", "views.archived"))
    mock_db_session.execute.side_effect = [first_result((_project(1, archived=1), "Zurich", None))]

    response = await client.get("/api/projects/1")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.archived")


# ---------------------------------------------------------
# Project writes
# ---------------------------------------------------------


async def test_creating_a_project_at_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.post("/api/projects", json={"name": "P", "site_id": 2, **SPAN})

    assert response.status_code == 403
    assert response.json()["detail"] == SITE_NOT_VISIBLE_DETAIL
    mock_db_session.add.assert_not_called()


async def test_a_site_less_project_needs_view_all(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.post("/api/projects", json={"name": "P", **SPAN})

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


async def test_view_all_creates_a_project_at_any_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = scalar_result(2)  # the site exists

    response = await client.post("/api/projects", json={"name": "P", "site_id": 2, **SPAN})

    assert response.status_code == 200
    mock_db_session.commit.assert_awaited_once()


def _loaded_project(site_id: int) -> MagicMock:
    project = MagicMock()
    project.id = 1
    project.site_id = site_id
    project.pm_id = None
    project.name = "Project"
    project.archived = 0
    project.tags = []
    project.team_ids = []
    return project


async def test_updating_a_project_outside_is_403_even_for_edit_any(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.side_effect = [scalar_result(_loaded_project(2))]

    response = await client.put("/api/projects/1", json={"name": "Renamed"})

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.commit.assert_not_awaited()


async def test_view_all_updates_a_project_anywhere(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar_result(_loaded_project(2))]

    response = await client.put("/api/projects/1", json={"name": "Renamed"})

    assert response.status_code == 200


async def test_deleting_a_project_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.side_effect = [scalar_result(_loaded_project(2))]

    response = await client.delete("/api/projects/1")

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


def _phase(project_id: int = 1) -> MagicMock:
    phase = MagicMock()
    phase.id = 1
    phase.project_id = project_id
    phase.type = "Design"
    return phase


def _subphase(project_id: int = 1) -> MagicMock:
    sp = MagicMock()
    sp.id = 2
    sp.project_id = project_id
    sp.name = "Sub"
    sp.depth = 1
    return sp


@pytest.mark.parametrize(
    ("method", "path", "body", "lookup"),
    [
        ("post", "/api/projects/1/phases", {"type": "Build", **SPAN}, None),
        ("put", "/api/phases/1", {"type": "Build"}, "phase"),
        ("delete", "/api/phases/1", None, "phase"),
        ("put", "/api/projects/1/phases/reorder", {"phase_order": [1]}, None),
        ("post", "/api/phases/1/subphases", {"name": "S", "project_id": 1, **SPAN}, "phase"),
        ("post", "/api/subphases/2/children", {"name": "S", "project_id": 1, **SPAN}, "subphase"),
        ("put", "/api/subphases/2", {"name": "S"}, "subphase"),
        ("delete", "/api/subphases/2", None, "subphase"),
        ("put", "/api/subphases/2/reorder", {"subphase_order": [2]}, "subphase"),
    ],
)
async def test_phase_and_subphase_writes_outside_are_403(
    authed_client, mock_db_session, at_site_2, method, path, body, lookup
):
    client, set_user = authed_client
    set_user(superuser())
    lookups = {
        "phase": scalar_result(_phase()),
        "subphase": scalar_result(_subphase()),
    }
    if lookup is not None:
        result = lookups[lookup]
        result.first.return_value = (1,)
        mock_db_session.execute.return_value = result

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)(path, **kwargs)

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.commit.assert_not_awaited()


async def test_view_all_edits_phases_anywhere(authed_client, mock_db_session, at_site_2):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.side_effect = [scalar_result(_phase())]

    response = await client.put("/api/phases/1", json={"type": "Build"})

    assert response.status_code == 200


# ---------------------------------------------------------
# Assignments, equipment bookings, Kanban writes and exports on a project
# ---------------------------------------------------------


def _staff_row(project_id: int = 1, staff_id: int = 5) -> MagicMock:
    row = MagicMock()
    row.id = 1
    row.project_id = project_id
    row.staff_id = staff_id
    return row


async def test_assigning_staff_on_a_project_outside_is_403(
    authed_client, mock_db_session, at_site_2
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = first_result((None,))

    response = await client.post(
        "/api/projects/1/staff",
        json={"staff_id": 5, "start_date": "2026-01-05", "end_date": "2026-01-09"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/assignments/1", {"allocation": 50, **SPAN}),
        ("delete", "/api/assignments/1", None),
        ("post", "/api/phases/1/staff", {"staff_id": 5, "project_id": 1}),
        ("put", "/api/phase-staff/1", {"allocation": 50}),
        ("delete", "/api/phase-staff/1", None),
        ("post", "/api/subphases/2/staff", {"staff_id": 5, "project_id": 1}),
        ("put", "/api/subphase-staff/1", {"allocation": 50}),
        ("delete", "/api/subphase-staff/1", None),
    ],
)
async def test_assignment_writes_outside_are_403(
    authed_client, mock_db_session, at_site_2, method, path, body
):
    client, set_user = authed_client
    set_user(superuser())
    result = scalar_result(_staff_row())
    result.first.return_value = (1,)
    mock_db_session.execute.return_value = result

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)(path, **kwargs)

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.commit.assert_not_awaited()


async def test_booking_equipment_on_a_project_outside_is_403(
    authed_client, mock_db_session, at_site_2
):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.post(
        "/api/projects/1/equipment",
        json={"equipment_id": 3, "start_date": "2026-01-05", "end_date": "2026-01-09"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL


@pytest.mark.parametrize(
    ("method", "body"),
    [("put", {"start_date": "2026-01-05", "end_date": "2026-01-09"}), ("delete", None)],
)
async def test_editing_a_booking_outside_is_403(
    authed_client, mock_db_session, at_site_2, method, body
):
    client, set_user = authed_client
    set_user(superuser())
    booking = MagicMock()
    booking.id = 4
    booking.project_id = 1
    mock_db_session.execute.return_value = scalar_result(booking)

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)("/api/equipment-assignments/4", **kwargs)

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


def _card(project_id: int = 1) -> MagicMock:
    card = MagicMock()
    card.id = 1
    card.project_id = project_id
    card.status = "todo"
    return card


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/kanban/cards/phase/1/status", {"status": "done"}),
        ("post", "/api/kanban/cards/phase/1/assignees", {"staff_id": 5}),
        ("delete", "/api/kanban/cards/phase/1/assignees/5", None),
        ("post", "/api/kanban/cards/phase/1/comments", {"body": "Hi"}),
    ],
)
async def test_kanban_card_writes_outside_are_403(
    authed_client, mock_db_session, at_site_2, method, path, body
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = scalar_result(_card())

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)(path, **kwargs)

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.parametrize(("method", "body"), [("put", {"body": "Edited"}), ("delete", None)])
async def test_comment_edits_outside_are_403(
    authed_client, mock_db_session, at_site_2, method, body
):
    client, set_user = authed_client
    set_user(superuser())
    comment = MagicMock()
    comment.id = 3
    comment.project_id = 1
    comment.author_id = 5
    mock_db_session.execute.return_value = scalar_result(comment)

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)("/api/kanban/comments/3", **kwargs)

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/api/export/csv/1"), ("get", "/api/export/csv/1"), ("post", "/api/export/mpp/1")],
)
async def test_exporting_a_project_outside_is_403(
    authed_client, mock_db_session, at_site_2, method, path
):
    client, set_user = authed_client
    set_user(superuser())

    response = await getattr(client, method)(path)

    assert response.status_code == 403
    assert response.json()["detail"] == PROJECT_NOT_VISIBLE_DETAIL
    mock_db_session.execute.assert_not_awaited()


async def test_importing_a_project_to_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.post(
        "/api/import/project",
        data={"site_id": "2"},
        files={"file": ("plan.csv", b"Name\nTask", "text/csv")},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == SITE_NOT_VISIBLE_DETAIL
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------
# Staff
# ---------------------------------------------------------


async def test_staff_list_is_limited_to_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/staff?includeAllSites=true")).status_code == 200
    assert "user_sites.site_id IN (1)" in executed_sql(mock_db_session)


async def test_staff_list_of_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    assert (await client.get("/api/staff?siteId=2")).status_code == 403


async def test_view_all_lists_staff_of_any_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/staff?siteId=2")).status_code == 200
    assert "user_sites.site_id IN" not in executed_sql(mock_db_session)


async def test_a_staff_member_outside_is_404(authed_client, mock_db_session, at_site_2):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get(f"/api/staff/{OTHER}")

    assert response.status_code == 404
    mock_db_session.execute.assert_not_awaited()


def _staff_member(user_id: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=user_id,
        email="a@example.com",
        first_name="A",
        last_name="B",
        job_title=None,
        role="user",
        active=1,
        created_at=STAMP,
        sites=[],
        team_ids=[],
    )


async def test_oneself_and_view_all_read_a_staff_member(authed_client, mock_db_session, at_site_2):
    client, set_user = authed_client
    for caller, target in ((admin(), OTHER), (FakeUser(OTHER, "user", site_ids=[2]), OTHER)):
        set_user(caller)
        mock_db_session.execute.return_value = scalar_result(_staff_member(target))
        assert (await client.get(f"/api/staff/{target}")).status_code == 200


@pytest.mark.parametrize(
    "suffix", ["availability?startDate=2026-01-05&endDate=2026-01-09", "assignments"]
)
async def test_per_person_staff_reads_need_views_staff(authed_client, mock_db_session, suffix):
    client, set_user = authed_client
    set_user(without("user", "views.staff"))

    response = await client.get(f"/api/staff/5/{suffix}")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.staff")


@pytest.mark.parametrize(
    "suffix", ["availability?startDate=2026-01-05&endDate=2026-01-09", "assignments"]
)
async def test_per_person_staff_reads_outside_are_404(
    authed_client, mock_db_session, at_site_2, suffix
):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get(f"/api/staff/{OTHER}/{suffix}")

    assert response.status_code == 404
    mock_db_session.execute.assert_not_awaited()


async def test_staff_assignments_list_only_projects_at_visible_sites(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/staff/5/assignments")).status_code == 200
    assert "projects.site_id IN (1)" in executed_sql(mock_db_session)


# ---------------------------------------------------------
# Equipment and blocks
# ---------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/api/equipment",
        "/api/equipment/7",
        "/api/equipment/7/assignments",
        "/api/equipment/7/availability?startDate=2026-01-05&endDate=2026-01-09",
        "/api/equipment-blocks",
        "/api/equipment/7/blocks",
    ],
)
async def test_equipment_reads_need_views_equipment(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(without("user", "views.equipment"))

    response = await client.get(path)

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.equipment")


async def test_equipment_list_is_limited_to_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/equipment?includeAllSites=true")).status_code == 200
    assert "equipment_sites.site_id IN (1)" in executed_sql(mock_db_session)


async def test_equipment_of_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    assert (await client.get("/api/equipment?siteId=2")).status_code == 403
    assert (await client.get("/api/equipment-blocks?siteId=2")).status_code == 403


async def test_view_all_lists_equipment_and_blocks_anywhere(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/equipment")).status_code == 200
    assert (await client.get("/api/equipment-blocks")).status_code == 200
    assert (await client.get("/api/equipment/all")).status_code == 200
    assert "site_id IN" not in executed_sql(mock_db_session)


async def test_all_equipment_and_blocks_are_limited_to_visible_sites(
    authed_client, mock_db_session
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/equipment/all")).status_code == 200
    assert (await client.get("/api/equipment-blocks")).status_code == 200
    assert executed_sql(mock_db_session).count("equipment_sites.site_id IN (1)") == 2


@pytest.mark.parametrize(
    "path",
    [
        "/api/equipment/7",
        "/api/equipment/7/assignments",
        "/api/equipment/7/availability?startDate=2026-01-05&endDate=2026-01-09",
        "/api/equipment/7/blocks",
    ],
)
async def test_equipment_outside_the_visible_sites_is_404(
    authed_client, mock_db_session, site_links, path
):
    client, set_user = authed_client
    set_user(superuser())
    site_links.equipment[7] = [2]

    response = await client.get(path)

    assert response.status_code == 404
    assert response.json()["detail"] == "Equipment not found"
    mock_db_session.execute.assert_not_awaited()


async def test_equipment_shared_with_a_visible_site_is_readable(
    authed_client, mock_db_session, site_links
):
    client, set_user = authed_client
    set_user(superuser())
    site_links.equipment[7] = [1, 2]
    equipment = Equipment(
        id=7, name="HPLC", type="A", site_id=1, active=1, sites=[Site(id=1, name="Zurich")]
    )
    equipment.created_at = STAMP
    mock_db_session.execute.return_value = scalar_result(equipment)

    response = await client.get("/api/equipment/7")

    assert response.status_code == 200


# ---------------------------------------------------------
# Holidays and events
# ---------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/api/holidays?siteId=2",
        "/api/sites/2/holidays",
        "/api/events?siteId=2",
        "/api/sites/2/events",
    ],
)
async def test_calendar_reads_of_a_site_outside_are_403(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get(path)

    assert response.status_code == 403
    assert response.json()["detail"] == SITE_NOT_VISIBLE_DETAIL
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize(
    "path",
    [
        "/api/holidays?siteId=2",
        "/api/sites/2/holidays",
        "/api/events?siteId=2",
        "/api/sites/2/events",
    ],
)
async def test_view_all_reads_any_calendar(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get(path)).status_code == 200


# ---------------------------------------------------------
# Absences
# ---------------------------------------------------------


async def test_absences_of_a_site_need_absences_view_others(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without("user", "absences.view_others"))

    response = await client.get("/api/vacations?siteId=1")

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("absences.view_others")


async def test_absences_of_a_site_outside_are_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    response = await client.get("/api/vacations?siteId=2")

    assert response.status_code == 403
    assert response.json()["detail"] == SITE_NOT_VISIBLE_DETAIL


async def test_view_all_reads_absences_of_any_site(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/vacations?siteId=2")).status_code == 200


async def test_absence_list_is_own_and_visible_colleagues(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/vacations")).status_code == 200
    sql = executed_sql(mock_db_session)
    assert "vacations.staff_id = 5" in sql
    assert "user_sites.site_id IN (1)" in sql


async def test_absence_list_without_view_others_is_own_only(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(without("superuser", "absences.view_others"))
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/vacations")).status_code == 200
    sql = executed_sql(mock_db_session)
    assert "vacations.staff_id = 5" in sql
    assert "user_sites" not in sql


async def test_view_all_lists_every_absence(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/vacations")).status_code == 200
    sql = executed_sql(mock_db_session)
    assert "vacations.staff_id =" not in sql and "user_sites" not in sql


@pytest.mark.parametrize(
    ("user_factory", "expected"),
    [
        (superuser, ("vacations.staff_id = 5", "user_sites.site_id IN (1)")),
        (lambda: without("user", "absences.view_others"), ("vacations.staff_id = 5",)),
    ],
)
async def test_absence_detail_uses_the_same_scope(
    authed_client, mock_db_session, user_factory, expected
):
    client, set_user = authed_client
    set_user(user_factory())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/vacations/4")).status_code == 404
    sql = executed_sql(mock_db_session)
    assert all(fragment in sql for fragment in expected)


def _vacation(staff_id: int) -> MagicMock:
    vacation = MagicMock()
    vacation.id = 4
    vacation.staff_id = staff_id
    return vacation


async def test_absences_of_someone_outside_cannot_be_written(
    authed_client, mock_db_session, at_site_2
):
    client, set_user = authed_client
    set_user(superuser())
    span = {"start_date": "2026-01-05", "end_date": "2026-01-09"}

    mock_db_session.execute.return_value = scalar_result(SimpleNamespace(id=OTHER))
    created = await client.post("/api/vacations", json={"staff_id": OTHER, **span})
    imported = await client.post("/api/vacations/import", json={"staff_id": OTHER, "items": [span]})
    mock_db_session.execute.return_value = scalar_result(_vacation(OTHER))
    updated = await client.put("/api/vacations/4", json={"description": "x"})
    deleted = await client.delete("/api/vacations/4")

    for response in (created, imported, updated, deleted):
        assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


async def test_absences_of_a_visible_colleague_can_be_written(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = scalar_result(_vacation(OTHER))

    assert (await client.delete("/api/vacations/4")).status_code == 200


# ---------------------------------------------------------
# Teams
# ---------------------------------------------------------


async def test_team_list_is_limited_to_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/teams")).status_code == 200
    assert "teams.site_id IN (1)" in executed_sql(mock_db_session)
    assert (await client.get("/api/teams?siteId=2")).status_code == 403


async def test_view_all_lists_teams_anywhere(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/teams?siteId=2")).status_code == 200
    assert "teams.site_id IN" not in executed_sql(mock_db_session)


async def test_a_team_outside_is_404(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    team = Team(id=3, site_id=2, name="Lab", active=True, created_at=STAMP, updated_at=STAMP)
    team.members = []
    mock_db_session.execute.return_value = scalar_result(team)

    assert (await client.get("/api/teams/3")).status_code == 404
    set_user(admin())
    assert (await client.get("/api/teams/3")).status_code == 200


# ---------------------------------------------------------
# Users and skills on users
# ---------------------------------------------------------


async def test_user_list_is_limited_to_members_of_visible_sites(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/users")).status_code == 200
    sql = executed_sql(mock_db_session)
    assert sql.count("user_sites.site_id IN (1)") == 2  # the count and the page
    assert "users.id = 5" in sql  # oneself always


async def test_view_all_lists_every_user(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get("/api/users")).status_code == 200
    assert "user_sites" not in executed_sql(mock_db_session)


async def test_a_user_outside_is_404_to_read(authed_client, mock_db_session, at_site_2):
    client, set_user = authed_client
    set_user(superuser())

    assert (await client.get(f"/api/users/{OTHER}")).status_code == 404
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", f"/api/users/{OTHER}", {"first_name": "X"}),
        ("delete", f"/api/users/{OTHER}", None),
        ("put", f"/api/users/{OTHER}/toggle-active", None),
        ("put", f"/api/skills/user/{OTHER}", {"skill_ids": []}),
        ("post", f"/api/skills/user/{OTHER}/1", None),
        ("delete", f"/api/skills/user/{OTHER}/1", None),
    ],
)
async def test_users_outside_cannot_be_changed(
    authed_client, mock_db_session, at_site_2, method, path, body
):
    client, set_user = authed_client
    set_user(FakeUser(5, "hr", HR, site_ids=[1]))
    target = SimpleNamespace(
        id=OTHER, role="user", active=1, is_system_user=False, email="o@example.com"
    )
    result = scalar_result(target)
    result.unique.return_value.scalar_one_or_none.return_value = target
    mock_db_session.execute.return_value = result

    kwargs = {"json": body} if body is not None else {}
    response = await getattr(client, method)(path, **kwargs)

    assert response.status_code == 403
    mock_db_session.commit.assert_not_awaited()


async def test_creating_a_user_at_a_site_outside_is_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "hr", HR, site_ids=[1]))
    # No account with that e-mail; the default role exists.
    mock_db_session.execute.side_effect = [scalar_result(None), scalar_result(1)]

    response = await client.post(
        "/api/users",
        json={
            "email": "n@example.com",
            "password": "longenough",
            "first_name": "N",
            "last_name": "U",
            "site_ids": [2],
        },
    )

    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


# ---------------------------------------------------------
# Staff notes
# ---------------------------------------------------------


async def test_notes_of_a_site_outside_are_403(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())

    assert (await client.get("/api/notes?siteId=2")).status_code == 403
    response = await client.post(
        "/api/notes", json={"site_id": 2, "date": "2026-01-05", "text": "Note"}
    )
    assert response.status_code == 403
    mock_db_session.add.assert_not_called()


async def test_a_note_outside_cannot_be_deleted(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = scalar_result(SimpleNamespace(id=1, site_id=2))

    assert (await client.delete("/api/notes/1")).status_code == 403
    mock_db_session.commit.assert_not_awaited()

    set_user(admin())
    assert (await client.delete("/api/notes/1")).status_code == 200


# ---------------------------------------------------------
# Kanban reads
# ---------------------------------------------------------


KANBAN_READS = [
    "/api/kanban/projects/1/comment-counts",
    "/api/kanban/sites/1/comment-counts",
    "/api/kanban/sites/1/mentionable-users",
    "/api/kanban/cards/phase/1/comments",
]


@pytest.mark.parametrize("path", KANBAN_READS)
async def test_kanban_reads_need_views_kanban(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(without("user", "views.kanban"))

    response = await client.get(path)

    assert response.status_code == 403
    assert response.json()["detail"] == permission_required_detail("views.kanban")


@pytest.mark.parametrize(
    ("path", "detail"),
    [
        ("/api/kanban/projects/1/comment-counts", PROJECT_NOT_VISIBLE_DETAIL),
        ("/api/kanban/sites/2/comment-counts", SITE_NOT_VISIBLE_DETAIL),
        ("/api/kanban/sites/2/mentionable-users", SITE_NOT_VISIBLE_DETAIL),
        ("/api/kanban/cards/phase/1/comments", PROJECT_NOT_VISIBLE_DETAIL),
    ],
)
async def test_kanban_reads_outside_are_403(
    authed_client, mock_db_session, at_site_2, path, detail
):
    client, set_user = authed_client
    set_user(superuser())
    mock_db_session.execute.return_value = scalar_result(_card())

    response = await client.get(path)

    assert response.status_code == 403
    assert response.json()["detail"] == detail


@pytest.mark.parametrize(
    "path",
    [
        "/api/kanban/projects/1/comment-counts",
        "/api/kanban/sites/2/comment-counts",
        "/api/kanban/sites/2/mentionable-users",
    ],
)
async def test_view_all_reads_kanban_anywhere(authed_client, mock_db_session, at_site_2, path):
    client, set_user = authed_client
    set_user(admin())
    mock_db_session.execute.return_value = empty_result()

    assert (await client.get(path)).status_code == 200
