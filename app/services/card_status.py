"""
Kanban card status <-> completion synchronisation.

The Kanban board and the Gantt chart render the same records. A card's column
is `status`; the Gantt shows `completion`. The two must never disagree, so every
write to either field goes through this module - there is no other place in the
backend allowed to assign `status` or `completion` on a phase/subphase.

Call sites:
  - app/routers/projects.py  update_phase / update_subphase  (completion edits)
  - app/routers/kanban.py    move endpoint                   (status edits)
"""

from typing import Literal, Protocol

CardStatus = Literal["todo", "in_progress", "blocked", "done"]

CARD_STATUSES: tuple[CardStatus, ...] = ("todo", "in_progress", "blocked", "done")

STATUS_LABELS: dict[str, str] = {
    "todo": "To Do",
    "in_progress": "In Progress",
    "blocked": "Blocked",
    "done": "Done",
}

# Completion assigned when a card enters In Progress with no meaningful
# progress recorded yet (i.e. it was sitting at 0/None/100).
DEFAULT_IN_PROGRESS_COMPLETION = 50


class CardItem(Protocol):
    """Structural type covering both ProjectPhase and ProjectSubphase."""

    status: str
    completion: int | None


def status_for_completion(completion: int | None, current_status: str | None) -> CardStatus:
    """Derive the Kanban status implied by a completion percentage.

    `blocked` is preserved for in-progress percentages: being blocked is a
    statement about *why* work is stalled, which a percentage cannot express,
    so editing the slider on a blocked card must not silently unblock it.
    """
    if completion is None or completion <= 0:
        return "todo"
    if completion >= 100:
        return "done"
    return "blocked" if current_status == "blocked" else "in_progress"


def completion_for_status(status: CardStatus, current_completion: int | None) -> int | None:
    """Derive the completion percentage implied by a Kanban status.

    `blocked` deliberately leaves completion untouched - a blocked card keeps
    whatever progress it had made before it stalled.
    """
    if status == "todo":
        return 0
    if status == "done":
        return 100
    if status == "in_progress":
        # Keep genuine in-flight progress; otherwise start halfway.
        if current_completion is not None and 1 <= current_completion <= 99:
            return current_completion
        return DEFAULT_IN_PROGRESS_COMPLETION
    return current_completion


def apply_status(item: CardItem, status: CardStatus) -> None:
    """Set a card's status and bring its completion into line."""
    item.completion = completion_for_status(status, item.completion)
    item.status = status


def apply_completion(item: CardItem, completion: int | None) -> None:
    """Set a card's completion and bring its status into line."""
    # Derive from the *previous* status so `blocked` can be preserved.
    item.status = status_for_completion(completion, item.status)
    item.completion = completion
