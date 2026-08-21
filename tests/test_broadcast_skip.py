"""
Guards against double-broadcasting.

The Kanban router calls broadcast_change() itself with rich attribution. If its
path is not in SKIP_PATTERNS, BroadcastMiddleware fires a second, coarse event
for the same write and every client refetches twice.
"""

import pytest

from app.middleware.broadcast import _resolve_entity_type


@pytest.mark.parametrize(
    "path",
    [
        "/api/kanban/cards/phase/1/status",
        "/api/kanban/cards/subphase/9/assignees",
        "/api/kanban/cards/phase/1/comments",
        "/api/kanban/comments/4",
        "/api/kanban/projects/2/comment-counts",
    ],
)
def test_kanban_paths_are_skipped(path):
    """The router broadcasts richly, so the middleware must stay silent."""
    assert _resolve_entity_type(path) is None


@pytest.mark.parametrize(
    "path",
    ["/api/notifications", "/api/notifications/12/read", "/api/notifications/read-all"],
)
def test_notification_paths_are_skipped(path):
    """Reading your own inbox is private; it must not wake the whole tenant."""
    assert _resolve_entity_type(path) is None


def test_existing_entity_paths_still_resolve():
    """The new skip entries must not shadow unrelated routes."""
    assert _resolve_entity_type("/api/notes") == "note"
    assert _resolve_entity_type("/api/vacations/3") == "vacation"
    assert _resolve_entity_type("/api/tags") == "tag"
