---
title: "Team filter covers team-limited company events and the tag filter options; an event's teams are shown"
author: Claude
date: 2026-10-21
branch: feat/teams
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/utils/teams.ts
  - frontend/src/hooks/useTeamFilter.ts
  - frontend/src/hooks/useTagFilter.ts
  - frontend/src/components/gantt/GanttContainer.tsx
  - frontend/src/components/views/StaffView/StaffView.tsx
  - frontend/src/components/views/StaffView/StaffTimelineBody.tsx
  - frontend/src/components/views/StaffView/CompanyEventsRow.tsx
  - frontend/src/components/views/CrossSiteView/CrossSiteView.tsx
  - frontend/src/components/views/EquipmentView/EquipmentView.tsx
  - frontend/src/components/views/ArchivedView/ArchivedView.tsx
  - frontend/src/components/modals/KanbanCardModal.tsx
  - frontend/src/components/settings/panels/CompanyEventsPanel.tsx
  - CLAUDE.md
  - CHANGELOG.md
  - docs/user-guide/settings.md
  - docs/user-guide/vacations.md
---

## Decided
- Every read of a team-scoped entity under the current site goes through `useTeamFilter()` (or a hook built on it). The header filter only knew projects, staff rows and equipment, so a company event limited to team B stayed on every timeline and in the Staff view's Company events row under filter A, and the tag filter offered team-B tags.
- Per-site "no team here = whole site" entities — equipment, company events, tags — share one rule, `siteScopedTeamsMatchFilter` in `utils/teams.ts` (`equipmentMatchesTeamFilter` / `eventMatchesTeamFilter` / `tagMatchesTeamFilter`): an entity passes when it has no team at this site, or when one of its teams here is selected. `noTeam` applies only to projects and staff rows; it never lets a team-limited event or tag through.
- Views take events from `useTeamFilteredCompanyEvents()` (`{events, eventDates}`, the unfiltered store values when the filter is null, else the filtered list and a rebuilt date Set). Writes and refetches still go to `appStore.companyEvents`.
- The tag filter narrows its **options** (`siteTags` = site tags passing `tagMatches`) but resolves projects against **every** site tag (`allSiteTags`). Resolving against the narrowed list made a visible project carrying a filtered-out tag count as having no tag of that group, so it matched "(No tag)".
- The Kanban card dialog narrows its unassigned candidates on cards of the current site only.
- Group-by sections (`useGanttGrouping`) and Colour-by (`useGanttColorBy`) are deliberately **not** narrowed: a section exists only when a visible project carries the tag, and hiding the section would misfile that project.
- `VacationModal`'s staff picker is deliberately tenant-wide (admins and superusers book absences for anyone at any site).
- An event's teams are visible: Settings → Company events has a Teams column (chips with the team colour, `title="<Team> · <Site>"`, *Whole site* when none, "N teams" when no id resolves), and the Staff view's Company events row names them after the event name for closures and plain events (`teamLabel`, shared with the Closure badge tooltip).

## Tried and ruled out
- Narrowing `siteTags` and using it for both the dropdown and project evaluation (first cut of task 2): leaks projects into "(No tag)" selections, see above.

## Watch out
- A new view that draws company events from `appStore.companyEvents` directly reintroduces the leak; use `useTeamFilteredCompanyEvents()`.
- `useTeamFilter.ts` imports `buildEventDateSet` through the `@/api` barrel: a test that mocks `@/api` must keep it (spread `importOriginal`).
- The Staff view mounts several `useTeamFilteredCompanyEvents()` instances (view, timeline body, events row); they are memoised per instance, harmless, but a prop would do if it ever shows in profiles.
