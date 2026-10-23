"""
Export router: project MS Project XML / CSV downloads, the site Excel export,
and the pure task-list / XML helpers behind them.

HTTP tests go through authed_client (house style, tests/conftest.py); the
project loader is patched where the test is about the response, and the site
workbook is built for real with openpyxl from a fake session answering each
SELECT by its entity.
"""

import io
import json
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.absence_type import AbsenceType
from app.models.card_comment import CardComment
from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.equipment import Equipment, EquipmentBlock
from app.models.note import Note
from app.models.project import Project
from app.models.rbac import ApprovalRequest
from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite, Site
from app.models.skill import Skill, UserSkill
from app.models.tag import Tag
from app.models.team import Team
from app.models.user import User
from app.models.vacation import Vacation
from app.routers.export import (
    _iso,
    _safe_filename,
    _yes_no,
    add_subphases_to_list,
    build_site_export_workbook,
    build_task_list,
    calculate_duration_days,
    escape_xml,
    format_date_for_export,
    format_xml_date,
    generate_xml,
)
from tests.conftest import FakeUser

STAMP = datetime(2026, 1, 1, 12, 0, 0)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def ns(**kwargs) -> SimpleNamespace:
    return SimpleNamespace(**kwargs)


def subphase(sp_id, name, *, sort_order=0, children=None, deps=None, completion=None, ms=0):
    return ns(
        id=sp_id,
        name=name,
        sort_order=sort_order,
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 6),
        completion=completion,
        dependencies=deps,
        is_milestone=ms,
        children=children or [],
    )


def phase(ph_id, name, *, sort_order=0, subphases=None, deps=None, completion=None, ms=0):
    return ns(
        id=ph_id,
        type=name,
        sort_order=sort_order,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 5) if ms else date(2026, 1, 30),
        completion=completion,
        dependencies=deps,
        is_milestone=ms,
        subphases=subphases or [],
    )


def project(name="Scale & <Up>", *, phases=None, customer="ACME", pm="Alice Martin"):
    return ns(
        id=5,
        name=name,
        customer=customer,
        project_manager=ns(full_name=pm) if pm else None,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 3, 31),
        phases=phases or [],
    )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_build_task_list_flattens_tree_in_sort_order():
    tree = project(
        phases=[
            phase(
                2,
                "Build",
                sort_order=2,
                deps=json.dumps([{"id": 1, "type": "SS"}, {"id": 7}]),
                completion=40,
                subphases=[
                    subphase(
                        21,
                        "B-late",
                        sort_order=5,
                        deps=[{"id": 3, "type": "FF"}],
                        children=[subphase(211, "B-late-child", completion=100, ms=1)],
                    ),
                    subphase(20, "B-early", sort_order=1, deps="not json"),
                ],
            ),
            phase(1, "Design", sort_order=1, ms=1, deps="[]"),
        ]
    )

    tasks = build_task_list(tree)

    assert [(t["id"], t["name"], t["outline_level"]) for t in tasks] == [
        (1, "Scale & <Up>", 1),
        (2, "Design", 2),
        (3, "Build", 2),
        (4, "B-early", 3),
        (5, "B-late", 3),
        (6, "B-late-child", 4),
    ]
    by_name = {t["name"]: t for t in tasks}
    assert by_name["Scale & <Up>"]["notes"] == "Customer: ACME; PM: Alice Martin"
    assert by_name["Scale & <Up>"]["duration"] == 85
    assert by_name["Design"]["milestone"] is True
    assert by_name["Design"]["duration"] == 1  # zero-length milestone floors at 1
    assert by_name["Design"]["predecessors"] == ""  # empty list
    assert by_name["Build"]["predecessors"] == "1SS,7FS"  # type defaults to FS
    assert by_name["Build"]["percent_complete"] == 40
    assert by_name["B-early"]["predecessors"] == ""  # unparsable JSON ignored
    assert by_name["B-late"]["predecessors"] == "3FF"  # already-decoded list
    assert by_name["B-late-child"]["percent_complete"] == 100
    assert by_name["B-late-child"]["milestone"] is True


def test_build_task_list_without_customer_or_pm_has_empty_notes():
    tasks = build_task_list(project(customer=None, pm=None))

    assert len(tasks) == 1
    assert tasks[0]["notes"] == ""
    assert tasks[0]["percent_complete"] == 0


