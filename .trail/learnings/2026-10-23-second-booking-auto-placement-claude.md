---
title: "A dateless second booking on a card is placed server-side (largest gap, else halve the full-span row); one label default per built-in field; header dropdowns portaled"
author: Claude
date: 2026-10-23
branch: feat/project-fields
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/booking_segments.py
  - app/services/approvals.py
  - app/routers/assignments.py
  - app/routers/kanban.py
  - app/schemas/kanban.py
  - frontend/src/components/gantt/ContextMenuContainer.tsx
  - frontend/src/components/modals/KanbanCardModal.tsx
  - frontend/src/utils/instanceSettings.ts
  - frontend/src/components/common/MultiSelectDropdown/MultiSelectDropdown.tsx
  - frontend/src/components/common/AnchoredPanel/AnchoredPanel.tsx
  - frontend/src/hooks/useDismissableOverlay.ts
---

## Decided
- **Placement is server-only.** `booking_segments.place_booking(card_start, card_end, spans)`: the largest free stretch (ties → earliest); no free day and exactly one span covering the card (≥ 2 days) → split, the existing row keeps the first half (`(days + 1) // 2`), the new one the second; else `None` → 409 `CARD_FULL_DETAIL`. No client mirror on purpose: creates are blocked in What-If and every create path reloads after the POST (the response's `adjusted` is not read by the client).
- `approvals.plan_placement` (one query, rows `FOR UPDATE`, never raises) → `PlannedBooking` or a refusal; `require_placement` maps `card_full` → `CARD_FULL_DETAIL`, `pending_row` (the full-span row is pending) → `ALREADY_PENDING_DETAIL`. `apply_shrink` shortens the row on the direct path (`expire_overtaken`, update intents, an `update` change), staged before the route's single commit.
- **Marker** `placement: "auto"` in `requested` for every dateless create; explicit dates never carry it. In approval mode the request carries the planned dates and the full-span row is left alone; `approve` re-plans with `approved_only=True` and applies the split / gap (or linked when the other rows are gone), rewriting `requested` to the landed dates, marker kept.
- Built-in field labels: `builtInFieldLabel(settings, key)` has no fallback parameter; one default per field (`BUILT_IN_FIELD_DEFAULTS`, the short names of Settings).
- Multi-select fields use `MultiSelectDropdown` (a listbox, not a portal — it lives inside the Modal). Gantt header / column / overview-filter panels use `AnchoredPanel` (portal to `<body>`, fixed, flips above) with `useDismissableOverlay({..., panelRef})`.

## Tried and ruled out
- A client mirror of `place_booking` "for symmetry": nothing would read it.
- Splitting the full-span row at submit time in approval mode: it would rewrite an approved booking before anyone approved anything.
- `AWAITS_APPROVAL_DETAIL` for a pending full-span row: it tells the requester to approve their own request; `ALREADY_PENDING_DETAIL` reads right for everyone.
- `AnchoredPanel` inside a `Modal`: the dialog's capture-phase Tab trap pulls focus out of the portal.

## Watch out
- While a split request is pending, the planned half overlaps the untouched full-span row: moving that row across it answers 409 `ALREADY_PENDING_DETAIL`, a further dateless create `CARD_FULL_DETAIL`.
- `requested` carries the `placement` key (approval lists, the export's raw column); readers must read fields one by one.
- `approve` must **extend** `effects.notifications` / `change_intents` / `assignment_changes`, never assign them, or the shrink's rows and intents are lost.
- Two simultaneous *first* dateless bookings of one person can both land linked (only existing rows can be locked) — the pre-existing race.
- A portaled header panel aligns with its trigger and may cover the sidebar or the overview; it sits under the app header (`--z-header` > `--z-dropdown`) if a flip ever reaches that high.
