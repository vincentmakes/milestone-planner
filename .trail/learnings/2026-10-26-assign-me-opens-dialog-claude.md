---
title: "The Gantt menu's \"Assign me…\" / \"Request to assign me…\" open the prefilled assignment dialog instead of booking in one click"
author: Claude
date: 2026-10-26
branch: feat/teams
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/gantt/ContextMenuContainer.tsx
  - frontend/src/components/modals/AssignmentModal.tsx
---

## Decided
- **All four items open the dialog** (`openModal('staffAssignment', {…same context as "Assign Staff" at that level, staffId: me})`): the one-click path never reached the round-9 comment / message-for-the-approver field. No backend or store change: the self-only dialog already presets "You", the allocation from the person's max capacity (same lookup as the old one-click), the project's dates (or today) on a project, and *Follow the phase dates* (no dates sent) on a phase / subphase. **Untouched, it sends the old one-click body** (plus `phase_id` on a subphase, as "Assign Staff" always did; routing is by `subphase_id`).
- **"Again"** stays a dateless create the server places (`booking_segments.place_booking`); the dialog now says so when the picked person already has a row on the card (pending ones count) — "You are / This person is already booked on this phase. The new booking is placed automatically…". Switch off → both card dates sent, and the 400 / 409 shows in the dialog, which stays open (was a flash).
- Labels gain the dialog ellipsis (**Assign me…**, **Assign me again…**, **Request to assign me…**, **Request to assign me again…**); the dialog's own submit stays **Assign me** / **Request to assign me**, also on "again".
- `modalContext.staffId` is honoured in the **editor** branch too (that person at their capacity, the user's own record when it is them): the menu hides the items for `projects.edit_any` / PM, but the dialog's editor test is `assignments.manage_others`, so a custom role holding only the latter opens the full picker.

## Watch out
- The dialog snaps the preset allocation to 5 % steps (a 33 % capacity shows 35 %) — the old one-click sent the raw capacity.
- Kanban **Join this card / Request to join** is still one-click (no dialog, so no message).
- Tests rendering the menu with the dialog must mock both `@/api` (the menu) and `@/api/endpoints/projects` (the dialog), plus `@/api/endpoints/kanban` for the mention candidates.