def test_add_subphases_to_list_returns_next_id():
    tasks: list[dict] = []

    next_id = add_subphases_to_list(
        tasks,
        [subphase(1, "A", children=[subphase(2, "A1")]), subphase(3, "B", sort_order=1)],
        5,
        10,
    )

    assert next_id == 13
    assert [(t["id"], t["name"], t["outline_level"]) for t in tasks] == [
        (10, "A", 5),
        (11, "A1", 6),
        (12, "B", 5),
    ]


def test_generate_xml_escapes_names_and_formats_dates():
    tree = project(phases=[phase(1, "Say \"hi\" & 'bye'", completion=50)])
    tasks = build_task_list(tree)

    xml = generate_xml(tasks, tree.name, tree)

    assert xml.startswith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    assert "<Name>Scale &amp; &lt;Up&gt;</Name>" in xml
    assert "<StartDate>2026-01-05T08:00:00</StartDate>" in xml
    assert "<FinishDate>2026-03-31T08:00:00</FinishDate>" in xml
    assert "<Name>Say &quot;hi&quot; &amp; &apos;bye&apos;</Name>" in xml
    assert "<Duration>PT200H0M0S</Duration>" in xml  # 25 days x 8h
    assert "<PercentComplete>50</PercentComplete>" in xml
    assert xml.count("<Task>") == 2
    assert xml.rstrip().endswith("</Project>")


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, ""), ("", ""), ("a<b>", "a&lt;b&gt;"), (42, "42")],
)
def test_escape_xml(value, expected):
    assert escape_xml(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, ""), (date(2026, 4, 1), "2026-04-01T08:00:00"), ("2026-04-02", "2026-04-02T08:00:00")],
)
def test_format_xml_date(value, expected):
    assert format_xml_date(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, ""), (date(2026, 4, 1), "04/01/2026"), ("2026-12-24", "12/24/2026")],
)
def test_format_date_for_export(value, expected):
    assert format_date_for_export(value) == expected


def test_calculate_duration_days_handles_missing_dates():
    assert calculate_duration_days(None, date(2026, 1, 2)) == 1
    assert calculate_duration_days(date(2026, 1, 1), date(2026, 1, 11)) == 10


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Winterthur Lab", "Winterthur_Lab"),
        ("Zürich / R&D", "Z_rich_R_D"),
        ("__a.b-c__", "a.b-c"),
        ("///", "site"),
    ],
)
def test_safe_filename(name, expected):
    assert _safe_filename(name) == expected


def test_iso_and_yes_no():
    assert _iso(None) == ""
    assert _iso(date(2026, 1, 2)) == "2026-01-02"
    assert _iso(datetime(2026, 1, 2, 3, 4, 5, 999)) == "2026-01-02 03:04:05"
    assert (_yes_no(1), _yes_no(0), _yes_no(None), _yes_no(True)) == ("Yes", "No", "No", "Yes")


# ---------------------------------------------------------------------------
# Project export endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def loader():
    with patch("app.routers.export.get_project_with_hierarchy", new_callable=AsyncMock) as mock:
        yield mock


@pytest.mark.asyncio
async def test_mpp_export_returns_xml_attachment(authed_client, mock_db_session, loader):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))
    loader.return_value = project("My Project", phases=[phase(1, "Design")])

    response = await client.post("/api/export/mpp/5")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert response.headers["content-disposition"] == 'attachment; filename="My_Project.xml"'
    assert "<Name>Design</Name>" in response.text
    loader.assert_awaited_once_with(mock_db_session, 5)


@pytest.mark.asyncio
async def test_mpp_export_404(authed_client, loader):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    loader.return_value = None

    response = await client.post("/api/export/mpp/5")

    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["get", "post"])
