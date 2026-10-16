"""
Follow-ups from the review of the tags feature (tag groups, site-scoped tags).

- PUT/POST /tags: an omitted ``all_sites`` with a non-empty ``site_ids`` means
  ``all_sites = false`` (was silently dropped on a global tag).
- Commit-time IntegrityErrors (concurrent duplicate name) are a 400 with a
  rollback, not an opaque 500.
- GET /tags joins tag_groups once (contains_eager on the explicit join).
- validate_project_tags loads Tag.sites explicitly.
- Bounded id lists in the request schemas.
- DELETE /tags/{id}, duplicate group rename, group + sites change in one PUT.
- A project's PM may set tag_ids; a plain non-PM user may not.
- The tenant auto-migration step for tag groups (condition, order, rollback),
  and the step dropping the pre-release tag_groups.colors_projects column.

Mock-based, same style as tests/test_tags_groups.py.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from app.schemas.tag import TagCreate, TagGroupReorder, TagReorder, TagUpdate
from app.services import tenant_provisioner as tp
from app.services.tag_rules import validate_project_tags
from tests.conftest import FakeUser
from tests.test_tags_groups import (
    STAMP,
    _group,
    _scalar_result,
    _scalars_result,
    _site,
    _sql,
    _tag,
)


@pytest.fixture
def stamp_on_refresh(mock_db_session):
    """Simulate the DB filling id/timestamps when a new row is refreshed."""

    async def refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 42
        for attr in ("created_at", "updated_at"):
            if getattr(obj, attr, None) is None:
                setattr(obj, attr, STAMP)

    mock_db_session.refresh.side_effect = refresh
    return mock_db_session


def _integrity_error(message: str) -> IntegrityError:
    return IntegrityError("INSERT ...", {}, Exception(message))


# ---------------------------------------------------------
# Finding 1: omitted all_sites + non-empty site_ids = restricted
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_put_site_ids_on_a_global_tag_restricts_it(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),  # the sites
        _scalar_result(0),  # no project outside site 1 uses the tag
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["all_sites"] is False
    assert body["site_ids"] == [1]
    # The narrowing check ran (global -> restricted).
    count_sql = _sql(mock_db_session)[2]
    assert "projects.site_id IS NULL OR (projects.site_id NOT IN (1))" in count_sql
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_put_site_ids_on_a_global_tag_used_elsewhere_is_a_409(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalars_result([_site(1)]),
        _scalar_result(2),
    ]

    response = await client.put("/api/tags/1", json={"site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "2 projects at other sites use this tag"
    assert tag.all_sites is True
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_put_empty_site_ids_on_a_global_tag_keeps_it_global(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.put("/api/tags/1", json={"site_ids": []})

    assert response.status_code == 200, response.text
    assert response.json()["all_sites"] is True
    assert mock_db_session.execute.await_count == 1


@pytest.mark.asyncio
async def test_post_site_ids_without_all_sites_creates_a_restricted_tag(
    authed_client, stamp_on_refresh
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [
        _scalar_result(None),  # name not taken
        _scalars_result([_site(2)]),  # the sites
        _scalar_result(None),  # no ungrouped tag yet
    ]

    response = await client.post("/api/tags", json={"name": "Bern only", "site_ids": [2]})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["all_sites"] is False
    assert body["site_ids"] == [2]


@pytest.mark.asyncio
async def test_post_explicit_all_sites_true_still_clears_site_ids(authed_client, stamp_on_refresh):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    db = stamp_on_refresh
    db.execute.side_effect = [_scalar_result(None), _scalar_result(None)]

    response = await client.post(
        "/api/tags", json={"name": "Everywhere", "all_sites": True, "site_ids": [2]}
    )

    assert response.status_code == 201, response.text
    assert response.json()["all_sites"] is True
    assert response.json()["site_ids"] == []


# ---------------------------------------------------------
# Finding 3: commit-time IntegrityError -> 400 / 409 + rollback
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_tag_create_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None), _scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error(
        'duplicate key value violates unique constraint "tags_name_key"'
    )

    response = await client.post("/api/tags", json={"name": "Critical"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag with this name already exists"
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_tag_update_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(_tag(1)), _scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error("tags_name_key")

    response = await client.put("/api/tags/1", json={"name": "Taken meanwhile"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag with this name already exists"
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_group_create_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(None), _scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error("tag_groups_name_key")

    response = await client.post("/api/tag-groups", json={"name": "Project type"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag group with this name already exists"
    mock_db_session.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_group_update_race_on_the_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.side_effect = [_scalar_result(_group(5)), _scalar_result(None)]
    mock_db_session.commit.side_effect = _integrity_error("tag_groups_name_key")

    response = await client.put("/api/tag-groups/5", json={"name": "Taken meanwhile"})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag group with this name already exists"
    mock_db_session.rollback.assert_awaited()


# ---------------------------------------------------------
# Finding 5: GET /tags joins tag_groups once
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_tag_list_joins_tag_groups_once(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "user"))
    mock_db_session.execute.return_value = _scalars_result([])

    response = await client.get("/api/tags")

    assert response.status_code == 200
    sql = _sql(mock_db_session)[0]
    assert sql.count("JOIN tag_groups") == 1
    assert "tag_groups_1" not in sql


# ---------------------------------------------------------
# Finding 4: validate_project_tags loads Tag.sites explicitly
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_project_tags_selectin_loads_the_sites():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_scalars_result([]))

    await validate_project_tags(db, 1, [1])

    stmt = db.execute.await_args.args[0]
    strategies = [
        (str(load.path), dict(ctx.strategy or ()))
        for load in stmt._with_options
        for ctx in load.context
    ]
    assert any("Tag.sites" in path and s.get("lazy") == "selectin" for path, s in strategies)


# ---------------------------------------------------------
# Finding 8: bounded id lists
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "kwargs"),
    [
        (TagCreate, {"name": "X", "site_ids": list(range(201))}),
        (TagUpdate, {"site_ids": list(range(201))}),
        (TagReorder, {"tag_order": list(range(501))}),
        (TagGroupReorder, {"group_order": list(range(501))}),
    ],
    ids=["create-sites", "update-sites", "tag-reorder", "group-reorder"],
)
def test_id_lists_are_bounded(model, kwargs):
    with pytest.raises(ValidationError):
        model(**kwargs)


def test_id_lists_at_the_bound_are_accepted():
    assert len(TagCreate(name="X", site_ids=list(range(200))).site_ids or []) == 200
    assert len(TagUpdate(site_ids=list(range(200))).site_ids or []) == 200
    assert len(TagReorder(tag_order=list(range(500))).tag_order) == 500
    assert len(TagGroupReorder(group_order=list(range(500))).group_order) == 500
    assert TagUpdate().site_ids is None


# ---------------------------------------------------------
# Finding 9: further route coverage
# ---------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_deletes_a_tag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1)
    mock_db_session.execute.side_effect = [_scalar_result(tag)]

    response = await client.delete("/api/tags/1")

    assert response.status_code == 204
    mock_db_session.delete.assert_awaited_once_with(tag)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_delete_a_tag(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "superuser"))

    response = await client.delete("/api/tags/1")

    assert response.status_code == 403
    mock_db_session.delete.assert_not_awaited()
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_renaming_a_group_to_a_taken_name_is_a_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    group = _group(5, "Project type")
    mock_db_session.execute.side_effect = [_scalar_result(group), _scalar_result(9)]

    response = await client.put("/api/tag-groups/5", json={"name": " Topics "})

    assert response.status_code == 400
    assert response.json()["detail"] == "A tag group with this name already exists"
    assert group.name == "Project type"
    assert "tag_groups.id != 5" in _sql(mock_db_session)[1]
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_group_and_sites_change_runs_the_group_check_first(authed_client, mock_db_session):
    """Group peers are checked before the site narrowing; a group 409 stops there."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(_group(5, single_select=True)),
        _scalar_result(1),  # one project holds another tag of the group
    ]

    response = await client.put("/api/tags/1", json={"group_id": 5, "site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "1 project already has another tag from this group"
    assert mock_db_session.execute.await_count == 3  # no site lookup / count
    assert (tag.group_id, tag.all_sites) == (None, True)


@pytest.mark.asyncio
async def test_group_and_sites_change_then_runs_the_site_check(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(_group(5, single_select=True)),
        _scalar_result(0),  # no group peers
        _scalars_result([_site(1)]),
        _scalar_result(3),  # projects at other sites use the tag
    ]

    response = await client.put("/api/tags/1", json={"group_id": 5, "site_ids": [1]})

    assert response.status_code == 409
    assert response.json()["detail"] == "3 projects at other sites use this tag"
    sql = _sql(mock_db_session)
    assert "tags_1.group_id = 5" in sql[2]  # group peer count
    assert "projects.site_id NOT IN (1)" in sql[4]  # then the site count
    assert (tag.group_id, tag.all_sites) == (None, True)
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_group_and_sites_change_applies_both(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    tag = _tag(1, all_sites=True)
    mock_db_session.execute.side_effect = [
        _scalar_result(tag),
        _scalar_result(_group(5, single_select=True)),
        _scalar_result(0),
        _scalars_result([_site(1)]),
        _scalar_result(0),
        _scalar_result(4),  # max sort_order in the group
    ]

    response = await client.put("/api/tags/1", json={"group_id": 5, "site_ids": [1]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["group_id"], body["all_sites"], body["site_ids"]) == (5, False, [1])
    assert tag.sort_order == 5


# ---------------------------------------------------------
# PUT /projects/{id} tag_ids: the PM may, a plain non-PM user may not
# ---------------------------------------------------------

PM = 7


def _pm_project():
    project = MagicMock()
    project.id = 1
    project.name = "Bioprocess"
    project.pm_id = PM
    project.site_id = 1
    project.tags = []
    return project


@pytest.mark.asyncio
async def test_pm_sets_the_tags_of_their_project(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(PM, "user"))
    project = _pm_project()
    tag = _tag(1, "Basel only", all_sites=False, sites=[_site(1)])
    mock_db_session.execute.side_effect = [_scalar_result(project), _scalars_result([tag])]

    with patch("app.routers.projects.broadcast_change", AsyncMock()):
        response = await client.put("/api/projects/1", json={"tag_ids": [1]})

    assert response.status_code == 200, response.text
    assert project.tags == [tag]
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_non_pm_user_cannot_set_project_tags(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(5, "user"))
    project = _pm_project()
    mock_db_session.execute.side_effect = [_scalar_result(project)]

    response = await client.put("/api/projects/1", json={"tag_ids": [1]})

    assert response.status_code == 403
    assert project.tags == []
    assert mock_db_session.execute.await_count == 1  # no tag lookup
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------
# tenant_manager auto-migration: the tag-groups step
# ---------------------------------------------------------

TAG_STEP = [
    tp.TAG_GROUPS_TABLE_SQL,
    *tp.TAGS_UPGRADE_STATEMENTS,
    tp.TAG_SITES_TABLE_SQL,
    tp.TAGS_GROUP_INDEX_SQL,
    tp.TAG_SITES_SITE_INDEX_SQL,
]
DROP_COLORS_STEP = list(tp.TAG_GROUPS_DROP_COLORS_STATEMENTS)
TABLES_CHECK = "CHECK tag tables"
COLUMNS_CHECK = "CHECK tag columns"
COLORS_CHECK = "CHECK colors_projects column"


def _migration_conn(
    tables=(), columns=(), fail_on: str | None = None, has_colors_column: bool = False
):
    """
    A connection on which only the tag-groups step's and the colors_projects
    drop step's own SQL succeeds; every other auto-migration step fails (and is
    contained by its own try/except). ``log`` records those steps' statements
    interleaved with COMMIT / ROLLBACK.
    """
    log: list[str] = []

    def rows(values):
        result = MagicMock()
        result.fetchall.return_value = [(v,) for v in values]
        return result

    async def execute(clause, *args, **kwargs):
        sql = str(clause)
        if "'tag_groups', 'tag_sites'" in sql:
            log.append(TABLES_CHECK)
            return rows(tables)
        if "'group_id', 'all_sites', 'sort_order'" in sql:
            log.append(COLUMNS_CHECK)
            return rows(columns)
        if "column_name = 'colors_projects'" in sql:
            log.append(COLORS_CHECK)
            result = MagicMock()
            result.fetchone.return_value = ("colors_projects",) if has_colors_column else None
            return result
        if sql in TAG_STEP or sql in DROP_COLORS_STEP:
            log.append(sql)
            if sql == fail_on:
                raise RuntimeError("statement failed")
            return MagicMock()
        raise RuntimeError("another step")

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=execute)
    conn.commit = AsyncMock(side_effect=lambda: log.append("COMMIT"))
    conn.rollback = AsyncMock(side_effect=lambda: log.append("ROLLBACK"))
    return conn, log


async def _run_auto_migrations(conn) -> None:
    from app.services import tenant_manager

    with (
        patch.object(tenant_manager, "encrypt_tenant_sso_secret", AsyncMock()),
        patch("app.services.tenant_data_migrations.run_data_migrations", AsyncMock()),
    ):
        await tenant_manager.TenantConnectionManager()._run_auto_migrations(conn, "acme")


def _tag_step(log: list[str], first: str = TABLES_CHECK) -> list[str]:
    """A step's entries: from its first check up to its COMMIT / ROLLBACK."""
    start = log.index(first)
    for end in range(start, len(log)):
        if log[end] in ("COMMIT", "ROLLBACK"):
            return log[start : end + 1]
    return log[start:]


@pytest.mark.asyncio
async def test_tag_groups_auto_migration_runs_in_order_on_a_legacy_tenant():
    conn, log = _migration_conn(tables=(), columns=())

    await _run_auto_migrations(conn)

    assert _tag_step(log) == [TABLES_CHECK, COLUMNS_CHECK, *TAG_STEP, "COMMIT"]
    # tag_groups -> ALTER tags -> tag_sites -> indexes
    assert "CREATE TABLE IF NOT EXISTS tag_groups" in TAG_STEP[0]
    assert all("ALTER TABLE tags ADD COLUMN" in s for s in TAG_STEP[1:4])
    assert "CREATE TABLE IF NOT EXISTS tag_sites" in TAG_STEP[4]
    assert all("INDEX" in s for s in TAG_STEP[5:])


@pytest.mark.asyncio
async def test_tag_groups_auto_migration_runs_when_one_column_is_missing():
    conn, log = _migration_conn(
        tables=("tag_groups", "tag_sites"), columns=("group_id", "all_sites")
    )

    await _run_auto_migrations(conn)

    assert _tag_step(log) == [TABLES_CHECK, COLUMNS_CHECK, *TAG_STEP, "COMMIT"]


@pytest.mark.asyncio
async def test_tag_groups_auto_migration_skips_an_up_to_date_tenant():
    conn, log = _migration_conn(
        tables=("tag_groups", "tag_sites"), columns=("group_id", "all_sites", "sort_order")
    )

    await _run_auto_migrations(conn)

    start = log.index(TABLES_CHECK)
    assert log[start : start + 2] == [TABLES_CHECK, COLUMNS_CHECK]
    assert not any(entry in TAG_STEP for entry in log)


@pytest.mark.asyncio
async def test_tag_groups_auto_migration_rolls_back_quietly_on_failure():
    failing = tp.TAGS_UPGRADE_STATEMENTS[0]
    conn, log = _migration_conn(fail_on=failing)

    await _run_auto_migrations(conn)  # never raises

    assert _tag_step(log) == [
        TABLES_CHECK,
        COLUMNS_CHECK,
        tp.TAG_GROUPS_TABLE_SQL,
        failing,
        "ROLLBACK",
    ]
    # Nothing after the failing statement ran, and later steps still ran.
    assert tp.TAG_SITES_TABLE_SQL not in log
    assert conn.execute.await_count > len(_tag_step(log))


# ---------------------------------------------------------
# tenant_manager auto-migration: dropping tag_groups.colors_projects
# ---------------------------------------------------------

UP_TO_DATE_TAGS = {
    "tables": ("tag_groups", "tag_sites"),
    "columns": ("group_id", "all_sites", "sort_order"),
}


@pytest.mark.asyncio
async def test_colors_projects_is_dropped_when_the_column_exists():
    conn, log = _migration_conn(**UP_TO_DATE_TAGS, has_colors_column=True)

    await _run_auto_migrations(conn)

    assert _tag_step(log, COLORS_CHECK) == [COLORS_CHECK, *DROP_COLORS_STEP, "COMMIT"]
    # Index first, then the column; both guarded so a re-run is a no-op.
    assert DROP_COLORS_STEP == [
        "DROP INDEX IF EXISTS idx_tag_groups_colors_projects",
        "ALTER TABLE tag_groups DROP COLUMN IF EXISTS colors_projects",
    ]
    # Runs after the tag-groups step.
    assert log.index(TABLES_CHECK) < log.index(COLORS_CHECK)


@pytest.mark.asyncio
async def test_colors_projects_drop_is_skipped_without_the_column():
    conn, log = _migration_conn(**UP_TO_DATE_TAGS, has_colors_column=False)

    await _run_auto_migrations(conn)

    assert COLORS_CHECK in log
    assert not any(entry in DROP_COLORS_STEP for entry in log)
    conn.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_colors_projects_drop_rolls_back_quietly_on_failure():
    failing = DROP_COLORS_STEP[0]
    conn, log = _migration_conn(**UP_TO_DATE_TAGS, fail_on=failing, has_colors_column=True)

    await _run_auto_migrations(conn)  # never raises

    assert _tag_step(log, COLORS_CHECK) == [COLORS_CHECK, failing, "ROLLBACK"]
    assert DROP_COLORS_STEP[1] not in log
    assert "COMMIT" not in log
    # Later steps still ran.
    assert conn.execute.await_count > len(_tag_step(log, COLORS_CHECK))
