"""
Tests for the Kanban status <-> completion synchronisation rules.

This matrix is mirrored byte-for-byte by the frontend test
frontend/src/utils/__tests__/cardStatusMirror.test.ts. The two matrices being
identical IS the contract between the optimistic client mirror and the server.
"""

import pytest

from app.services.card_status import (
    CARD_STATUSES,
    apply_completion,
    apply_status,
    completion_for_status,
    status_for_completion,
)


class FakeCard:
    """Stand-in for ProjectPhase / ProjectSubphase (both satisfy CardItem)."""

    def __init__(self, status: str = "todo", completion: int | None = None):
        self.status = status
        self.completion = completion


# ---------------------------------------------------------
# status_for_completion
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("completion", "current_status", "expected"),
    [
        (None, "todo", "todo"),
        (None, "in_progress", "todo"),
        (0, "todo", "todo"),
        (0, "in_progress", "todo"),
        (1, "todo", "in_progress"),
        (50, "todo", "in_progress"),
        (99, "todo", "in_progress"),
        (100, "todo", "done"),
        (100, "in_progress", "done"),
        # Negative values should never reach the DB (the schema now bounds them),
        # but legacy rows may hold them.
        (-5, "todo", "todo"),
        (150, "todo", "done"),
    ],
)
def test_status_for_completion(completion, current_status, expected):
    assert status_for_completion(completion, current_status) == expected


@pytest.mark.parametrize("completion", [1, 50, 99])
def test_blocked_survives_an_in_progress_completion_edit(completion):
    """Editing the Gantt slider on a blocked card must not silently unblock it."""
    assert status_for_completion(completion, "blocked") == "blocked"


@pytest.mark.parametrize(
    ("completion", "expected"),
    [(0, "todo"), (None, "todo"), (100, "done")],
)
def test_blocked_yields_to_the_terminal_completions(completion, expected):
    """0% and 100% are unambiguous, so they override a blocked status."""
    assert status_for_completion(completion, "blocked") == expected


# ---------------------------------------------------------
# completion_for_status
# ---------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "current", "expected"),
    [
        ("todo", None, 0),
        ("todo", 75, 0),
        ("done", None, 100),
        ("done", 12, 100),
        # in_progress keeps genuine in-flight progress...
        ("in_progress", 1, 1),
        ("in_progress", 42, 42),
        ("in_progress", 99, 99),
        # ...and otherwise starts halfway.
        ("in_progress", None, 50),
        ("in_progress", 0, 50),
        ("in_progress", 100, 50),
    ],
)
def test_completion_for_status(status, current, expected):
    assert completion_for_status(status, current) == expected


@pytest.mark.parametrize("current", [None, 0, 37, 100])
def test_blocked_leaves_completion_untouched(current):
    """A blocked card keeps whatever progress it had made before it stalled."""
    assert completion_for_status("blocked", current) == current


# ---------------------------------------------------------
# apply_* mutators
# ---------------------------------------------------------


def test_apply_status_sets_both_fields():
    card = FakeCard(status="todo", completion=None)
    apply_status(card, "done")
    assert (card.status, card.completion) == ("done", 100)


def test_apply_status_to_blocked_keeps_progress():
    card = FakeCard(status="in_progress", completion=30)
    apply_status(card, "blocked")
    assert (card.status, card.completion) == ("blocked", 30)


def test_apply_completion_sets_both_fields():
    card = FakeCard(status="todo", completion=0)
    apply_completion(card, 60)
    assert (card.status, card.completion) == ("in_progress", 60)


def test_apply_completion_preserves_blocked():
    card = FakeCard(status="blocked", completion=20)
    apply_completion(card, 65)
    assert (card.status, card.completion) == ("blocked", 65)


def test_apply_completion_to_100_unblocks():
    card = FakeCard(status="blocked", completion=20)
    apply_completion(card, 100)
    assert (card.status, card.completion) == ("done", 100)


def test_round_trip_is_stable_for_every_status():
    """Applying a status twice must not drift the completion."""
    for status in CARD_STATUSES:
        card = FakeCard(status="in_progress", completion=42)
        apply_status(card, status)
        first = (card.status, card.completion)
        apply_status(card, status)
        assert (card.status, card.completion) == first