async def test_csv_export_returns_rows(authed_client, loader, method):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    loader.return_value = project("My Project", phases=[phase(1, "Design", ms=1)])

    response = await getattr(client, method)("/api/export/csv/5")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="My_Project.csv"'
    lines = response.text.splitlines()
    assert lines[0].startswith("ID,Name,Outline Level,Start,Finish")
    assert lines[1].startswith("1,My Project,1,01/05/2026,03/31/2026,85d")
    assert lines[2].startswith("2,Design,2,01/05/2026,01/05/2026,1d,,0,Yes")


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["get", "post"])
async def test_csv_export_404(authed_client, loader, method):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    loader.return_value = None

    response = await getattr(client, method)("/api/export/csv/5")

    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("post", "/api/export/mpp/5"),
        ("post", "/api/export/csv/5"),
        ("get", "/api/export/csv/5"),
        ("get", "/api/export/site/1/excel"),
    ],
)
async def test_exports_forbidden_for_plain_user(authed_client, loader, method, url):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))

    response = await getattr(client, method)(url)

    assert response.status_code == 403
    loader.assert_not_awaited()


# ---------------------------------------------------------------------------
# Site Excel export endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def workbook_builder():
    with patch("app.routers.export.build_site_export_workbook", new_callable=AsyncMock) as mock:
        mock.return_value = (b"PK-xlsx-bytes", "site_Winterthur_2026-01-01.xlsx")
        yield mock


@pytest.mark.asyncio
async def test_site_export_superuser_off_site_is_forbidden(authed_client, workbook_builder):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))  # member of site 1 only

    response = await client.get("/api/export/site/2/excel")

    assert response.status_code == 403
    assert response.json()["detail"] == "Access denied to this site"
    workbook_builder.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("role", "site_id"), [("superuser", 1), ("admin", 2)])
async def test_site_export_streams_the_workbook(
    authed_client, mock_db_session, workbook_builder, role, site_id
):
    client, set_user = authed_client
    set_user(FakeUser(1, role))

    response = await client.get(f"/api/export/site/{site_id}/excel")

    assert response.status_code == 200
    assert response.headers["content-type"] == XLSX
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="site_Winterthur_2026-01-01.xlsx"'
    )
    assert response.content == b"PK-xlsx-bytes"
    workbook_builder.assert_awaited_once_with(mock_db_session, site_id)


# ---------------------------------------------------------------------------
# Site workbook content
# ---------------------------------------------------------------------------


