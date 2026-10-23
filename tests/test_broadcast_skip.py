"""
Guards against double-broadcasting.

The Kanban router calls broadcast_change() itself with rich attribution. If its
path is not in SKIP_PATTERNS, BroadcastMiddleware fires a second, coarse event
for the same write and every client refetches twice.
"""

import pytest

from app.middleware.broadcast import SKIP_PATTERNS, _resolve_entity_type


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


@pytest.mark.parametrize(
    ("path", "entity"),
    [
        ("/api/absence-types", "absence_type"),
        ("/api/absence-types/reorder", "absence_type"),
        ("/api/absence-types/3", "absence_type"),
        ("/api/events", "company_event"),
        ("/api/events/7", "company_event"),
        ("/api/events/import", "company_event"),
        ("/api/sites/2/events", "company_event"),
        ("/api/sites/2/events/7", "company_event"),
        ("/api/sites/2/holidays/9", "bank_holiday"),
        ("/api/sites/2/holidays/import", "bank_holiday"),
        ("/api/vacations/import", "vacation"),
        ("/api/project-fields", "project_field"),
        ("/api/project-fields/reorder", "project_field"),
        ("/api/project-fields/4", "project_field"),
        ("/api/project-fields/4/options", "project_field"),
        ("/api/project-fields/options/9", "project_field"),
        ("/api/tags/reorder", "tag"),
        ("/api/teams", "team"),
        ("/api/teams/3", "team"),
    ],
)
def test_calendar_paths_broadcast_their_entity(path, entity):
    """Calendar writes have no rich broadcast, so the middleware must cover them."""
    assert _resolve_entity_type(path) == entity


def test_tag_groups_no_longer_broadcast():
    """/api/tag-groups was removed in 2.0.0 (tag groups became project fields)."""
    assert _resolve_entity_type("/api/tag-groups") is None
    assert _resolve_entity_type("/api/tag-groups/4") is None


def test_project_fields_are_not_mistaken_for_projects():
    """/api/projects is skipped (rich broadcasts); /api/project-fields is not."""
    assert _resolve_entity_type("/api/projects/3") is None
    assert _resolve_entity_type("/api/project-fields/3") == "project_field"


def test_events_pattern_does_not_shadow_sites():
    assert _resolve_entity_type("/api/sites/2") == "site"
    assert _resolve_entity_type("/api/eventsfoo") is None


@pytest.mark.parametrize(
    ("path", "entity"),
    [
        ("/api/roles", "role"),
        ("/api/roles/4", "role"),
        ("/api/approval-policies/assignments.self_create", "approval_policy"),
    ],
)
def test_rbac_configuration_paths_broadcast_their_entity(path, entity):
    """Role and policy edits change every holder's rights: clients refetch."""
    assert _resolve_entity_type(path) == entity


@pytest.mark.parametrize(
    "path",
    [
        "/api/approval-requests",
        "/api/approval-requests/3/approve",
    ],
)
def test_approval_paths_are_skipped(path):
    """Approval decisions broadcast richly from their router."""
    assert _resolve_entity_type(path) is None
    # Skipped on purpose, not merely unmatched: a later catch-all must not reach them.
    assert any(pattern.match(path) for pattern in SKIP_PATTERNS)


def test_rbac_patterns_do_not_shadow_neighbours():
    assert _resolve_entity_type("/api/rolesx") is None


def test_no_todos_pattern_is_left():
    # Personal todos were removed in 2.0.0: no skip pattern names them.
    assert not any("todos" in pattern.pattern for pattern in SKIP_PATTERNS)
