"""
app/services/change_notifications.py: "someone else changed your booking or
your project" notifications.

``deliver`` runs after the route's commit, in its own short transaction: it
resolves the project manager and the names a route did not have at hand
(``{project}`` / ``{target}`` / ``{person}``), drops the actor, inactive users
and the already-notified, merges to one row per recipient, and coalesces with
the newest unread row of the same (recipient, type, project, actor) from the
last ten minutes under a transaction-scoped advisory lock. A failure rolls back
and never raises. The text builders are pure.

The autouse ``change_intents`` fixture (tests/conftest.py) replaces ``deliver``
with a recorder for route tests; ``REAL_DELIVER`` is the function itself,
captured when this module is imported (before any fixture runs).
"""

from datetime import date, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import BinaryExpression, BindParameter, Null, TextClause
from sqlalchemy.sql.visitors import iterate

from app.models.notification import Notification
from app.models.project import Project
from app.models.user import User
from app.services import change_notifications as cn
from app.services.approvals import ACTION_CREATE, ACTION_REMOVE, ACTION_UPDATE
from app.services.change_notifications import ChangeIntent
from app.services.notifications import _TYPE_PRIORITY
from tests.conftest import FakeUser
from tests.support import ApprovalFakeDB, dispatch_result

REAL_DELIVER = cn.deliver

ACTOR = 1
PM = 7
DIANA = 3
BOB = 4
NOW = datetime(2026, 10, 22, 12, 0, 0)


def actor(user_id: int = ACTOR) -> FakeUser:
    user = FakeUser(user_id, "admin")
    user.first_name, user.last_name = "Ada", "Admin"
    return user


# ---------------------------------------------------------------------------
# A session answering the three queries deliver makes, by what they select
# ---------------------------------------------------------------------------


def _criteria(stmt) -> dict[str, tuple[Any, Any]]:
    """``{column: (operator, value)}`` of a SELECT's WHERE (ANDed binary terms)."""
    found: dict[str, tuple[Any, Any]] = {}
    if stmt.whereclause is None:
        return found
    for node in iterate(stmt.whereclause):
        if not isinstance(node, BinaryExpression):
            continue
        column = getattr(node.left, "key", None)
        right = node.right
        if isinstance(right, BindParameter):
            value = right.value if right.value is not None else right.effective_value
        elif isinstance(right, Null):
            value = None
        else:
            continue
        found[f"{node.left.table.name}.{column}"] = (node.operator, value)
    return found


def _matches(row: Notification, criteria: dict[str, tuple[Any, Any]]) -> bool:
    for key, (op, value) in criteria.items():
        actual = getattr(row, key.split(".", 1)[1])
        if op is operators.eq and actual != value:
            return False
        if op is operators.is_ and actual is not None:
            return False
        if op is operators.ge and actual < value:
            return False
    return True


class ChangeFakeDB(ApprovalFakeDB):
    """
    ``contexts[project_id]``: the load_context row ``(name, pm_id, site_id,
    target_id, target_name)``; ``users``: ``(id, first, last, email, active)``;
    ``existing``: notifications already in the inbox (the coalescing lookup
    evaluates its WHERE on them). ``fail``: raise on the nth INSERT/UPDATE step.
    """

    def __init__(self, *, contexts=None, users=(), existing=(), fail: str | None = None):
        super().__init__()
        self.contexts: dict[int, tuple] = dict(contexts or {})
        self.users = list(users)
        self.existing: list[Notification] = list(existing)
        self.locks: list[str] = []
        self.order: list[str] = []
        self.fail = fail
        self.rollback = AsyncMock()

    async def execute(self, stmt, params=None):  # type: ignore[override]
        self.statements.append(stmt)
        if isinstance(stmt, TextClause):
            assert "pg_advisory_xact_lock(hashtext(:key))" in str(stmt)
            if self.fail == "lock":
                raise RuntimeError("lock failed")
            self.locks.append(params["key"])
            self.order.append(f"lock {params['key']}")
            return MagicMock()
        entity = stmt.column_descriptions[0].get("entity")
        criteria = _criteria(stmt)
        if entity is Notification:
            if self.fail == "lookup":
                raise RuntimeError("lookup failed")
            self.order.append(f"lookup {criteria['notifications.user_id'][1]}")
            hits = sorted(
                (n for n in self.existing if _matches(n, criteria)),
                key=lambda n: n.created_at,
                reverse=True,
            )
            return dispatch_result(hits[:1])
        if entity is Project:
            project_id = criteria["projects.id"][1]
            row = self.contexts.get(project_id)
            return dispatch_result([row] if row else [])
        if entity is User:
            wanted = set(criteria["users.id"][1])
            return dispatch_result([u for u in self.users if u[0] in wanted])
        raise AssertionError(f"unexpected query: {stmt}")

    def queried(self, key: str) -> int:
        """Project (``context``) and user lookups; locks and inbox lookups are not counted."""
        entity = {"context": Project, "users": User}[key]
        return sum(
            1
            for s in self.statements
            if not isinstance(s, TextClause) and s.column_descriptions[0]["entity"] is entity
        )

    @property
    def inserted(self) -> list[Notification]:
        return [obj for obj in self.added if isinstance(obj, Notification)]


