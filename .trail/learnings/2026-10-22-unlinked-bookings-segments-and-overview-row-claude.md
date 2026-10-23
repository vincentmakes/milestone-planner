---
title: "Unlinked bookings: own dates on phase/subphase bookings (NULL = linked), one fit rule mirrored server/client, and the per-person overview row"
author: Claude
date: 2026-10-22
branch: feat/unlinked-bookings
cost: { minutes: 0, tokens: 0 }
touches:
  - app/models/assignment.py
  - app/services/tenant_provisioner.py
  - app/services/tenant_manager.py
  - migrations/add_booking_segments.sql
  - app/services/booking_segments.py
  - app/services/approvals.py
  - app/services/project_access.py
  - app/services/change_notifications.py
  - app/routers/assignments.py
  - app/routers/projects.py
  - app/routers/kanban.py
  - app/routers/export.py
  - app/scripts/demo_data.py
  - app/services/demo_seed.py
  - frontend/src/utils/bookingSegments.ts
  - frontend/src/components/gantt/utils/autoCalculation.ts
  - frontend/src/components/gantt/utils/diffProjects.ts
  - frontend/src/components/gantt/utils/rowPositions.ts
  - frontend/src/components/gantt/utils/staffGroups.ts
  - frontend/src/components/gantt/ProjectPanel/AssignmentRow.tsx
  - frontend/src/components/gantt/ProjectPanel/CardStaffRows.tsx
  - frontend/src/components/gantt/ProjectPanel/StaffGroupRow.tsx
  - frontend/src/components/gantt/Timeline/ProjectTimeline.tsx
  - frontend/src/components/gantt/Timeline/SegmentsBar.tsx
  - frontend/src/hooks/useDragAndDrop.ts
  - frontend/src/hooks/useResize.ts
  - frontend/src/components/modals/AssignmentModal.tsx
  - frontend/src/components/modals/KanbanCardModal.tsx
  - frontend/src/stores/viewStore.ts
  - scripts/screenshots/capture.py
---

## Decided
- **Linked ⇔ no own dates.** `phase_staff_assignments` / `subphase_staff_assignments` got `start_date` / `end_date DATE NULL` with CHECK `<table>_segment_dates_check` = both or neither; no separate flag. Unlink writes the card's dates, relink writes explicit `null` on both (`model_fields_set`). New bookings are linked everywhere (Assign me, resource drop, Kanban join send no dates).
- **Responses carry effective dates + `linked`** (own, else the card's; project rows `linked: false`), so the client never recomputes them from the card; `effective_dates()` in `booking_segments.py` also feeds the export's Start / End / Linked columns.
- **One fit rule, mirrored.** `app/services/booking_segments.py` `fit_segments_to_card` ↔ `frontend/src/utils/bookingSegments.ts` `fitSegmentsToCard`, with the same `FIT_CASES` / `OVERLAP_CASES` matrices on both sides: same duration + moved → translate; anything else → clamp, a segment fully outside goes against the nearest edge with its length capped to the card. Overlap is inclusive days (adjacent days are fine).
- **The server fits in the card PUT** (`approvals.fit_card_bookings` in `update_phase` / `update_subphase`, same transaction), including the segment dates stored in the rows' open requests (`requested` / `previous`) — otherwise every pending segment request on a moved card would fail at approve (`INVALID_VALUES` or `overtaken`).
- **The client fits locally only** (`fitCardBookings(card, oldStart, oldEnd)`): no segment PUTs after a card drag/resize, one request per card move. Linked rows also take the card's dates locally so a local move shows at once (What-If included).
- `savePendingUpdates` runs **two waves** (cards first, then assignment rows); undo (`diffProjects`) and the pin still send explicit segment PUTs (incl. `relink`), and they must come after the card's PUT.
- Overlap rule in `approvals.find_duplicate`: at card level a conflict is any row of the person whose effective dates overlap (a linked row spans the card); detail `This person is already booked on this card for overlapping dates`. `_revalidate` re-checks it for creates and for updates whose dates changed.
- Kanban per-person DELETE answers 409 with 2+ rows; the card dialog removes per row through `/phase-staff/{id}` / `/subphase-staff/{id}`. The card shows one avatar per person.
- Overview row: one layout rule in `gantt/utils/staffGroups.ts` (`cardStaffItems`, `staffRowCount`) used by the panel (`CardStaffRows`), the timeline (`CardStaffBars`) and `calculateRowPositions`, so the two panes cannot disagree. `viewStore.collapsedStaffGroups` holds the **collapsed** keys (default expanded), session-only.

## Tried and ruled out
- Resolving a shrink-induced overlap (two segments pushed to the same edge): merging loses one allocation, refusing the card PUT contradicts "shortening a card clamps". The fit result is stored as is; the next edit of either row must resolve it (409 otherwise).
- Pushing `PendingUpdate`s for fitted segments after a card move: redundant with the server's fit, and a 403 (→ reload) for a custom role holding `projects.edit_any` without `assignments.manage_others`.
- Fitting only the mirror's `moveStaffAssignmentsByOffset`: the server fits on every card PUT, parent contractions included, so the client calls the fit at every card date change (drag, resize, `cascadeParentDatesUp`, `cascadePhaseDatesFromChildren`, `localProjectTree` patches).
- A "Leave card" button that loops over one's rows: the per-row ✕ is the single way to remove.

## Watch out
- Change `booking_segments.py` and `bookingSegments.ts` together, with both matrices.
- `_check_segment` (PUT) and the approval overlap check run only when the dates change: a stored overlap survives allocation-only edits.
- An undo across a card move still sends segment PUTs (needs `assignments.manage_others` or the PM bundle).
- Approvers' notification titles keep the dates the request was filed with even after a card move fitted them.
- `GET /staff/{id}/availability` / `assignments` still ignore card bookings (the heatmap is client-side and uses `bookingSpan`).
- Overview-row elements must not carry a `row` class or `data-*-id` (the drag/resize hooks and `DependencyLayer` find rows that way). `viewStore.collapseAll` / `expandAll` clear `collapsedStaffGroups`, but no UI calls them today.
- The seed is skipped on an already-seeded demo volume: a demo seeded before 1.17.0 keeps Charlie's single linked booking on Bioprocess *Analytics* — re-date it via the API (PUT `/phase-staff/{id}` with dates, then POST the second segment) or seed a fresh database before capturing `assignment-overview-row`.