def _site_rows() -> dict:
    site = Site(
        id=1,
        name="Winterthur Lab",
        location="Building 4",
        city="Winterthur",
        country_code="CH",
        region_code="ZH",
        timezone="Europe/Zurich",
        active=1,
        created_at=STAMP,
    )
    alice = ns(
        id=7,
        email="alice@example.com",
        first_name="Alice",
        last_name="Martin",
        full_name="Alice Martin",
        job_title="Chemist",
        role="user",
        max_capacity=80,
        active=1,
        is_resource=False,
        sso_provider=None,
        created_at=STAMP,
    )
    sp_child = ns(
        id=21,
        name="Child",
        parent_type="subphase",
        parent_id=20,
        sort_order=0,
        start_date=date(2026, 2, 3),
        end_date=date(2026, 2, 4),
        completion=10,
        is_milestone=0,
        dependencies=None,
        created_at=STAMP,
        status="todo",
        # A pending self-booking (awaiting approval, request 61).
        staff_assignments=[
            ns(
                id=303,
                staff_id=7,
                allocation=25,
                start_date=None,  # linked: follows the subphase
                end_date=None,
                approval_status="pending",
                approval_request_id=61,
            )
        ],
    )
    sp_parent = ns(
        id=20,
        name="Parent",
        parent_type="phase",
        parent_id=10,
        sort_order=0,
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 6),
        completion=50,
        is_milestone=0,
        dependencies='[{"id": 11}]',
        created_at=STAMP,
        status="in_progress",
        staff_assignments=[],
    )
    ph_late = ns(
        id=10,
        type="Execution",
        sort_order=2,
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 28),
        completion=30,
        is_milestone=0,
        dependencies=None,
        created_at=STAMP,
        status="in_progress",
        # An approved booking with a pending change (request 62).
        staff_assignments=[
            ns(
                id=202,
                staff_id=99,
                allocation=50,
                # An unlinked segment inside the phase.
                start_date=date(2026, 2, 10),
                end_date=date(2026, 2, 12),
                approval_status="approved",
                approval_request_id=62,
            )
        ],
    )
    ph_early = ns(
        id=11,
        type="Kickoff",
        sort_order=1,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 1, 5),
        completion=100,
        is_milestone=1,
        dependencies=None,
        created_at=STAMP,
        status="done",
        staff_assignments=[],
    )
    lab = ns(
        id=5,
        site_id=1,
        name="Analytical Lab",
        description="Method development",
        color="#0ea5e9",
        active=True,
        members=[ns(id=7, full_name="Alice Martin"), ns(id=8, full_name="Bob Brown")],
        created_at=STAMP,
    )
    pilot = ns(
        id=6,
        site_id=1,
        name="Pilot Plant",
        description=None,
        color=None,
        active=False,
        members=[],
        created_at=STAMP,
    )
    basel_qc = ns(id=9, site_id=2, name="Basel QC")  # a team at another site
    tag = ns(
        id=3,
        name="Priority",
        color="#ff0000",
        all_sites=False,
        sites=[ns(name="Winterthur Lab"), ns(name="Basel")],
        teams=[basel_qc, lab],
        sort_order=0,
        created_at=STAMP,
    )
    proj = ns(
        id=1,
        name="Alpha",
        customer="ACME",
        pm_id=7,
        sales_pm="Bob",
        confirmed=1,
        volume=1000,
        start_date=date(2026, 1, 5),
        end_date=date(2026, 3, 1),
        archived=0,
        notes="Note",
        created_at=STAMP,
        phases=[ph_late, ph_early],
        subphases=[sp_child, sp_parent],
        staff_assignments=[
            ns(
                id=101,
                staff_id=7,
                allocation=60,
                start_date=date(2026, 1, 5),
                end_date=date(2026, 1, 30),
                created_at=STAMP,
                approval_status="approved",
                approval_request_id=None,
            )
        ],
        equipment_assignments=[
            ns(
                id=401,
                equipment_id=30,
                start_date=date(2026, 1, 6),
                end_date=date(2026, 1, 7),
                created_at=STAMP,
            ),
            ns(
                id=402,
                equipment_id=88,  # not linked to this site
                start_date=date(2026, 1, 6),
                end_date=date(2026, 1, 7),
                created_at=STAMP,
            ),
        ],
        tags=[tag],
        teams=[lab, pilot],
    )
    equipment = ns(
        id=30,
        name="HPLC",
        type="Analytical",
        description="Agilent",
        active=1,
        sites=[ns(name="Winterthur Lab"), ns(name="Basel")],
        teams=[lab, pilot],
        created_at=STAMP,
    )
    column = ns(
        id=40,
        name="Risk",
        column_type="list",
        list_options='["Low", "High"]',
        site_id=None,
        display_order=1,
        width=120,
        created_at=STAMP,
    )

    def value(vid, etype, eid, val):
        return ns(
            id=vid,
            custom_column_id=40,
            entity_type=etype,
            entity_id=eid,
            value=val,
            created_at=STAMP,
        )

    return {
        Site: [site],
        User: [alice],
        Team: [lab, pilot],
        Project: [proj],
        Equipment: [equipment],
        EquipmentBlock: [
            ns(
                id=50,
                equipment_id=30,
                start_date=date(2026, 3, 1),
                end_date=date(2026, 3, 2),
                reason="maintenance",
                description="Annual",
                created_at=STAMP,
            )
        ],
        Skill: [ns(id=8, name="HPLC", description=None, color="#000000", created_at=STAMP)],
        UserSkill: [ns(user_id=7, skill_id=8, proficiency=4, assigned_at=STAMP)],
        Tag: [tag],
        AbsenceType: [
            ns(
                id=2,
                name="Vacation",
                color="#00ff00",
                counts_as_unavailable=1,
                sort_order=0,
                is_active=1,
            )
        ],
        Vacation: [
            ns(
                id=60,
                staff_id=7,
                start_date=date(2026, 7, 1),
                end_date=date(2026, 7, 14),
                description="Summer",
                absence_type_id=2,
                created_at=STAMP,
            )
        ],
        CustomColumn: [column],
        CustomColumnValue: [
            value(70, "project", 1, "High"),
            value(71, "phase", 10, "Low"),
            value(72, "subphase", 21, None),
            value(73, "project", 999, "Other site"),  # filtered out
        ],
        BankHoliday: [
            ns(
                id=80,
                date=date(2026, 8, 1),
                end_date=None,
                name="National Day",
                year=2026,
                is_custom=0,
                created_at=STAMP,
            )
        ],
        CompanyEvent: [
            ns(
                id=90,
                date=date(2026, 5, 5),
                end_date=date(2026, 5, 6),
                name="Audit",
                color=None,
                counts_as_unavailable=1,
                teams=[basel_qc],  # restricted at Basel only: the whole site here
                created_at=STAMP,
            )
        ],
        CompanyEventSite: [ns(event_id=90, name="Basel"), ns(event_id=90, name="Winterthur Lab")],
        Note: [
            ns(
                id=91,
                date=date(2026, 1, 9),
                text="Remember",
                type="general",
                staff_id=7,
                created_at=STAMP,
            )
        ],
        ApprovalRequest: [
            ns(
                id=60,
                action="assignments.self_create",
                status="approved",
                close_reason=None,
                requester_id=7,
                project_id=1,
                level="project",
                target_id=1,
                assignment_id=101,
                requested='{"allocation": 60}',
                previous=None,
                note=None,
                decided_by=7,
                decided_at=STAMP,
                decision_note="ok",
                superseded_by_id=None,
                created_at=STAMP,
            ),
            ns(
                id=61,
                action="assignments.self_create",
                status="pending",
                close_reason=None,
                requester_id=7,
                project_id=1,
                level="subphase",
                target_id=21,
                assignment_id=303,
                requested='{"allocation": 25}',
                previous=None,
                note=None,
                decided_by=None,
                decided_at=None,
                decision_note=None,
                superseded_by_id=None,
                created_at=STAMP,
            ),
            ns(
                id=62,
                action="assignments.self_update",
                status="pending",
                close_reason=None,
                requester_id=99,
                project_id=1,
                level="phase",
                target_id=10,
                assignment_id=202,
                requested='{"allocation": 70}',
                previous='{"allocation": 50}',
                note=None,
                decided_by=None,
                decided_at=None,
                decision_note=None,
                superseded_by_id=None,
                created_at=STAMP,
            ),
        ],
        CardComment: [
            ns(
                id=95,
                project_id=1,
                entity_type="phase",
                entity_id=10,
                author_id=7,
                body="Looks good @Bob",
                parsed_mentions=[12, 13],
                created_at=STAMP,
                updated_at=STAMP,
            )
        ],
    }