def users(*rows) -> list[tuple]:
    base = {
        ACTOR: (ACTOR, "Ada", "Admin", "ada@x", 1),
        PM: (PM, "Bob", "Brown", "bob@x", 1),
        DIANA: (DIANA, "Diana", "Doe", "diana@x", 1),
        BOB: (BOB, "Carl", "Cole", "carl@x", 1),
    }
    out = list(base.values())
    for row in rows:
        out = [r for r in out if r[0] != row[0]] + [row]
    return out


def context(pm_id=PM, name="Alpha", target="Design") -> tuple:
    return (name, pm_id, 1, 11, target)


def intent(**fields) -> ChangeIntent:
    values: dict[str, Any] = {
        "recipient": "person",
        "type": "assignment_changed",
        "user_id": DIANA,
        "project_id": 1,
        "project_name": None,
        "entity_type": "phase",
        "entity_id": 11,
        "title": "Ada Admin changed your booking on {target}",
        "body": "allocation 50% → 80%",
        "coalesce": True,
    }
    values.update(fields)
    return ChangeIntent(**values)


def pm_intent(**fields) -> ChangeIntent:
    values: dict[str, Any] = {
        "recipient": "pm",
        "type": "project_changed",
        "user_id": None,
        "title": "Ada Admin changed {person}'s booking on {target}",
        "person_id": DIANA,
    }
    values.update(fields)
    return intent(**values)


def unread(**fields) -> Notification:
    values: dict[str, Any] = {
        "id": 900,
        "user_id": DIANA,
        "type": "assignment_changed",
        "actor_id": ACTOR,
        "entity_type": "phase",
        "entity_id": 11,
        "project_id": 1,
        "title": "Ada Admin changed your booking on Design",
        "body": "allocation 40% → 50%",
        "read_at": None,
        "created_at": NOW - timedelta(minutes=3),
    }
    values.update(fields)
    return Notification(**values)


@pytest.fixture
def now():
    with patch.object(cn, "utcnow_naive", return_value=NOW):
        yield NOW


@pytest.fixture
def pushes():
    sent: list[tuple[int, dict]] = []

    async def record(_request, user_id, payload):
        sent.append((user_id, payload))

    with patch.object(cn, "send_notification", side_effect=record):
        yield sent


async def run(db, intents, *, actor_id=ACTOR, already=()):
    await REAL_DELIVER(db, MagicMock(), actor_id, intents, already_notified=set(already))


# ---------------------------------------------------------------------------
# Recipients
# ---------------------------------------------------------------------------


def test_priority_keeps_change_types_between_todo_and_status():
    assert _TYPE_PRIORITY == (
        "mention",
        "approval_requested",
        "approval_decided",
        "assigned",
        "todo_assigned",
        "assignment_changed",
        "project_changed",
        "status_change",
        "comment",
    )


async def test_empty_list_is_a_no_op():
    db = ChangeFakeDB()
    await run(db, [])
    assert db.statements == []
    db.commit.assert_not_awaited()


