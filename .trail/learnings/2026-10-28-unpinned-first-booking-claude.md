---
title: "New phase bookings are unpinned: reactive dialog switch, Kanban plan_placement(link_first=False) filed without the placement marker"
author: Claude
date: 2026-10-28
branch: feat/feedback-2
cost: { minutes: 0, tokens: 0 }
touches:
  - app/services/approvals.py
  - app/routers/kanban.py
  - frontend/src/components/modals/AssignmentModal.tsx
  - tests/support.py
---

## Decided
- **Kanban first booking = the card's own dates, read from the locked card row.** `plan_placement`'s first statement now selects `card.start_date, card.end_date ... FOR UPDATE` (it selected `card.id`); the dates are read only for `link_first=False` with no row of the person (`PlannedBooking.first`). Reading them from the route's earlier `_load_card` would race a card move between the load and the lock.
- **The Kanban first booking is filed WITHOUT `placement: "auto"`.** `approve` re-plans every marked create with the default `link_first=True`; with no approved row left that returns linked (None/None) and would silently re-pin the request. Unmarked, approve applies the filed dates and re-checks overlap (`find_duplicate`), exactly like the dialog's dated first booking. A real placement (second booking) keeps the marker. Considered and dropped: deriving `link_first` at approve from the filed dates — it breaks `test_approve_auto_placed_create_relinks_when_the_other_rows_are_gone` (a gap-placed second booking whose sibling vanished should still relink).
- **Dialog switch default is reactive until touched**: `followCardChoice: boolean | null` (`null` on a new booking), `followCard = followCardChoice ?? secondBooking`. An effect keeps an untouched new booking's prefilled dates inside the card if a colleague moves it while the dialog is open (the server refuses own dates outside the card).
- Out of scope, unchanged: the resource drop onto a phase bar (`ResourceDropOverlay`) still sends no dates → linked first booking.

## Watch out
- `ApprovalFakeDB.key` (tests/support.py) now tells the card lock from the placement query by **column count** (2 card columns vs card dates + the assignment model), not by `name == "id"`. `card_lock_result()` answers `.first()` with `CARD_START` / `CARD_END` by default; pass dates to test a moved card.