def _fake_site_db(rows: dict):
    statements: list = []

    async def execute(stmt, *args, **kwargs):
        statements.append(stmt)
        entity = stmt.column_descriptions[0].get("entity")
        found = rows.get(entity, [])
        result = MagicMock()
        result.scalar_one_or_none.return_value = found[0] if found else None
        result.scalars.return_value.all.return_value = list(found)
        result.__iter__.return_value = iter(found)
        return result

    db = MagicMock()
    db.execute = execute
    db.statements = statements
    return db


def _sheet(wb, title):
    return [list(row) for row in wb[title].iter_rows(min_row=2, values_only=True)]


@pytest.mark.asyncio
async def test_site_workbook_contains_every_site_scoped_sheet():
    openpyxl = pytest.importorskip("openpyxl")

    content, filename = await build_site_export_workbook(_fake_site_db(_site_rows()), 1)

    assert filename.startswith("site_Winterthur_Lab_") and filename.endswith(".xlsx")
    wb = openpyxl.load_workbook(io.BytesIO(content))
    assert wb.sheetnames == [
        "Site",
        "Projects",
        "Users",
        "Teams",
        "Team members",
        "Equipment",
        "Skills",
        "User skills",
        "Tags",
        "Project tags",
        "Project teams",
        "Absence types",
        "Vacations",
        "Project assignments",
        "Phase assignments",
        "Subphase assignments",
        "Approval requests",
        "Equipment assignments",
        "Custom columns",
        "Custom column values",
        "Bank holidays",
        "Company events",
        "Equipment blocks",
        "Staff notes",
        "Card comments",
    ]

    # Projects: tree order, phases by sort_order, subphases nested by depth.
    projects = _sheet(wb, "Projects")
    assert [(r[0], r[1], r[2], r[7]) for r in projects] == [
        ("Project", 1, 1, "Alpha"),
        ("Phase", 2, 11, "Kickoff"),
        ("Phase", 2, 10, "Execution"),
        ("Subphase", 3, 20, "Parent"),
        ("Subphase", 4, 21, "Child"),
    ]
    assert projects[0][9] == "Alice Martin"  # PM resolved from the site's users
    assert projects[0][11] == "Yes"  # confirmed
    assert projects[1][16] == "Yes"  # Kickoff is a milestone
    assert projects[3][18] == '[{"id": 11}]'
    assert [r[22] for r in projects] == [None, "done", "in_progress", "in_progress", "todo"]

    # Users: "Bookable" (users.is_resource) right after "Active".
    users_header = [c.value for c in wb["Users"][1]]
    assert users_header[7:9] == ["Active", "Bookable"]
    assert [r[7:9] for r in _sheet(wb, "Users")] == [["Yes", "No"]]

    assert [c.value for c in wb["Teams"][1]] == [
        "ID",
        "Name",
        "Description",
        "Color",
        "Active",
        "Members",
        "Created at",
    ]
    assert _sheet(wb, "Teams") == [
        [5, "Analytical Lab", "Method development", "#0ea5e9", "Yes", 2, "2026-01-01 12:00:00"],
        [6, "Pilot Plant", None, None, "No", 0, "2026-01-01 12:00:00"],
    ]
    assert [c.value for c in wb["Team members"][1]] == [
        "Team ID",
        "Team name",
        "User ID",
        "User name",
    ]
    assert _sheet(wb, "Team members") == [
        [5, "Analytical Lab", 7, "Alice Martin"],
        [5, "Analytical Lab", 8, "Bob Brown"],
    ]

    equipment = wb["Equipment"]
    assert [c.value for c in equipment[1]][-2:] == ["Teams", "Created at"]
    assert _sheet(wb, "Equipment")[0][5:7] == [
        "Winterthur Lab, Basel",
        "Analytical Lab, Pilot Plant",
    ]
    assert _sheet(wb, "User skills") == [[7, "Alice Martin", 8, "HPLC", 4, "2026-01-01 12:00:00"]]
    assert [c.value for c in wb["Tags"][1]][-2:] == ["Teams", "Created at"]
    tags = _sheet(wb, "Tags")
    assert tags[0][3:5] == [False, "Winterthur Lab, Basel"]
    assert tags[0][6] == "Analytical Lab"  # only the teams at this site
    assert _sheet(wb, "Project tags") == [[1, "Alpha", 3, "Priority", "#ff0000"]]
    assert [c.value for c in wb["Project teams"][1]] == [
        "Project ID",
        "Project name",
        "Team ID",
        "Team name",
        "Team color",
    ]
    assert _sheet(wb, "Project teams") == [
        [1, "Alpha", 5, "Analytical Lab", "#0ea5e9"],
        [1, "Alpha", 6, "Pilot Plant", None],
    ]
    assert _sheet(wb, "Absence types")[0][3] == "Yes"
    assert _sheet(wb, "Vacations")[0][2] == "Alice Martin"
    assert _sheet(wb, "Vacations")[0][7] == "Vacation"

    assert _sheet(wb, "Project assignments")[0][:6] == [101, 1, "Alpha", 7, "Alice Martin", 60]
    assert [c.value for c in wb["Project assignments"][1]][-2:] == [
        "Approval status",
        "Pending change",
    ]
    assert _sheet(wb, "Project assignments")[0][-2:] == ["approved", None]
    # Staff outside the site's user list exports with an empty name.
    # Card bookings: effective Start / End and Linked after the allocation.
    for title, kind in (
        ("Phase assignments", "Phase type"),
        ("Subphase assignments", "Subphase name"),
    ):
        assert [c.value for c in wb[title][1]][4:] == [
            kind,
            "Staff ID",
            "Staff name",
            "Allocation %",
            "Start",
            "End",
            "Linked",
            "Approval status",
            "Pending change",
        ]
    assert _sheet(wb, "Phase assignments") == [
        [
            202,
            1,
            "Alpha",
            10,
            "Execution",
            99,
            None,
            50,
            "2026-02-10",
            "2026-02-12",
            "No",
            "approved",
            "allocation 50% → 70%",
        ]
    ]
    # A linked booking exports its card's dates.
    assert _sheet(wb, "Subphase assignments")[0][3:] == [
        21,
        "Child",
        7,
        "Alice Martin",
        25,
        "2026-02-03",
        "2026-02-04",
        "Yes",
        "pending",
        "awaiting approval",
    ]
    assert [c.value for c in wb["Approval requests"][1]] == [
        "ID",
        "Action",
        "Status",
        "Close reason",
        "Requester ID",
        "Requester name",
        "Project ID",
        "Project name",
        "Level",
        "Target ID",
        "Target name",
        "Assignment ID",
        "Requested",
        "Previous",
        "Note",
        "Decided by ID",
        "Decided by",
        "Decided at",
        "Decision note",
        "Superseded by",
        "Created at",
    ]
    requests = _sheet(wb, "Approval requests")
    assert [(r[0], r[2], r[8], r[10]) for r in requests] == [
        (60, "approved", "project", "Alpha"),
        (61, "pending", "subphase", "Child"),
        (62, "pending", "phase", "Execution"),
    ]
    assert requests[0][15:19] == [7, "Alice Martin", "2026-01-01 12:00:00", "ok"]
    assert requests[2][5] is None  # requester outside the site's users
    assert requests[2][12:14] == ['{"allocation": 70}', '{"allocation": 50}']
    equipment_bookings = _sheet(wb, "Equipment assignments")
    assert [(r[0], r[4]) for r in equipment_bookings] == [(401, "HPLC"), (402, None)]

    assert _sheet(wb, "Custom columns")[0][3:5] == ['["Low", "High"]', "global"]
    values = _sheet(wb, "Custom column values")
    assert [(r[0], r[3], r[5], r[6]) for r in values] == [
        (70, "project", "Alpha", "High"),
        (71, "phase", "Execution", "Low"),
        (72, "subphase", "Child", None),
    ]

    assert _sheet(wb, "Bank holidays")[0][1:5] == ["2026-08-01", None, "National Day", 2026]
    assert [c.value for c in wb["Company events"][1]][-2:] == ["Teams", "Created at"]
    # Restricted to a team at another site only: the whole site here.
    assert _sheet(wb, "Company events")[0][5:8] == ["Basel, Winterthur Lab", "Yes", None]
    assert _sheet(wb, "Equipment blocks")[0][2] == "HPLC"
    assert _sheet(wb, "Staff notes")[0][5] == "Alice Martin"
    comment = _sheet(wb, "Card comments")[0]
    assert comment[2] == "Alpha"
    assert comment[6:9] == ["Alice Martin", "Looks good @Bob", "12, 13"]