async def test_person_and_pm_each_get_one_row_with_names_filled(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(db, [intent(), pm_intent()])

    rows = {n.user_id: n for n in db.inserted}
    assert set(rows) == {DIANA, PM}
    assert rows[DIANA].title == "Ada Admin changed your booking on Design"
    assert rows[DIANA].type == "assignment_changed"
    assert rows[PM].title == "Ada Admin changed Diana Doe's booking on Design"
    assert rows[PM].type == "project_changed"
    for row in rows.values():
        assert row.actor_id == ACTOR
        assert row.project_id == 1
        assert (row.entity_type, row.entity_id) == ("phase", 11)
        assert row.created_at == NOW
        assert row.read_at is None
    db.commit.assert_awaited_once()
    assert sorted(user for user, _ in pushes) == sorted([PM, DIANA])
    assert all(
        payload["type"] in ("assignment_changed", "project_changed") for _, payload in pushes
    )


async def test_one_query_per_project_and_one_user_query(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(db, [intent(), pm_intent(), pm_intent(person_id=BOB, title="x {person}")])

    assert db.queried("context") == 1
    assert db.queried("users") == 1


async def test_the_actor_is_never_notified(now, pushes):
    db = ChangeFakeDB(contexts={1: context(pm_id=ACTOR)}, users=users())

    await run(db, [intent(user_id=ACTOR), pm_intent()])

    assert db.inserted == []
    assert pushes == []


async def test_inactive_recipients_are_skipped(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users((DIANA, "Diana", "Doe", "d@x", 0)))

    await run(db, [intent(), pm_intent()])

    assert [n.user_id for n in db.inserted] == [PM]


async def test_unknown_recipients_are_skipped(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=[u for u in users() if u[0] != DIANA])

    await run(db, [intent()])

    assert db.inserted == []


async def test_already_notified_recipients_are_skipped(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(db, [intent(), pm_intent()], already={DIANA})

    assert [n.user_id for n in db.inserted] == [PM]


async def test_a_project_without_manager_drops_the_pm_intent(now, pushes):
    db = ChangeFakeDB(contexts={1: context(pm_id=None)}, users=users())

    await run(db, [pm_intent()])

    assert db.inserted == []


async def test_a_gone_project_drops_its_intents(now, pushes):
    db = ChangeFakeDB(contexts={}, users=users())

    await run(db, [intent(), pm_intent()])

    assert db.inserted == []


async def test_explicit_pm_id_wins_over_the_project(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(db, [pm_intent(user_id=BOB)])

    assert [n.user_id for n in db.inserted] == [BOB]


async def test_one_row_per_recipient_assignment_outranks_project(now, pushes):
    # The PM is the booked person: one row, the assignment one, bodies joined.
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(
        db,
        [
            pm_intent(person_id=PM, body="allocation 50% → 80%"),
            intent(user_id=PM, body="allocation 50% → 80%"),
            pm_intent(person_id=PM, title="Ada Admin moved Design", body="dates moved"),
        ],
    )

    (row,) = db.inserted
    assert row.user_id == PM
    assert row.type == "assignment_changed"
    assert row.title == "Ada Admin changed your booking on Design"
    assert row.body == "allocation 50% → 80%; dates moved"


async def test_braces_in_names_are_literal(now, pushes):
    db = ChangeFakeDB(
        contexts={1: context(target="{person} lab")},
        users=users((DIANA, "{project}", "", "d@x", 1)),
    )

    await run(db, [pm_intent(title="Ada {{x}} changed {person}'s booking on {target}")])

    (row,) = db.inserted
    assert row.title == "Ada {x} changed {project}'s booking on {person} lab"


async def test_title_is_truncated_to_200(now, pushes):
    db = ChangeFakeDB(contexts={1: context(target="T" * 300)}, users=users())

    await run(db, [intent()])

    (row,) = db.inserted
    assert len(row.title) == 200


# ---------------------------------------------------------------------------
# Coalescing
# ---------------------------------------------------------------------------


async def test_a_recent_unread_row_of_the_same_kind_is_updated(now, pushes):
    existing = unread()
    db = ChangeFakeDB(contexts={1: context()}, users=users(), existing=[existing])

    await run(db, [intent()])

    assert db.inserted == []
    assert existing.title == "2 changes by Ada Admin on Alpha"
    assert existing.body == "Ada Admin changed your booking on Design — allocation 50% → 80%"
    assert existing.created_at == NOW
    assert (existing.entity_type, existing.entity_id) == ("phase", 11)
    assert pushes == [(DIANA, cn.notification_payload(existing))]
    assert pushes[0][1]["id"] == 900


async def test_the_count_increments(now, pushes):
    existing = unread(title="4 changes by Ada Admin on Alpha")
    db = ChangeFakeDB(contexts={1: context()}, users=users(), existing=[existing])

    await run(db, [intent(body=None)])

    assert existing.title == "5 changes by Ada Admin on Alpha"
    assert existing.body == "Ada Admin changed your booking on Design"


async def test_different_entities_collapse_to_the_project(now, pushes):
    existing = unread(entity_type="subphase", entity_id=12)
    db = ChangeFakeDB(contexts={1: context()}, users=users(), existing=[existing])

    await run(db, [intent()])

    assert (existing.entity_type, existing.entity_id) == ("project", 1)


async def test_the_newest_matching_row_is_the_one_updated(now, pushes):
    older = unread(id=901, created_at=NOW - timedelta(minutes=8))
    newer = unread(id=902, created_at=NOW - timedelta(minutes=1))
    db = ChangeFakeDB(contexts={1: context()}, users=users(), existing=[older, newer])

    await run(db, [intent()])

    assert newer.title.startswith("2 changes by")
    assert not older.title.startswith("2 changes by")


@pytest.mark.parametrize(
    "fields",
    [
        {"read_at": NOW - timedelta(minutes=1)},
        {"created_at": NOW - timedelta(minutes=11)},
        {"actor_id": 99},
        {"type": "project_changed"},
        {"project_id": 2},
        {"user_id": PM},
    ],
    ids=["read", "older-than-10-min", "other-actor", "other-type", "other-project", "other-user"],
)
async def test_coalescing_misses_insert_a_new_row(now, pushes, fields):
    existing = unread(**fields)
    title_before = existing.title
    db = ChangeFakeDB(contexts={1: context()}, users=users(), existing=[existing])

    await run(db, [intent()])

    (row,) = db.inserted
    assert row.title == "Ada Admin changed your booking on Design"
    assert existing.title == title_before


async def test_locks_are_taken_in_sorted_key_order_before_each_lookup(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    await run(db, [pm_intent(), intent(), intent(user_id=BOB)])

    keys = [
        f"{BOB}|assignment_changed|1|{ACTOR}",
        f"{DIANA}|assignment_changed|1|{ACTOR}",
        f"{PM}|project_changed|1|{ACTOR}",
    ]
    assert db.locks == sorted(keys)
    for key in db.locks:
        user_id = key.split("|", 1)[0]
        assert db.order.index(f"lookup {user_id}") == db.order.index(f"lock {key}") + 1


async def test_a_project_delete_is_never_coalesced(now, pushes):
    existing = unread(project_id=None, entity_type=None, entity_id=None, title="Ada deleted X")
    db = ChangeFakeDB(users=users(), existing=[existing])
    deleted = cn.project_deleted_intents(actor(), project_name="Alpha", pm_id=PM, bookers=[DIANA])

    await run(db, deleted)

    assert db.locks == []
    rows = {n.user_id: n for n in db.inserted}
    assert set(rows) == {PM, DIANA}
    for row in rows.values():
        assert row.title == "Ada Admin deleted Alpha"
        assert row.project_id is None
        assert row.entity_type is None and row.entity_id is None
    assert rows[DIANA].type == "assignment_changed"
    assert rows[PM].type == "project_changed"
    assert existing.title == "Ada deleted X"
    assert db.queried("context") == 0


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fail", ["lock", "lookup"])
async def test_a_failure_rolls_back_and_never_raises(now, pushes, fail, caplog):
    db = ChangeFakeDB(contexts={1: context()}, users=users(), fail=fail)

    await run(db, [intent()])  # never raises

    db.rollback.assert_awaited_once()
    db.commit.assert_not_awaited()
    assert pushes == []
    assert "Change notifications failed" in caplog.text


async def test_a_failing_rollback_is_swallowed(now, pushes):
    db = ChangeFakeDB(contexts={1: context()}, users=users(), fail="lock")
    db.rollback.side_effect = RuntimeError("connection gone")

    await run(db, [intent()])  # never raises


async def test_a_failed_push_never_raises(now, caplog):
    db = ChangeFakeDB(contexts={1: context()}, users=users())

    with patch.object(cn, "send_notification", AsyncMock(side_effect=RuntimeError("ws"))):
        await run(db, [intent(), pm_intent()])

    db.commit.assert_awaited_once()
    assert "Notification push failed" in caplog.text


# ---------------------------------------------------------------------------
# Text builders
# ---------------------------------------------------------------------------


def _by(intents: list[ChangeIntent]) -> dict[str, ChangeIntent]:
    return {i.recipient: i for i in intents}


def test_booking_create_texts():
    out = _by(
        cn.booking_intents(
            actor(),
            kind="create",
            level="phase",
            project_id=1,
            target_id=11,
            staff_id=DIANA,
            values={"allocation": 80},
        )
    )
    assert out["person"].user_id == DIANA
    assert out["person"].type == "assignment_changed"
    assert out["person"].title == "Ada Admin booked you on {target}"
    assert out["person"].body == "at 80%"
    assert out["pm"].user_id is None and out["pm"].person_id == DIANA
    assert out["pm"].type == "project_changed"
    assert out["pm"].title == "Ada Admin booked {person} on {target}"
    for i in out.values():
        assert (i.project_id, i.entity_type, i.entity_id) == (1, "phase", 11)
        assert i.coalesce


def test_booking_project_level_targets_the_project_and_names_literals():
    out = _by(
        cn.booking_intents(
            actor(),
            kind="create",
            level="project",
            project_id=1,
            target_id=1,
            staff_id=ACTOR,
            values={"allocation": 50, "start_date": "2026-01-01", "end_date": "2026-02-01"},
            target_name="Design {x}",
        )
    )
    assert out["pm"].title == "Ada Admin booked themself on Design {{x}}"
    assert out["pm"].body == "at 50% from 2026-01-01 to 2026-02-01"
    assert (out["pm"].entity_type, out["pm"].entity_id) == ("project", 1)


def test_booking_update_texts_and_no_op():
    values, previous = {"allocation": 80}, {"allocation": 50}
    out = _by(
        cn.booking_intents(
            actor(),
            kind="update",
            level="subphase",
            project_id=1,
            target_id=12,
            staff_id=DIANA,
            values=values,
            previous=previous,
            person_name="Diana Doe",
        )
    )
    assert out["person"].title == "Ada Admin changed your booking on {target}"
    assert out["person"].body == "allocation 50% → 80%"
    assert out["pm"].title == "Ada Admin changed Diana Doe's booking on {target}"
    assert (
        cn.booking_intents(
            actor(),
            kind="update",
            level="phase",
            project_id=1,
            target_id=11,
            staff_id=DIANA,
            values=previous,
            previous=dict(previous),
        )
        == []
    )
    own = _by(
        cn.booking_intents(
            actor(),
            kind="update",
            level="phase",
            project_id=1,
            target_id=11,
            staff_id=ACTOR,
            values=values,
            previous=previous,
        )
    )
    assert own["pm"].title == "Ada Admin changed their own booking on {target}"


def test_booking_remove_texts():
    out = _by(
        cn.booking_intents(
            actor(),
            kind="remove",
            level="phase",
            project_id=1,
            target_id=11,
            staff_id=DIANA,
            previous={"allocation": 80},
        )
    )
    assert out["person"].title == "Ada Admin removed you from {target}"
    assert out["person"].body == "Was at 80%"
    assert out["pm"].title == "Ada Admin removed {person} from {target}"
    own = _by(
        cn.booking_intents(
            actor(),
            kind="remove",
            level="phase",
            project_id=1,
            target_id=11,
            staff_id=ACTOR,
            previous={"allocation": 80},
        )
    )
    assert own["pm"].title == "Ada Admin removed themself from {target}"


def test_equipment_texts():
    (create,) = cn.equipment_intents(
        actor(), kind="create", project_id=1, equipment_name="HPLC", body="from a to b"
    )
    assert create.recipient == "pm" and create.user_id is None
    assert create.title == "Ada Admin booked HPLC for {project}"
    assert (create.entity_type, create.entity_id) == ("project", 1)
    (update,) = cn.equipment_intents(
        actor(), kind="update", project_id=1, equipment_name="HPLC", body="x"
    )
    assert update.title == "Ada Admin changed the HPLC booking for {project}"
    (remove,) = cn.equipment_intents(
        actor(), kind="remove", project_id=1, equipment_name="HPLC", body=None
    )
    assert remove.title == "Ada Admin removed the HPLC booking from {project}"


BEFORE = {
    "name": "Alpha",
    "start_date": date(2026, 1, 1),
    "end_date": date(2026, 6, 30),
    "customer": "Acme",
    "confirmed": 0,
    "volume": 10,
    "archived": 0,
    "pm_id": PM,
}


def test_project_update_without_diff_is_nothing():
    assert (
        cn.project_update_intents(
            actor(), project_id=1, project_name="Alpha", before=BEFORE, after=dict(BEFORE)
        )
        == []
    )


def test_project_update_lists_every_change():
    after = {
        **BEFORE,
        "name": "Beta",
        "end_date": date(2026, 7, 31),
        "customer": None,
        "confirmed": 1,
        "volume": 12,
        "archived": 1,
    }
    (only,) = cn.project_update_intents(
        actor(), project_id=1, project_name="Beta", before=BEFORE, after=after
    )
    assert only.recipient == "pm" and only.user_id == PM
    assert only.title == "Ada Admin changed Beta"
    assert only.body == (
        "name Alpha → Beta; dates 2026-01-01–2026-06-30 → 2026-01-01–2026-07-31; "
        "customer Acme → —; confirmed; volume 10 → 12; archived"
    )
    restored = {**BEFORE, "archived": 1, "confirmed": 1}
    (back,) = cn.project_update_intents(
        actor(), project_id=1, project_name="Alpha", before=restored, after=BEFORE
    )
    assert back.body == "unconfirmed; restored"


def test_project_hand_over_notifies_both_managers():
    after = {**BEFORE, "pm_id": BOB, "volume": 11}
    out = cn.project_update_intents(
        actor(), project_id=1, project_name="Alpha", before=BEFORE, after=after
    )
    by_user = {i.user_id: i for i in out}
    assert by_user[PM].title == "Ada Admin handed Alpha over to {person}"
    assert by_user[PM].person_id == BOB
    assert by_user[PM].body == "volume 10 → 11"
    assert by_user[BOB].title == "Ada Admin made you the manager of Alpha"
    assert by_user[BOB].body == "volume 10 → 11"


def test_project_hand_over_from_nobody():
    out = cn.project_update_intents(
        actor(),
        project_id=1,
        project_name="Alpha",
        before={**BEFORE, "pm_id": None},
        after={**BEFORE, "pm_id": BOB},
    )
    assert [(i.user_id, i.title) for i in out] == [(BOB, "Ada Admin made you the manager of Alpha")]
    assert out[0].body is None


def test_manager_intent():
    (only,) = cn.manager_intents(actor(), project_id=1, project_name="Alpha", pm_id=BOB)
    assert (only.recipient, only.type, only.user_id) == ("pm", "project_changed", BOB)
    assert only.title == "Ada Admin made you the manager of Alpha"
    assert cn.manager_intents(actor(), project_id=1, project_name="Alpha", pm_id=None) == []


def test_card_added_intent():
    (only,) = cn.card_added_intents(
        actor(),
        project_id=1,
        entity_type="phase",
        entity_id=11,
        name="Design",
        start=date(2026, 1, 1),
        end=date(2026, 2, 1),
    )
    assert only.title == "Ada Admin added Design to {project}"
    assert only.body == "from 2026-01-01 to 2026-02-01"
    assert (only.entity_type, only.entity_id) == ("phase", 11)


def test_card_moved_intents():
    out = cn.card_moved_intents(
        actor(),
        project_id=1,
        entity_type="subphase",
        entity_id=12,
        name="Trial",
        old=(date(2026, 1, 1), date(2026, 1, 10)),
        new=(date(2026, 1, 5), date(2026, 1, 14)),
        bookers=[(DIANA, 60)],
    )
    by = {(i.recipient, i.user_id): i for i in out}
    dates = "dates 2026-01-01–2026-01-10 → 2026-01-05–2026-01-14"
    assert by[("person", DIANA)].title == "Ada Admin moved Trial"
    assert by[("person", DIANA)].body == f"{dates} (you are booked at 60%)"
    assert by[("pm", None)].body == dates
    assert all((i.entity_type, i.entity_id) == ("subphase", 12) for i in out)
    same = (date(2026, 1, 1), date(2026, 1, 10))
    assert (
        cn.card_moved_intents(
            actor(),
            project_id=1,
            entity_type="phase",
            entity_id=11,
            name="Trial",
            old=same,
            new=same,
            bookers=[(DIANA, 60)],
        )
        == []
    )


def test_card_deleted_intents():
    out = cn.card_deleted_intents(actor(), project_id=1, name="Trial", bookers=[DIANA])
    by = {i.recipient: i for i in out}
    assert by["person"].title == "Ada Admin removed you from Trial (Trial deleted)"
    assert by["pm"].title == "Ada Admin removed Trial from {project}"
    assert all((i.entity_type, i.entity_id) == ("project", 1) for i in out)


def test_project_deleted_intents():
    out = cn.project_deleted_intents(actor(), project_name="Alpha", pm_id=PM, bookers=[DIANA, PM])
    assert {(i.recipient, i.user_id) for i in out} == {
        ("person", DIANA),
        ("person", PM),
        ("pm", PM),
    }
    assert all(
        i.project_id is None
        and i.entity_type is None
        and not i.coalesce
        and i.project_name == "Alpha"
        for i in out
    )


@pytest.mark.parametrize(
    ("action", "requested", "previous", "body"),
    [
        (ACTION_CREATE, {"allocation": 80}, None, "at 80%"),
        (ACTION_UPDATE, {"allocation": 80}, {"allocation": 50}, "allocation 50% → 80%"),
        (ACTION_REMOVE, None, {"allocation": 50}, "removal"),
    ],
)
def test_approval_intent(action, requested, previous, body):
    (only,) = cn.approval_intents(
        actor(),
        project_id=1,
        level="phase",
        target_id=11,
        target_name="Design",
        pm_id=PM,
        requester_id=DIANA,
        action=action,
        requested=requested,
        previous=previous,
    )
    assert (only.recipient, only.type, only.user_id, only.person_id) == (
        "pm",
        "project_changed",
        PM,
        DIANA,
    )
    assert only.title == "Ada Admin approved {person}'s request on Design"
    assert only.body == body
    assert (only.entity_type, only.entity_id) == ("phase", 11)


def test_conftest_records_deliver_calls(change_intents):
    # The autouse recorder replaced the module attribute; REAL_DELIVER is the original.
    assert cn.deliver is not REAL_DELIVER
    assert change_intents == []


def test_approval_intent_without_a_manager_is_nothing():
    assert (
        cn.approval_intents(
            actor(),
            project_id=1,
            level="project",
            target_id=1,
            target_name="Alpha",
            pm_id=None,
            requester_id=DIANA,
            action=ACTION_CREATE,
            requested={"allocation": 80},
            previous=None,
        )
        == []
    )


async def test_a_project_level_entity_resolves_the_project_as_target(now, pushes):
    db = ChangeFakeDB(contexts={1: ("Alpha", PM, 1, 1, "Alpha")}, users=users())

    await run(db, [pm_intent(entity_type="project", entity_id=1)])

    (row,) = db.inserted
    assert row.title == "Ada Admin changed Diana Doe's booking on Alpha"
    project_query = next(
        s for s in db.statements if not isinstance(s, TextClause) and "projects" in str(s)
    )
    assert "project_phases" not in str(project_query)
    assert "project_subphases" not in str(project_query)


# ---------------------------------------------------------------------------
# Booker queries
# ---------------------------------------------------------------------------


def _compiled(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


async def test_approved_bookers_without_scope_runs_no_query():
    db = MagicMock()
    db.execute = AsyncMock()
    assert await cn.approved_bookers(db) == []
    db.execute.assert_not_awaited()


async def test_approved_bookers_of_a_project_cover_every_level_once():
    result = MagicMock()
    result.scalars.return_value.all.return_value = [3, 4, 3]
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    assert await cn.approved_bookers(db, project_id=1) == [3, 4]

    sql = _compiled(db.execute.await_args.args[0])
    for table in ("project_assignments", "phase_staff_assignments", "subphase_staff_assignments"):
        assert f"{table}.project_id = 1 AND {table}.approval_status = 'approved'" in sql


async def test_approved_bookers_of_subphases_only_is_one_select():
    result = MagicMock()
    result.scalars.return_value.all.return_value = [5]
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    assert await cn.approved_bookers(db, subphase_ids=[12, 13]) == [5]

    sql = _compiled(db.execute.await_args.args[0])
    assert "UNION" not in sql
    assert "subphase_staff_assignments.subphase_id IN (12, 13)" in sql


@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_card_bookings_are_approved_rows_with_their_allocation(entity_type):
    result = MagicMock()
    result.all.return_value = [(3, 60), (4, 100)]
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    assert await cn.card_bookings(db, entity_type, 11) == [(3, 60), (4, 100)]

    sql = _compiled(db.execute.await_args.args[0])
    assert f"{entity_type}_staff_assignments.{entity_type}_id = 11" in sql
    assert "approval_status = 'approved'" in sql
