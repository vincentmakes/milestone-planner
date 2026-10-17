"""
Imported tasks must keep `status` in step with `completion`.

POST /import/project used to pass `completion=` straight to the ORM
constructors, bypassing app/services/card_status.py, so a task imported at
100% landed in the Kanban "To Do" column. MPXJ also yields a float and the CSV
parser an unbounded int, for an INTEGER column the API validates to 0..100.
Mock-based: the DB session records added rows; MPXJ (needs a JVM) is patched.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.routers.mpp_import import normalize_percent_complete, parse_csv_file
from tests.conftest import FakeUser


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 0),
        ("", 0),
        ("abc", 0),
        (True, 0),
        (float("nan"), 0),
        (float("inf"), 0),
        (0, 0),
        (37.6, 38),
        (100.0, 100),
        (150, 100),
        (-5, 0),
        ("75%", 75),
        (" 42.4 % ", 42),
        ("250", 100),
    ],
)
def test_normalize_percent_complete(raw, expected):
    result = normalize_percent_complete(raw)
    assert result == expected
    assert type(result) is int


def test_csv_parser_clamps_and_accepts_decimals():
    content = (
        "ID,Name,Start,Finish,% Complete,Outline Level\n"
        "1,Over,2026-01-05,2026-01-09,150%,2\n"
        "2,Decimal,2026-01-05,2026-01-09,62.5%,2\n"
        "3,Junk,2026-01-05,2026-01-09,n/a,2\n"
    )
    tasks = parse_csv_file(content)["tasks"]
    assert [t["percent_complete"] for t in tasks] == [100, 62, 0]


def _recording_db(mock_db_session) -> list:
    """Record db.add()ed rows and give each an id on flush, as a real flush would."""
    added: list = []
    mock_db_session.add.side_effect = added.append
    counter = {"next": 1}

    async def flush():
        for obj in added:
            if getattr(obj, "id", None) is None:
                obj.id = counter["next"]
                counter["next"] += 1

    mock_db_session.flush = AsyncMock(side_effect=flush)
    return added


def _cards(added):
    return {
        (o.type if isinstance(o, ProjectPhase) else o.name): o
        for o in added
        if isinstance(o, (ProjectPhase, ProjectSubphase))
    }


@pytest.mark.asyncio
async def test_csv_import_derives_status_from_completion(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    added = _recording_db(mock_db_session)
    csv_content = (
        "ID,Name,Start,Finish,% Complete,Outline Level\n"
        "1,Project,2026-01-05,2026-02-27,40%,1\n"
        "2,Done phase,2026-01-05,2026-01-16,100%,2\n"
        "3,Running sub,2026-01-05,2026-01-09,150,3\n"
        "4,Fresh phase,2026-01-19,2026-02-27,0%,2\n"
        "5,Half sub,2026-01-19,2026-01-23,50%,3\n"
    )

    response = await client.post(
        "/api/import/project",
        files={"file": ("plan.csv", csv_content.encode(), "text/csv")},
        data={"site_id": "1"},
    )

    assert response.status_code == 200, response.text
    assert any(isinstance(o, Project) for o in added)
    cards = _cards(added)
    assert (cards["Done phase"].completion, cards["Done phase"].status) == (100, "done")
    # Out-of-range input is clamped, and status follows the clamped value.
    assert (cards["Running sub"].completion, cards["Running sub"].status) == (100, "done")
    assert (cards["Fresh phase"].completion, cards["Fresh phase"].status) == (0, "todo")
    assert (cards["Half sub"].completion, cards["Half sub"].status) == (50, "in_progress")


@pytest.mark.asyncio
async def test_mpp_import_derives_status_and_stores_an_int(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    added = _recording_db(mock_db_session)
    # Shape of parse_mpp_file() output (raw MPXJ floats, as older parsers emitted).
    project_data = {
        "name": "MPP plan",
        "start_date": "2026-01-05",
        "finish_date": "2026-02-27",
        "tasks": [
            {"id": 1, "name": "MPP plan", "outline_level": 1, "percent_complete": 30.0},
            {
                "id": 2,
                "name": "Finished",
                "outline_level": 2,
                "parent_id": 1,
                "start": "2026-01-05",
                "finish": "2026-01-16",
                "percent_complete": 100.0,
            },
            {
                "id": 3,
                "name": "Partial",
                "outline_level": 3,
                "parent_id": 2,
                "start": "2026-01-05",
                "finish": "2026-01-09",
                "percent_complete": 33.4,
            },
        ],
    }

    with patch("app.routers.mpp_import.parse_mpp_file", return_value=project_data):
        response = await client.post(
            "/api/import/project",
            files={"file": ("plan.mpp", b"binary", "application/octet-stream")},
        )

    assert response.status_code == 200, response.text
    cards = _cards(added)
    finished, partial = cards["Finished"], cards["Partial"]
    assert (finished.completion, finished.status) == (100, "done")
    assert (partial.completion, partial.status) == (33, "in_progress")
    assert type(finished.completion) is int
    assert type(partial.completion) is int


@pytest.mark.asyncio
async def test_imported_dependencies_name_their_predecessor_kind(authed_client, mock_db_session):
    """Imported links carry `entity`: phase and subphase ids can collide."""
    import json

    client, set_user = authed_client
    set_user(FakeUser(9, "superuser"))
    added = _recording_db(mock_db_session)

    async def get(model, pk):
        return next((o for o in added if isinstance(o, model) and o.id == pk), None)

    mock_db_session.get = AsyncMock(side_effect=get)
    task = {"start": "2026-01-05", "finish": "2026-01-09"}
    project_data = {
        "name": "Linked plan",
        "start_date": "2026-01-05",
        "finish_date": "2026-02-27",
        "tasks": [
            {"id": 1, "name": "Linked plan", "outline_level": 1},
            {"id": 2, "name": "Design", "outline_level": 2, "parent_id": 1, **task},
            {"id": 3, "name": "Spec", "outline_level": 3, "parent_id": 2, **task},
            {
                "id": 4,
                "name": "Build",
                "outline_level": 2,
                "parent_id": 1,
                **task,
                "predecessors": [{"id": 3, "type": "FS"}, {"id": 2, "type": "SS"}],
            },
        ],
    }

    with patch("app.routers.mpp_import.parse_mpp_file", return_value=project_data):
        response = await client.post(
            "/api/import/project",
            files={"file": ("plan.mpp", b"binary", "application/octet-stream")},
        )

    assert response.status_code == 200, response.text
    cards = _cards(added)
    assert json.loads(cards["Build"].dependencies) == [
        {"id": cards["Spec"].id, "type": "FS", "entity": "subphase"},
        {"id": cards["Design"].id, "type": "SS", "entity": "phase"},
    ]