@pytest.mark.asyncio
async def test_site_workbook_loads_the_site_teams_with_their_members():
    pytest.importorskip("openpyxl")
    db = _fake_site_db(_site_rows())

    await build_site_export_workbook(db, 1)

    def entity(stmt):
        return stmt.column_descriptions[0].get("entity")

    def loaders(stmt) -> set[str]:
        return {
            " -> ".join(str(attr) for attr in element.path.natural_path[1::2])
            for option in stmt._with_options
            for element in option.context
        }

    (team_stmt,) = (s for s in db.statements if entity(s) is Team)
    team_sql = str(team_stmt.compile(compile_kwargs={"literal_binds": True}))
    assert "teams.site_id = 1" in team_sql
    assert "ORDER BY teams.name" in team_sql
    assert "Team.members" in loaders(team_stmt)
    (project_stmt,) = (s for s in db.statements if entity(s) is Project)
    assert "Project.teams" in loaders(project_stmt)
    (event_stmt,) = (s for s in db.statements if entity(s) is CompanyEvent)
    assert "CompanyEvent.teams" in loaders(event_stmt)


@pytest.mark.asyncio
async def test_site_workbook_unknown_site_404():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        await build_site_export_workbook(_fake_site_db({}), 1)

    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_site_workbook_for_empty_site_skips_dependent_queries():
    openpyxl = pytest.importorskip("openpyxl")
    rows = {Site: _site_rows()[Site]}
    db = _fake_site_db(rows)

    content, _ = await build_site_export_workbook(db, 1)

    queried = {s.column_descriptions[0].get("entity") for s in db.statements}
    # No users / equipment / columns / events / projects -> none of their
    # dependent lookups run.
    for skipped in (UserSkill, Vacation, EquipmentBlock, CustomColumnValue, CompanyEventSite):
        assert skipped not in queried, skipped
    assert CardComment not in queried
    wb = openpyxl.load_workbook(io.BytesIO(content))
    assert _sheet(wb, "Projects") == []
    assert _sheet(wb, "Site")[0][:2] == [1, "Winterthur Lab"]
