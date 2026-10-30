# Changelog

All notable changes to Milestone Planner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-10-30

### Changed
- Text and icons are one step larger across the app, the title bars of the timeline views included; the rows and charts of the Gantt, Staff Overview, Equipment, Cross-site and Archived timelines keep their compact size.
- Form fields read at the body size in every dialog and panel; number fields show their figures in a medium weight with aligned digits.
- Deleting a dependency from the arrow popup no longer asks for confirmation.

### Fixed
- The dependency popup could cover the confirmation it opened, so Delete seemed to need two presses.
- Excel export keeps a number field's and Volume's format (12.0 no longer becomes 12).

## [2.1.0] - 2026-10-28

### Added

- Notifications can be deleted: the × beside each one in the bell removes it (or dismisses a due-soon reminder), and **Clear all** empties your inbox after a confirmation, for you only; a notification you have read now disappears by itself 30 days later, while unread ones stay until you read them
- Number project fields can keep a set number of decimals: give each number field a Format (1, 1.0, 1.00, 1.000, or As typed) in Settings → Project fields, with a preview of how 12.345 is saved; new values are rounded half up when saved, values entered before are shown (and exported) rounded but never changed, and the site export lists each field's decimals
- Administrators can hide the completion badges (40%) of the Gantt rows for everyone with **Show completion badges in the Gantt** in Settings → Features & defaults; the bars stay filled, and a phase's or subphase's progress can still be set from its right-click menu with the new **Set progress…**
- Sites can be deleted from Settings → Sites: the bin on a site's row asks you to type the site's name and says what goes with it; the last active site cannot be deleted, and everyone signed in moves off a deleted site straight away
- The built-in Volume field has a Format too (one decimal by default), set in Settings → Project fields

### Changed

- The company event form says who a closure affects: once teams are ticked, the switch reads "Site closure — staff of the selected teams on these sites are unavailable", with a note that everyone else on the sites is unaffected, and the Closure badge in the list says the same
- In every list of people or equipment with a search box, Tab now picks the highlighted match once you have typed, then moves on to the next field
- A new phase or subphase starts with empty dates, so the calendar opens on the current month, and Add asks for the dates (a milestone needs only its date) instead of silently using the parent's range
- The Cross-Site view shows the real project names and customers of every site you can see, not only of your current site
- The Cross-Site entry no longer appears in the sidebar when you can see only one site, instead of being shown disabled
- A new booking on a phase or subphase — from Assign Staff, Assign me…, Join this card or a Kanban assignee — now starts unpinned with the phase's dates as its own, so it is clipped, never stretched, when the phase changes; pin it (or turn on Follow the phase dates) to make it follow the phase. Picking someone already on the phase still places their second booking automatically; a person dropped from the panel onto a phase still follows the phase
- A number field with a format no longer accepts more decimals than it keeps while you type

### Removed

- The "Confidential Project" masking of other sites' projects in the Cross-Site view (and the "[External Project]" rows of the project list API); sites you cannot see still stay out of the view entirely, so site visibility keeps protecting them

### Fixed

- Volume lost its decimals when saved (12.7 became 12)

## [2.0.0] - 2026-10-23

### Added
- **Project fields**: administrators add their own fields to projects in Settings → Project fields — a dropdown with one or several choices, whose coloured items can be reordered and limited to some sites and teams, a text, a number or a switch — and everyone who edits a project fills them in the project dialog.
- The built-in Customer, Sales PM and Volume fields can be renamed and hidden for the whole instance in Settings → Project fields; Confirmed can be renamed. A custom name replaces the default one everywhere the field is named, and the defaults are the same short names everywhere (Customer, Sales PM, Volume, Confirmed).
- The site Excel export has **Project fields**, **Project field options** and **Project field values** sheets.
- **My Work** replaces My Todos, with three tabs: **My Approvals** (the booking requests you may decide), **My Assignments** (your bookings across projects, current and upcoming by default or all, each with an **Open** button that shows the booking in its dialog) and **My Requests** (your own requests). The sidebar badge counts the requests waiting for your decision.
- **Comments on bookings**: the dialog of a staff booking has a **Comments** section with @-mentions. A booking on a phase or subphase shares the comment thread of its Kanban card; project-level bookings have their own project thread. The site Excel export's **Card comments** sheet also lists the project threads.
- Every people picker (project manager, booking, Kanban assignee, absence, team members) has a search box that opens focused and filters as you type.
- Settings → SSO: a Test configuration button checks the entered Microsoft Entra values (directory, client ID, secret, redirect URI) before they are saved.
- Assigning staff or equipment, or requesting an assignment, can include an optional comment. On a staff booking it is added to the booking's comment thread (for people who may comment); with a request it reaches the approver and is added to the thread once approved, if the requester may comment; on an equipment booking it is kept as a note, also in the site Excel export's **Equipment assignments** sheet. The right-click **Assign me…** and **Request to assign me…** entries now open that dialog, with you and your capacity preset, so the comment or message can be added and the allocation changed.

### Changed
- Tag groups became dropdown project fields: existing groups are converted automatically on upgrade (a single-select group becomes a dropdown, any other group a multi-select dropdown); their tags become the field's items with the same colours, order and site and team limits, and projects keep what they had selected.
- The Gantt and Kanban **Filter** (formerly **Tags**) lists the dropdown fields and the tags; **Colour by** offers the dropdown fields and Tags, **Group by** the dropdown fields.
- A Gantt filter, grouping or colour choice saved before 2.0.0 is reset once, because the saved choices changed shape.
- Settings → Tags lists tags only.
- Booking a person a second time on a phase or subphase now places the new booking automatically: a booking that covered the whole phase is split in half (it keeps the first half, the new one gets the second), otherwise the new booking takes the largest free stretch; it is refused only when their bookings already cover the whole phase. When the booking needs approval, the split or the free stretch is applied when the request is approved.
- The Gantt context menu offers **Assign me again…** on a phase or subphase you are already booked on, and the Kanban card dialog lets an editor book someone already on the card a second time.
- The Gantt header dropdowns (Filter, Group by, Colour by and the column menus) and the Staff and Equipment overview filters are no longer cut off by an open overview panel or the bottom of the window: they open above their button when there is more room there.
- The default skills and equipment types of Settings → Features & defaults apply only to the Staff and Equipment panels below the Gantt chart; the standalone Staff and Equipment views open unfiltered.
- Of My Todos' tabs, **To decide** is now **My Approvals** and **My requests** is **My Requests**; **My tasks** gives way to **My Assignments**.
- Reading a comment thread no longer needs the Kanban board: anyone who can see the project can read it (posting still needs the comment permission), so the booking dialog's thread works while the board is turned off.
- The booking dialog opens read-only, with the reason, for a booking you cannot change: someone else's booking awaiting approval, or your own while your change request on it is open. The Gantt context menu's **Edit Assignment** follows the same rule.
- Saving a change to live SSO sign-in settings now asks for a typed confirmation and explains who would be affected.

### Removed
- Tag groups: the `/api/tag-groups` routes, the `tags.group_id` column and the `tag_groups` table are removed once the groups are converted.
- Personal tasks: My Todos' tasks, the task dialog, the `/api/todos` routes, the `todos.manage_own` and `todos.assign_others` permissions and the task notifications.

### Fixed
- A newly posted comment no longer shows *(edited)*.
- The project manager can be cleared again from the project dialog.
- Booking equipment from a phase or subphase row now works (it used to fail with a not-found error).

### Security
- Updated `vite` to 7.3.7 to close GHSA-587h-7wmj-h5pm, GHSA-r825-w8mm-5pxw, GHSA-698v-4r3x-3vcv, GHSA-rq7h-c2jc-7f22 and GHSA-9jrq-w75r-8gcw (development server only; the shipped application was not affected).
- Updated `vitest` and `@vitest/coverage-v8` to 4.1.12 to close GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp in `@vitest/mocker` (test tooling only).
- The single sign-on log lines no longer carry a digest of the client secret, only whether one is set.
- A single sign-on redirect can only lead to a page of the application itself, whatever the configured redirect URI or the tenant name in the sign-in state.

## [1.17.0] - 2026-10-22

### Added
- A booking on a phase or subphase can be **unlinked** — click the pin on its row in the Gantt chart, or turn off **Follow the phase dates** in the assignment dialog — to give it its own dates inside the phase; an unlinked booking can be dragged and resized on the timeline within the phase, and clicking the pin again makes it follow the phase dates.
- A person can be booked several times on the same phase or subphase (for example a few days at the start and a few days at the end), as long as the bookings do not overlap.
- A person with several bookings on a phase or subphase gets an overview row in the Gantt chart that groups them; it can be collapsed to one line that shows the bookings as blocks.

### Changed
- Moving a phase or subphase moves its unlinked bookings with it, and shortening it fits them inside its new dates.
- Booking a person on a phase or subphase for dates that overlap one of their bookings there is refused.
- The Kanban card dialog removes bookings one by one, and a card shows each person once however many bookings they have on it.
- The site Excel export's Phase assignments and Subphase assignments sheets have **Start**, **End** and **Linked** columns.
- Known limit: shortening a phase past two bookings of the same person can leave them overlapping until one of them is edited.
- The pin and the phase name on a booking row in the Gantt chart are separate controls: the pin links or unlinks the booking (filled when it follows the phase dates, outlined when it has its own), and clicking the name scrolls the timeline to the booking — on an overview row, to the person's first booking.
- Every icon in the app is now a Material icon, one consistent set in the light and dark themes; the Equipment view has a wrench in the sidebar instead of a cog.
- A person's bookings on a phase are listed in date order, and an unlinked booking's pin is greyed out, with the reason, while another of their bookings on that phase would overlap the phase dates.

### Fixed
- The message shown when a drag on the Gantt chart is refused is readable in the dark theme.

## [1.16.0] - 2026-10-22

### Added
- A **Bookable as a resource** switch on each user in Settings → Users, so administrators (and anyone else) can be booked on projects: administrators are not bookable by default, everyone else is, and the user list marks the people who are not bookable.

### Changed
- Who appears in the Staff view and the Staff panel no longer depends on the role: everyone bookable is listed, nobody else.
- A person marked not bookable keeps their existing bookings but cannot receive new ones — booking them is refused with a message, their own "Assign me" and "Join" entries are hidden, and their pending requests to join something can no longer be approved (requests to change or remove an existing booking still can).
- The site Excel export's Users sheet has a **Bookable** column.

## [1.15.0] - 2026-10-22

### Added
- **Settings → Features & defaults**: administrators choose whether the Gantt chart opens with the Staff or the Equipment panel, which skills the Staff panel and which equipment types the Equipment panel show by default (everyone can still close the panel or change the filter), turn the Kanban board off for everyone, turn the automatic bank-holiday import (Nager) off, and choose whether new projects start with the predefined phases selected.
- Notifications when someone else changes your plan: the booked person hears when their booking is added, changed or removed or its phase moves or is deleted, and the project manager hears about bookings, equipment, project details, phases and approvals on their project — never the person who made the change; several changes by the same person on the same project within ten minutes merge into one line.

### Changed
- Instance settings are now validated: a value that does not fit a known setting is refused instead of being saved.
- Clicking a notification about a project opens it on the Gantt chart, switching site if needed, and card notifications do the same while the Kanban board is turned off.

## [1.14.0] - 2026-10-22

### Added
- A two-month calendar picker for every date in the app — projects, phases, subphases, staff and equipment bookings, equipment blocks, absences, bank holidays, company events, milestone dates and todo due dates: click a date field (or press Enter, Space or the down arrow), pick the start, then the end; weekends are greyed and the site's bank holidays and closures are marked with a dot and their name.

### Changed
- An end date can no longer be set before the start: picking a start after the end moves the end along and keeps the duration, and picking an end before the start makes it the new start.
- The optional end date of bank holidays and company events is cleared from the calendar with **Clear end date**; an empty end means the same day.

## [1.13.0] - 2026-10-22

### Added
- Roles and permissions: **Settings → Roles** lists the Administrator, Superuser and User roles and any roles you add, and lets an admin set, permission by permission, what each role may do — 59 permissions in 17 groups, each Allow or Deny, with project-manager rights granted on the projects a person manages.
- Approvals for own bookings: a role can be set to **Needs approval** for booking yourself, changing your own booking or removing it; the request waits as a dashed *Pending approval* row (not counted in capacity) until an approver accepts or rejects it, with an optional reason.
- The **Approvals** tab of Settings → Roles chooses, per action, whether the project's manager approves and which roles do; administrators can always approve.
- Approvers can approve or reject straight from the booking's right-click menu in the Gantt chart or from the Kanban card, and requesters can cancel a request there.
- **My Todos** in the sidebar, with an open-items badge: **To decide** (requests waiting for you), **My tasks** (personal tasks with notes, a due date and an optional project or card, which can be given to colleagues) and **My requests** (your requests and their outcome).
- New notifications when someone asks for your approval, when your request is decided and when someone gives you a task; each opens the matching tab of My Todos.
- Site visibility: people see and work only at the sites they belong to unless their role has **See all sites** (administrators by default); the site selector lists only those sites, and the Cross-site view needs more than one.
- Custom roles can be the default role of new single sign-on accounts.
- The demo tenant ships with a Team Lead role, own bookings that need approval, a pending request and a few tasks.
- The site Excel export shows each booking's approval status and pending change, and has an **Approval requests** sheet.

### Changed
- Superusers now manage projects, bookings, absences and staff notes only at the sites they belong to, like holidays, events and equipment already were.
- Seeing colleagues' absences is a permission (**See colleagues' absences**): with it you see those of the people at your sites, also when you pick a site; without it only your own.
- A change to a role's permissions applies to everyone holding it on their next action, without signing out.
- The API documentation is open to roles with the **API documentation** permission (administrators by default).
- The Users list filters by any role, and the role picker offers only roles whose permissions you hold yourself.
- Superusers can no longer change an administrator's skills; that now needs the permission to edit administrator accounts.
- Upgrading creates the role, approval and todo tables and the default roles automatically on startup; the `add_rbac` migration is also available through `run_migration.py`.

### Fixed
- Moving a project or phase in the Gantt chart no longer sends the phase- and subphase-level staff bookings it carries to the wrong address, which could change an unrelated project-level booking.

## [1.12.0] - 2026-10-21

### Added
- Teams: group the people of a site into teams with a name, description, colour and members, in **Settings → Teams** (admins at every site, superusers at their own sites).
- A **Teams** filter next to the site selector narrows the Gantt chart, Kanban board, archived projects, sidebar stats, resource panels, Staff and Equipment views and pickers to the whole site, one or more teams, or projects and people with no team; it is remembered per site in your browser. Team-limited company events and the tag filter's options follow it too.
- Projects can belong to one or more teams of their site; a new project starts with the teams of the active filter.
- Tags, equipment and company events can be limited to teams, site by site; a team-limited tag is offered only on projects of those teams.
- A site closure limited to teams takes out only their members and leaves the rest of the site, and the calendar header, untouched.
- **Settings → Company events** has a **Teams** column showing the teams each event is limited to (or *Whole site*), and the Staff view's Company events row names them after the event.
- The Users list shows each person's teams.
- The site Excel export has **Teams**, **Team members** and **Project teams** sheets and a **Teams** column on Equipment, Tags and Company events.
- The demo tenant ships with two teams per site, team projects, a team-limited tag, team-limited equipment and a team-limited event.

### Changed
- Upgrading creates the team tables automatically on startup; the `add_teams` migration is also available through `run_migration.py`.

## [1.11.0] - 2026-10-18

### Added
- Admin portal: a **Seed demo data** switch when creating or provisioning a tenant fills the new database with the sample company (two sites, nine people, four projects with bookings, absences, holidays, tags, Kanban comments and notifications) instead of an empty workspace. Only the tenant's admin can sign in, with the generated credentials shown after provisioning; the sample people are staff without a password until an admin sets one.

### Changed
- Provisioning a tenant database from the admin portal opens a small dialog (with the demo-data switch) instead of a plain confirmation; creating a tenant with the switch on provisions it right away and shows the admin credentials.

## [1.10.1] - 2026-10-17

### Fixed
- The Gantt tree panel and the timeline now scroll together without the panel trailing by a frame or stuttering during fast scrolls, in the Gantt and in the Staff, Equipment, Cross-site and Archived views.
- Rows stay aligned at the very bottom of the list: the two panes always reach the same scroll end, whatever the horizontal scrollbar's height.

## [1.10.0] - 2026-10-17

### Changed
- Confirmations (deleting or removing items, discarding unsaved settings, discarding or applying What-If changes, refreshing holidays, admin-portal actions) open in an in-app dialog with a clear Delete or Confirm and Cancel choice instead of the browser's pop-up.
- With one dialog open on top of another, Escape now closes only the dialog on top.
- On/off options in dialogs (project confirmed and archived, milestone, global column, recurring absence, organization SSO settings, show inactive equipment) are switches like the ones in Settings, instead of checkboxes.

### Fixed
- A failed absence deletion in the Staff view now shows the error instead of staying silent.
- On phones, checkboxes in dialogs and filters no longer grow to 44 px squares; they keep their desktop size and the row around them takes the tap.

## [1.9.0] - 2026-10-17

### Changed
- Every text field and dropdown in dialogs, settings, the admin portal and the login pages now uses the same control, with one height, one focus ring and a validation message that screen readers announce.
- Native date pickers follow the light or dark theme instead of always opening dark.
- The documentation screenshots were retaken against the current demo data and interface.

### Fixed
- Seeding the demo tenant on PostgreSQL stopped before the notifications and staff notes; it now completes.
- The multi-user screenshot capture reads the project list in the shape the API returns.

## [1.8.1] - 2026-10-17

### Changed
- The demo tenant (GitHub Codespaces and the screenshot pipeline) now comes from one seed and shows tag groups, nested subphases, dependencies, staff and equipment bookings, maintenance blocks, bank holidays for both sites, a site closure, absences of every type, custom columns, Kanban comments with mentions and notifications; the separate screenshot SQL file is gone.

## [1.8.0] - 2026-10-17

### Changed
- Dialogs keep the keyboard: Tab and Shift+Tab stay inside the open dialog, and closing it puts the focus back on the button that opened it.
- Buttons keep their label while saving and show a spinner instead of changing to "Saving...", and screen readers hear that the button is busy.
- The sign-in buttons on both login screens and the admin portal's "Back to Application" link use the shared button style.
- Form fields announce their validation message to screen readers.

### Fixed
- Pressing Enter twice or double-clicking while a save, import, comment, delete or add was still running could send it twice (General and SSO settings, phase templates, project import, Kanban comments, My absences).
- Keyboard shortcuts no longer fire behind the custom-column dialogs.

## [1.7.0] - 2026-10-17

### Added
- Light phase and subphase colours now get dark text, so labels stay readable on any bar colour.

### Changed
- Errors show where they happen instead of in a browser pop-up: settings panels, the admin portal and the project export dialog display the message in place, and actions without a form of their own (deleting from the right-click menu, a refused dependency link, a card move the server rejected) show a notice at the bottom right that clears itself.
- The on/off settings for a site, a user, equipment, SSO auto-create and the company-event site closure are real switches, like the absence-type settings.
- Every dropdown, filter panel, popover and menu closes the same way: with Escape (which puts the focus back on its button), by clicking outside it, or by tabbing out of it. Escape closes only the innermost one.
- Icon-only row actions (edit, delete, rename, activate, export) have one size and are named for screen readers after the row they act on; the admin-portal dialogs are announced as dialogs with a named close button.
- Presence avatars, activity toasts and Kanban assignees use one shared colour palette, so a person has the same colour everywhere.

### Fixed
- The start and end date fields of the phase, subphase, project, assignment, absence and equipment-block dialogs no longer overlap on iPad.
- Signing in (or signing in again after a session expired) opens the timeline on today, like a page reload does, instead of where the previous session left it.
- The skill colour picker is the same round swatch picker as for tags, absence types and events, so its swatches no longer stretch into ovals on iPad.
- The Today button and the today line work in the Week and Month views on a Saturday or Sunday while weekends are hidden: they go to the next working day instead of doing nothing.

## [1.6.2] - 2026-10-17

### Changed
- The migration runners now default to the same master database name as the application (`milestone_master`); deployments that set `MASTER_DB_NAME` are unaffected.
- The unused `SSO_*` environment variables were removed. SSO is configured in the app (Settings → SSO, or organization SSO in the admin portal); an old `.env` that still sets them is ignored.
- The legacy `upgrade_to_v90.sql` script no longer adds two columns that nothing uses.
- The frontend UI guidelines moved from the documentation site to `UI_GUIDELINES.md` in the repository, refreshed against the current components with every colour token named.

### Fixed
- Delete items in the right-click menu are red again, the absence dialog has its spacing back and the equipment view's badges are coloured: several styles referred to design tokens that were never defined. A test now guards against that.
- A failed Kanban card move recovers through the same reload-and-clear-undo path as every other failed edit.
- The release version check in CI reads the pull request through git, so a very large pull request can no longer slip past it.

## [1.6.1] - 2026-10-17

### Changed
- Milestone Planner is now licensed under the Functional Source License 1.1 with MIT Future License (FSL-1.1-MIT). Self-hosting, internal use and modification stay free of charge; offering it to third parties as a competing product or hosted service is not permitted; each release becomes MIT two years after publication. Releases up to and including 1.6.0 remain under the MIT license.

## [1.6.0] - 2026-10-16

### Added
- **Tag groups.** Tags can be organised into groups such as *Project type* → Internal / Customer. A group can be **single-select**, so a project carries at most one of its tags, and the project dialog switches between them like radio buttons.
- **Tags for one, several or all sites.** Each tag applies everywhere or only at the sites an admin picks; the project dialog and the filter only offer tags that apply to the project's site.
- **Colour projects by a tag group.** A *Colour by* control in the Gantt header colours each project bar with the colour of the project's tag from the chosen group (Default keeps the standard colour). Remembered per site, like the tag filter and Group by.
- **Filter projects by tag.** A **Tags** dropdown in the Gantt chart's project panel and in the Kanban toolbar lists the tags by group: pick any combination (several tags of a group match any of them, several groups narrow down) or "(No tag)" for projects without a tag from a group. The selection is remembered per site, like the custom-column visibility, and the panel shows how many projects are visible.
- **Group the Gantt chart by a tag group.** A **Group by** button in the project panel splits the project list into collapsible sections, one per tag of the chosen group (shown as its coloured pill, with a project count, and as a band across the timeline), plus a last section for projects without a tag of that group. The grouping and the collapsed sections are remembered per site; Collapse all / Expand all act on every section at once.
- **Settings → Tags** (admins): create, rename, recolour, group, reorder and delete tags and groups in one place, with the sites each tag applies to.
- The site export workbook gained a **Tag groups** sheet and **Group**, **All sites** and **Sites** columns on the Tags sheet.

### Changed
- Tags and tag groups are managed by admins in Settings; the project dialog's tag field is now a picker only and no longer creates, renames or deletes tags. Attaching tags to a project still only needs the right to edit the project.
- A tag or group change that would leave a project with two tags of a single-select group, or with a tag that no longer applies to its site, is refused with a message telling the admin how many projects are affected.
- Deleting a site also deletes tags that were limited to that site only.
- The Gantt project panel's header separates the view controls (staff & equipment, tag filter, column visibility) from the actions (manage columns, import, new project) with a divider and more spacing.
- The Gantt project panel's header buttons now sit at the right edge of the whole panel, after the custom columns, instead of at the end of the name column; its dropdowns open towards the chart and never spill off its left edge.
- Settings panels share one button style: every panel's toolbar has the same layout and divider, the Add buttons have the same size and plus icon everywhere, back links look alike, and the admin portal and My absences use the same buttons. Disabled buttons are dimmed the same way throughout the app.
- Test coverage is now measured and enforced in CI (backend and frontend floors plus an 80 % gate on the lines a pull request changes), and the README shows live coverage badges.
- Configuration edits made in Settings (absence types, skills, equipment types, phase templates, users, sites and equipment definitions) now take effect immediately even while What-If mode is on, like tags already did; What-If only sandboxes plan data.
- What-If mode is offered in the Gantt chart only. While a What-If plan is open, the other views, the Settings window and notification links to the Kanban board wait until you apply or discard it; the controls say so, and nothing is lost.
- Equipment and users cannot be deleted while a What-If plan is open, so the plan can never show bookings of something that no longer exists.

### Fixed
- On iPad and other touch devices, tag pills and colour swatches are no longer stretched vertically.
- Reordering custom columns in the manager dialog is saved again (the reorder request was answered with a validation error).
- A phase or phase template added after one at the first position no longer shares its sort position with it.
- A tag created or recoloured while What-If mode is on no longer disappears until the plan is applied.
- Refreshing public holidays no longer deletes a year's holidays when the holiday service could not be reached for that year.
- A multi-day holiday or company event that starts before a requested date range but overlaps it is now returned by the date-range endpoints.
- A custom holiday or company event longer than a year is rejected with a clear message instead of being silently cut at 366 days.
- Timestamps such as comment times and audit entries are no longer shown 1–2 hours early; stored UTC values are sent as UTC.
- A description typed for a new absence is kept when switching to the Import .ics tab and back.
- Large .ics imports are sent in batches, so a calendar export with more than 1 000 entries no longer fails.
- The project tree's expand button is disabled once every level is open, instead of staying active.
- Tapping a Gantt bar on a touch screen works again instead of failing silently.
- Dragging and resizing bars on the Gantt chart now works with a finger on touch screens: phases, subphases, projects and staff/equipment bookings. A swipe that starts on a bar you can edit moves the bar; swipe on empty space to scroll.
- A touch that is cancelled mid-drag (an incoming call, for example) no longer opens the dialog or saves a half-moved bar.
- Colleagues' screens now drop the projects of a deleted site at once, instead of showing them until the next reload.
- The end-date check on the holiday and company-event forms shows the in-app message instead of the browser's own tooltip.
- A WebSocket connection whose browser went away no longer counts as online.

### Security
- A user can no longer read another site's absence by requesting it by id; only their own absences and those of colleagues at their sites are visible.

## [1.5.0] - 2026-10-15

### Added
- **Absence types.** Admins define the kinds of time off used across all sites — Holidays, Home Office, Illness, Business Trip and Training come ready-made — each with a colour and a "counts as unavailable" switch. Every absence is booked with a type. Only types that count as unavailable reduce someone's capacity in the workload views, so a Home Office day is shown on the timeline without taking the person out of the plan.
- **Import `.ics` calendars into bank holidays and company events.** One file can hold many dates, and yearly recurring entries are expanded, so sites that cannot reach the public-holiday service can still be filled from a calendar export. A preview shows what will be imported and flags dates that already exist.
- **Edit bank holidays and company events** after they have been created. An edited public holiday becomes a custom one and is kept when holidays are refreshed from the holiday service, instead of being overwritten or duplicated.
- **Company events can apply to several sites** at once, so an audit or shutdown is entered once instead of once per site.
- **My absences** in the user menu: everyone can list, add, edit and delete their own absences and import them from an `.ics` file, with the type prefilled from Outlook's "working elsewhere" status or a matching category.
- The site export workbook gained an **Absence types** sheet, a **Type** column on the Vacations sheet and a **Sites** column on the Company events sheet.
- **Equipment can belong to several sites**, the same way staff can. A shared instrument is entered once, appears in every site it is linked to, and can be booked by projects on any of them.
- **Project managers can edit their own projects.** The person set as project manager may change the project's details, phases, subphases, assignments, equipment bookings and Kanban cards even with the User role; deleting the project still needs a superuser.
- **Add yourself to a project.** Anyone can assign themselves to a project, phase or subphase ("Assign me" in the right-click menu, "Join this card" on the Kanban board), change or remove their own allocation, and leave again. Assigning other people is unchanged.
- **Company events can close a site.** Tick "Site closure" on an event and everyone on the event's sites is unavailable for its dates: the Staff workload view shows 0% with the event's name, and assignments on those days are flagged.
- The site export workbook now has a **Sites** column on the Equipment sheet and a **Staff unavailable** column on the Company events sheet.

### Changed
- All administration now lives in a single **Settings** window, grouped into General, Sites & calendar, People, Resources, Projects and Integrations. The sidebar's admin section is reduced to one Settings entry, and each person only sees the sections their role can change — superusers no longer see settings they are not allowed to save.
- Bank holidays and company events have their own sections in Settings, with a site picker, year filter, add, edit, delete, import and export.
- Public holidays fetched from the holiday service can now be deleted; they return on the next refresh.
- Changes to bank holidays and company events now appear for other signed-in users straight away, without reloading the page.
- The server refuses to start in production when `SESSION_SECRET` is empty or one of the published example values; the self-contained compose file now reads it from `.env`.
- New and changed passwords must be at least 8 characters, in the workspace and in the admin portal. Existing passwords keep working.
- Staff allocations must be between 1 and 100 % everywhere, including Kanban assignees; 0 is no longer accepted.
- Deleting a site now consistently deletes its projects, whichever path deletes it.
- Deleting a user keeps their Kanban comments, shown as written by "Deleted user".
- Plain users can edit custom-column values; column definitions stay admin-only.
- A superuser can rename or delete an equipment type only when every piece of equipment of that type is at one of their sites.
- Plain users see the absences of colleagues who share a site with them, not of everyone in the workspace.
- Sites scope what the interface shows, not what a superuser may edit: superusers act across the whole workspace, as before. The documentation now says so.
- Equipment types no longer offer "Add type" (types are created through equipment); Delete now really deletes a type, or explains that it is still in use.
- Calendar (`.ics`) imports are limited to 5 MB.
- Adding absences and equipment blocks is unavailable in What-If mode, like other creates.
- A failed What-If Apply shows a banner in the header with Retry, Discard and Dismiss instead of a one-off alert; changes made while Apply was reloading are kept.
- An "Offline" badge appears in the header while live updates are disconnected, and live sync reconnects by itself when the network returns or the tab becomes visible again.
- The WebSocket diagnostic endpoints are admin-only, and admin-portal roles and workspace status values are validated.
- Behind a reverse proxy, set `FORWARDED_ALLOW_IPS` to the proxy's address so sign-in limits apply per visitor instead of to everyone at once; a public IP address is also limited to 100 failed sign-ins per 15 minutes across all accounts.

### Fixed
- Superusers can edit users' details, sites and skills again. Every save was rejected because the form always sent the role and active status, which only admins may change; superusers now see those fields read-only, and the actions reserved for admins (adding, deactivating and deleting users) are no longer offered to them.
- Today's availability in the Staff view and on resource cards now respects recurring absences (for example "every Wednesday"). The whole date range of a recurring absence was previously treated as time off.
- Deleting a phase, subphase, project or assignment from the right-click menu no longer switches the Gantt chart to a different site. It could jump back to the site that was open when the page was loaded.
- Reordering predefined phases now saves. Every reorder was previously rejected and the list quietly snapped back to its old order.
- Projects in the Gantt chart and on the Kanban board keep a stable order. Projects with the same start date could swap places on every refresh, projects added after a custom order was set drifted as their dates changed, and dragging a project downward or below the last row put it in the wrong place.
- Sites with more than 50 projects (archived ones included) now load all of them; the rest were previously left out.
- The timeline now opens centred on today in every view, instead of on a date months in the past (for example, the previous year).
- Deleting a site no longer deletes equipment that is also linked to other sites; it is only removed from the deleted site.
- The equipment list no longer stops at 50 items.
- Dates no longer shift by one day for people whose computer is set to a timezone west of UTC. Dragging, resizing or linking a bar from the Americas used to store the phase, its parent and the project one day early, and phase rows and CSV exports showed dates a day off.
- Undo after discarding or applying a What-If plan no longer writes the discarded changes to the server; the undo history is cleared when What-If starts and ends.
- What-If plans are no longer wiped from the screen by a colleague's change or by creating something inside the sandbox, and a failed Apply now stops, shows the error and reloads instead of silently dropping the rest of the plan.
- A drag or resize is no longer abandoned mid-gesture when a colleague's change arrives or the chart is zoomed.
- Custom-column values and definitions now update live for other users.
- Deleting a phase now also removes its subphases and their assignments, comments and custom-column values instead of leaving them behind.
- Importing an MS Project or CSV file now puts finished tasks in the Kanban "Done" column and keeps completion between 0 and 100.
- Single-site installations that auto-initialise the database on start now get every schema update applied in place when upgrading from a version before 1.4.
- Project managers and superusers no longer see custom-column, absence or archived-project editors that the server would reject; superusers can again save edits to users who belong to sites they do not manage.
- Typed input in the phase, subphase and assignment dialogs survives live updates from other users, pressing Escape in a picker closes only the picker, and removing an assignee or a comment on a Kanban card asks for confirmation first.
- The critical path no longer drops the end of a dependency chain when a successor starts before its predecessor finishes.
- Logging out of the admin portal returns to the login screen instead of a blank loading page.
- Choosing "Viewer" as an organisation's default SSO role no longer breaks the first sign-in of new users; the option is gone and the server rejects invalid roles.
- Changing your own password works again (it always failed before).
- An expired or revoked session returns to the login screen instead of leaving every save failing silently, and logging out clears the What-If sandbox, undo history, notifications and custom-column data so nothing carries over to the next person on the same tab.
- Pressing Enter twice or double-clicking no longer creates duplicates in the project, phase, subphase, assignment, absence, equipment-block, holiday, event, skill, equipment, user, site, absence-type, custom-column and admin-portal dialogs, and a second click on a calendar Delete no longer shows a false error.
- The Settings window now asks before discarding unsaved input in Users, Equipment, Sites, Skills, Bank holidays, Company events, Absence types and Equipment types.
- Week numbers follow ISO 8601 (1–3 January 2027 show as week 53), and the current month is highlighted in the timeline header.
- Setting completion with the slider also moves the card's Kanban status for the person who made the change.
- In quarter and year views, dropping a staff member or equipment books five days where the pointer is; in week and month views the preview snaps to whole days.
- Dependency arrows and the critical path no longer attach to the wrong item when a phase and a subphase share an id; cycle checks catch cycles between phases and subphases and no longer block valid shortcut links; "Delete Dependency" works on older links; undo and redo also restore dependency links on the server.
- Dates where the end comes before the start are rejected on projects, phases, subphases, assignments, bookings and absences, and unknown sites, managers, staff, skills or malformed date filters give a clear error instead of a server error.
- Deleting projects or sites no longer leaves custom-column values and comments behind; existing leftovers are cleaned up on the next start.
- Batch custom-column edits are validated like single edits, a failed change that cascades to sub-items is undone, custom-column delete errors are shown and reordering is a single request.
- A site's city, country and region can be cleared, a person on several sites appears once in the absence staff picker, and the company-event import no longer marks an event as existing when it is missing on one of the selected sites.
- An admin can no longer try to change their own role or delete their own account, and in the admin portal, Escape inside an inline edit of the organisation dialog cancels the edit instead of closing the dialog. Logging out of the admin portal no longer sends a workspace session check.
- The project manager is included in CSV and XML exports again, oversized import files are refused, and MS Project parsing no longer blocks other requests.
- The API documentation works under workspace URLs in multi-tenant mode; suspending, archiving, editing or deleting a workspace takes effect immediately instead of up to a minute later; a workspace whose database connection is missing shows "unavailable" instead of possibly reading another database.
- The container stops when database initialisation fails instead of serving a half-initialised schema, and the legacy migration helpers that created a wrong-shaped events table are removed.
- Instance-settings changes and changes to the signed-in user (role, sites, deactivation) sync live; staff-note changes no longer trigger a full reload on every client; Kanban comment counts are no longer re-requested on every live update.
- If loading the workspace after login fails, an error screen with Retry appears; keyboard shortcuts no longer act on the Gantt behind an open dialog; month navigation from the 31st no longer skips a month; a download no longer fails on an unusual file name. Gantt scrolling and dragging re-render less.
- CSV exports of phases or subphases with several predecessors no longer shift the following columns (the Predecessors cell is now quoted).

### Security
- A superuser can no longer change the email address or password of other users, or edit administrator accounts, which previously allowed taking over an admin account.
- Deactivating, deleting or demoting a user now ends their sessions immediately; every request re-checks the live account status and role.
- Resetting a tenant admin's password from the admin portal now stores it hashed; it was stored in plain text until the next login.
- The Entra client secret is no longer written to the application log when SSO settings are saved.
- Passwords longer than 72 bytes are rejected with a clear message instead of crashing the login, and the bcrypt dependency is pinned to the 4.x line. An account whose password was longer than 72 bytes when it was set must have its password reset by an admin, because earlier versions silently kept only the first 72 bytes.
- Spreadsheet and CSV exports escape cell text that starts with a formula character, so a malicious name or comment cannot run as a formula when the file is opened.
- The staff and equipment availability endpoints now validate their dates and cap the range at one year; an unbounded range could exhaust the server.
- Frontend build dependencies were updated so the security audit passes again.
- The workspace-level SSO client secret is now stored encrypted; existing plaintext secrets are encrypted automatically on the next start, the settings screen only ever shows it masked, and saving with the masked value no longer overwrites the real secret on any save route.
- Single sign-on now only completes in the browser that started it and a sign-in link cannot be reused; a sign-in left open for more than 10 minutes has to be restarted.
- After 10 failed sign-in attempts for the same e-mail from the same address within 15 minutes, further attempts are refused for a while, in the workspace and in the admin portal; sign-in takes the same time whether or not the e-mail exists.
- Admin-portal passwords use a much stronger hash, upgraded automatically on the next sign-in, and an admin who must change their password can do nothing else in the portal until they have.
- Health checks and error messages no longer reveal database hosts, users or SQL details.
- Real-time connections opened from other websites are refused, and people who are deactivated, deleted, demoted or have their password reset are disconnected from live updates immediately. When the connection is refused but the session turns out to be valid, live updates reconnect once instead of showing "Offline" for good.
- An unexpected error during single sign-on now returns to the sign-in page with a message and clears the sign-in cookie, instead of a blank server error.
- The admin-portal login no longer keeps the plaintext password in memory after a forced password change.

## [1.4.0] - 2026-09-07

### Added
- A **Kanban board** view showing any project's work as cards across four columns — To Do, In Progress, Blocked and Done. The board and the Gantt chart are two views of the same plan: a card is a phase or subphase with no children, so moving a card updates the Gantt chart and vice versa. Parent phases become swimlanes rather than cards.
- Cards can be dragged between columns, grouped into swimlanes by project, by phase, by assignee or by any list-type custom column, and filtered to just your own work with **My Todo**. Choose a single project or **All projects** to see the whole site at once; projects appear in the same order as the Gantt chart, including any custom order you have set there. When several projects are shown, phase lanes are labelled *Project — Phase* so identically named phases stay apart.
- Assigning someone to a card **books their time**: it creates a staff assignment covering the card's dates at that person's maximum capacity, so the Staff workload view reflects it immediately. The booking follows the card whenever its dates change in the Gantt chart. Assigning the same person twice is now refused instead of silently double-booking them.
- **Comments on cards, with `@` mentions.** Type `@` and pick someone from the list — people already on the card are offered first, followed by everyone else at the card's site, administrators included. A picked mention is highlighted as you type, and editing it removes both the highlight and the notification, so what you see is always what will happen when you post. Only names picked from the list notify anyone; one simply typed out is ordinary text. Any signed-in user can comment; you can edit and delete your own comments, and managers can remove any.
- The percentage each assignee is booked at can be **changed from the card itself**, with the same allocation slider the Gantt chart uses, instead of only at the point of assigning. A booking above that person's own maximum capacity is flagged. Changing an allocation requires superuser rights — being assigned to a card lets you move it, not re-plan it.
- An **in-app notification bell** in the header with an unread count. You are notified when someone assigns you to a card, comments on a card you are on, mentions you, or moves one of your cards to another column. Reminders for cards that are due soon or overdue are worked out in your browser from the plan you already have loaded, so they appear without any extra setup — but they only appear while the application is open, and there is no email or push.
- People who are not project managers can now move the cards they are assigned to, and comment. Creating, deleting, assigning and rescheduling still require superuser rights.
- The site export workbook gained a **Kanban status** column on the Projects sheet and a new **Card comments** sheet.
- The **version this instance is running** now appears at the bottom of the user menu. It is read from the server each time the menu is opened, so an upgrade shows up there without reloading the page.
- Clicking a **phase name** in the Gantt chart's table scrolls the timeline to that phase's start date — the same jump the L1/L2 badges already offer on subphases. Useful for finding work that sits far outside the current view.

### Changed
- Editing a comment now updates who it mentions, notifying anyone newly added without re-notifying people who were already mentioned. Previously an edit changed the text but left the mention list untouched.
- A phase or subphase's completion percentage and its Kanban status are now kept in step. Setting a card to Done marks it 100% complete, To Do resets it to 0%, and editing the percentage in the Gantt chart moves the card to the matching column. Marking a card Blocked leaves its percentage untouched, and editing the percentage of a blocked card does not silently unblock it.
- Completion percentages are now validated to be between 0 and 100. Values outside that range were previously accepted and stored.
- Staff allocations on a phase or subphase are now validated to be between 1 and 100. A single booking is a share of one person's time, so it cannot exceed all of it; overlapping bookings are what add up to over-allocation in the workload heatmap. Zero and negative values were previously accepted and quietly distorted that calculation.

### Fixed
- The top menu bar no longer overlaps itself on narrow screens. Below roughly 1600px it now collapses in stages — labels become icons, then the least-used controls (zoom, undo/redo, the view switcher, the theme and What If toggles) move into a **"⋯" menu** — so everything stays reachable down to tablet-portrait width. Previously the bar simply overflowed, leaving the date navigator sitting underneath the site picker.
- The toolbar's zoom buttons now keep the timeline centred while zooming, matching Ctrl+scroll. They previously zoomed from the left edge.

### Security
- Updated two build-time dependencies flagged by newly published advisories: `browserslist` (unbounded memory growth, and a crash via untrusted custom stats) and `@humanfs/node` (recursive copy following symlinks outside the source tree). Both are used only to build and lint the application, never at runtime, so the shipped application was not affected.

## [1.3.0] - 2026-08-28

### Added
- Administrators can test an organization's Microsoft Entra SSO configuration from the admin portal, which reports each setting Microsoft accepts or rejects without anyone having to attempt a sign-in, along with how the server reaches the internet.

### Fixed
- A failed sign-in with Microsoft now says what actually went wrong — a redirect address registered under the wrong platform, an invalid or expired client secret, missing consent — instead of "Failed to exchange authorization code". The Microsoft error code is shown so an administrator can act on it without reading the server log.
- Single sign-on no longer falls back to a workspace's own settings when the organization's configuration cannot be read. It previously carried on with the wrong settings, and Microsoft then rejected the sign-in with an error pointing at the wrong thing entirely.
- Workspace SSO settings saved without a client secret are no longer offered on the sign-in page: signing in with them could never succeed, and it failed as though the secret were wrong rather than missing.
- Whitespace accidentally saved with an SSO setting — a trailing newline from a copy-paste — is now ignored instead of making Microsoft reject the credentials.
- A sign-in that cannot reach Microsoft at all now returns to the sign-in page saying so, instead of an unexplained server error.
- A failed sign-in now distinguishes a rejection by Microsoft from a reply that did not come from Microsoft — the latter usually meaning a proxy or gateway answered instead — so the two are no longer investigated as the same problem.

## [1.2.2] - 2026-08-28

### Fixed
- Provisioning a tenant from the admin portal now reports the new administrator's actual password. It previously showed a different value, so the new administrator could not sign in and the real password was unrecoverable, leaving the tenant to be repaired with a password reset.

### Security
- Provisioning a tenant no longer returns the PostgreSQL administrator password in the admin portal's response.

## [1.2.1] - 2026-08-28

### Fixed
- A failed sign-in with Microsoft now returns to the workspace's own sign-in page and shows why it failed. Previously, when single sign-on was managed by an organization, every failure silently landed on the admin portal login with no explanation, making a working configuration look broken.
- The workspace SSO settings screen now shows the organization's settings — tenant ID, client ID, redirect URI, auto-create and default role — read-only, with the secret masked, when SSO is managed by an organization. It previously showed an empty, greyed-out form.
- Sign-in no longer rejects everyone when group-based access is required but the group lookup itself fails (usually a missing `GroupMember.Read.All` consent on the app registration). That case is now reported as a configuration problem instead of "you do not have access".
- An organization SSO configuration missing its redirect URI is no longer advertised as ready on the sign-in page, where starting a login would fail.
- A sign-in no longer returns an opaque server error when the organization's stored client secret cannot be decrypted.

## [1.2.0] - 2026-08-28

### Added
- A tenant can now be assigned to an organization at creation time, so it inherits the organization's single sign-on configuration immediately instead of only after a separate edit.

## [1.1.0] - 2026-08-14

### Changed
- Bank-holiday import now uses version 4 of the Nager public-holiday API at its new address, `https://nagerholidays.com/api/v4`. **If your firewall allows only `date.nager.at`, add `nagerholidays.com`** or holiday import will stop working after this upgrade.
- An installation that pins `NAGER_API_URL` to a `/api/v3` URL keeps working — the version is detected automatically and a warning is logged — but version 3 of the holiday API reaches end of life on 31 January 2027.
- Imported holiday names are now in English (for example "Swiss National Day" rather than "Nationalfeiertag"); version 4 of the holiday API no longer publishes local-language names. Existing holidays keep their current names until a site's holidays are refreshed.
- Only public and bank holidays are imported. The holiday API's school, observance, optional and authority entries are ignored, so they no longer count against working days.
- Region filtering now matches subdivision codes exactly, and accepts either form — a site configured with `ZH` or with `CH-ZH` gets the same holidays.
- Changing a site's country now replaces its imported holidays for the current and next year instead of adding to them, so holidays from the previous country no longer linger.

### Fixed
- Refreshing holidays no longer clears a site's existing holidays when the holiday API is unreachable — they are kept until a successful fetch replaces them.
- A single duplicate or malformed holiday returned by the API no longer discards the whole import; it is skipped and the remaining holidays are stored.

## [1.0.21] - 2026-08-10

### Security
- Updated a build-time dependency (`nanoid`) that a newly published advisory flagged as vulnerable. Build tooling only — the shipped application was never affected.

## [1.0.20] - 2026-08-07

### Security
- The MPP import diagnostics endpoints (`/import/test`, `/import/test-upload`) now require a superuser session — previously they were reachable without authentication, including an endpoint that accepted file uploads.
- The browser console no longer logs every API write request in production builds (the diagnostic logging now runs only in development).

### Changed
- The frontend now declares Node.js 24 as its required toolchain (`engines` field), matching the Docker build and CI.
- React hooks-order violations now fail the frontend lint check instead of passing as warnings; the WebSocket hook that carried the only violations was refactored accordingly.
- Deprecated Python `datetime.utcnow()` usage was fully migrated ahead of future Python upgrades. No behaviour change.

### Fixed
- Session expiry timestamps are now recorded as true Unix epochs. They were previously skewed 1–2 hours by the container timezone (self-cancelling in normal operation, but sessions spanning a daylight-saving switch could last up to an hour longer or shorter, and the stored expiry disagreed with the admin-portal sessions). Sessions created before this update will expire up to 2 hours early, once — logging in again is all that's needed.
- The session cookie metadata now records the actual expiry time instead of the session's creation time.

### Removed
- Removed dead code left over from earlier iterations: unused backend exception classes and an unused site-access dependency, and several never-rendered frontend components, hooks and contexts (fill-down editing, touch drag, change-indicator badges, an orphaned theme selector and loading spinner, and duplicated row-position logic).
- Removed the unused `black` and `isort` development dependencies — Ruff handles formatting and import sorting.

### Fixed
- `.env.example` now matches what the application actually reads: the master database is configured via `MASTER_DB_*` variables (the previously documented `MASTER_DATABASE_URL` was ignored), and the proxy and auto-initialization variables are now documented. The ignored `SECRET_KEY` variable was removed from the compose files.

## [1.0.19] - 2026-08-06

### Security
- Updated `cryptography` to 50.0.0, clearing a high-severity advisory about PKCS#7 enveloped-data decryption leaking key information through distinguishable errors and timing. Milestone Planner never used that code path — the library is only used for AES-GCM encryption of stored credentials — so no data was at risk.
- Removed the unused `python-jose`, `authlib` and `itsdangerous` backend dependencies, which no longer ship in the application image.
- Updated the web framework (FastAPI 0.141.1, Starlette 1.4.1, Pydantic 2.13.4), clearing seven Starlette advisories that the previous pins were stuck behind. Two were denial-of-service flaws an unauthenticated visitor could have triggered through form and file uploads; the rest covered request-URL handling. API responses are unchanged.
- Updated the bundled `brace-expansion` and `js-yaml` build-time dependencies to releases without denial-of-service advisories. They are used only when building the app, not at runtime.

### Changed
- Backend CI now audits Python dependencies for known vulnerabilities on every pull request and once a week, matching the existing frontend audit.
- Moved `email-validator` off a yanked release to a properly published version. No behaviour change.

## [1.0.18] - 2026-07-28

### Security
- Removed the unused `react-router-dom` frontend dependency, clearing two React Router advisories (an open-redirect and an SSR hydration flaw) that no longer apply to this app.
- Updated the bundled `js-yaml`, `postcss`, `brace-expansion` and `minimatch` build-time dependencies to versions without known denial-of-service and path-traversal advisories.

## [1.0.17] - 2026-07-18

### Added
- The documentation screenshot pipeline now captures every screenshot in the docs automatically, including the admin portal, all management modals, tags, equipment maintenance blocks, and the read-only tenant SSO form shown when organization SSO applies.
- Fourteen more documentation illustrations: dependency arrows, critical path, context menu, column manager and filters, vacation and equipment booking modals, bank holidays, archived view, dark theme, site editor, staff filter, and the admin portal's create-tenant and organization SSO dialogs.

### Fixed
- Changing the status of a tenant that belongs to an organization no longer fails with an internal server error in the admin portal.
- The screenshot demo-data seed script is now safe to re-run: it no longer duplicates vacations or custom columns.

## [1.0.16] - 2026-07-17

### Changed
- The frontend build and development environments now use Node.js 24 LTS (previously Node 20, which has reached end-of-life). No application behaviour changes.

## [1.0.15] - 2026-07-17

### Added
- The full site export now includes a Staff notes sheet.

### Changed
- Newly provisioned tenants no longer receive unused legacy phase/subphase columns on equipment assignments; equipment bookings are project-level, matching the application.

### Fixed
- Fresh single-tenant installs via `setup_databases.sql` were missing the user work-capacity and system-flag columns, which broke the app on first login; they are now included.
- The master fresh-install script now creates the organizations and organization SSO tables and the tenant organization/group-access columns instead of relying on runtime auto-migration.
- Deleting a site or a project manager on provisioned tenants now detaches their projects and equipment instead of being blocked by the database.
- Other connected users now see a project immediately after an MS Project/CSV import instead of having to reload.
- Importing a project is now blocked while What-If mode is active — it previously bypassed the sandbox and wrote to the server for real.
- The manual tenant schema template was rebuilt to match the actual application schema (it had drifted on a dozen tables: wrong column names, missing columns and constraints).

### Removed
- Unused frontend staff create/update/delete functions that targeted endpoints that never existed.

## [1.0.14] - 2026-07-16

### Fixed
- The manual tenant schema template now includes the equipment blocks, tags and project tags tables it was missing.
- The staff notes table is now created consistently as `staff_notes` on every install path; databases from older installs are migrated automatically (legacy `notes` rows are carried over and the old table removed).
- Assignment endpoints are now correctly listed in the broadcast middleware's skip list, replacing a stale entry for a route that never existed.

### Removed
- Dead HTTP presence endpoints and unused presence polling code; presence has always worked over the WebSocket connection.

## [1.0.13] - 2026-07-16

### Fixed
- Admin portal dialogs no longer close when clicking outside them, which could discard in-progress input (e.g. when a text selection ended on the backdrop); use the close/cancel buttons or press Escape instead. Escape now closes admin portal dialogs.
- The fresh-install schema (`setup_databases.sql`) now includes the previously missing company events, staff notes, custom columns, skills and project presence tables, matching the schema created for provisioned tenants.

## [1.0.12] - 2026-07-16

### Fixed
- Corrected outdated setup and migration documentation: removed references to a nonexistent Alembic setup and `migrate_all_tenants.py` script, documented the master-database migration runner, and completed the list of available migrations.

## [1.0.11] - 2026-07-16

### Fixed
- Organization-level Microsoft Entra SSO sign-in no longer returns a 500 error on the Microsoft callback in multi-tenant mode: the workspace is now carried through the OAuth flow so the shared organization callback URL completes against the correct tenant database and returns the user to their workspace. A single organization SSO configuration and redirect URI now works for every tenant in the organization.

## [1.0.10] - 2026-07-16

### Added
- Guardrails against redundant SSO setup: when a workspace's organization manages SSO, the tenant-level SSO settings form now explains that organization SSO takes precedence and is shown read-only (and the server rejects enabling tenant-level SSO), and the admin panel warns when adding a tenant whose own SSO would be overridden by organization SSO.

### Fixed
- SSO login button no longer stays hidden (and the SSO login/callback flow no longer fails) for multi-tenant instances: SSO configuration is now resolved correctly from the tenant context set by the tenant middleware, so both organization-level and tenant-level Microsoft Entra SSO work when signing in at a tenant URL.

## [1.0.9] - 2026-07-14

### Fixed
- Tenant provisioning now works on managed PostgreSQL (Azure Database, RDS, Cloud SQL) where the admin role is not a superuser: the provisioning admin is granted each new tenant role before creating its database (previously failed with `must be able to SET ROLE "…"`), and the tenant user is explicitly granted `CREATE`/`USAGE` on its `public` schema (previously failed with `permission denied for schema public` when building tables).

## [1.0.8] - 2026-06-23

### Security
- Updated `cryptography` to 48.0.1, fixing a vulnerable OpenSSL version bundled in the wheels.
- Updated `python-multipart` to 0.0.31, addressing denial-of-service and parameter-smuggling issues in querystring and multipart form parsing.
- Updated `vite` to 7.3.5, fixing a `server.fs.deny` bypass and an NTLM hash-disclosure issue in the bundled dev-server tooling.
- Updated bundled frontend dependencies `form-data` (CRLF injection), `js-yaml` (denial-of-service), `@babel/core` (arbitrary file read), `esbuild` (dev-server file read), `ws` (memory disclosure / denial-of-service), and `brace-expansion` (denial-of-service) to patched versions.

## [1.0.7] - 2026-06-10

### Changed
- Bumped `react-router-dom` from 6.30.3 to 6.30.4 (Dependabot npm group update).

## [1.0.6] - 2026-06-02

### Changed
- Bumped `vitest` from 4.0.18 to 4.1.0 (Dependabot npm group update).

## [1.0.5] - 2026-05-18

### Security
- Bumped `authlib` from 1.6.11 to 1.6.12 (Dependabot pip group update) — fixes redirecting to an unvalidated `redirect_uri` on `InvalidScopeError` in `OpenIDImplicitGrant` and `OpenIDHybridGrant`.

## [1.0.4] - 2026-05-07

### Changed
- Bumped `python-multipart` from 0.0.26 to 0.0.27 (Dependabot pip group update).

## [1.0.3] - 2026-05-07

### Changed
- Bumped `authlib` from 1.6.9 to 1.6.11 and `python-dotenv` from 1.0.1 to 1.2.2 (Dependabot pip group update).

## [1.0.2] - 2026-05-07

### Added
- Reproducible screenshot capture pipeline for the docs (`scripts/screenshots/`): two headless Playwright scripts plus a SQL seed for vacations, bank holidays, and populated custom columns. Run against the `demo` tenant from `app.scripts.seed_demo` to refresh every screenshot referenced by the MkDocs site.

### Changed
- Refreshed and expanded screenshot coverage in the user guide:
  - `gantt-main.png` now shows projects expanded into phases with custom columns populated and the today indicator on a real timeline.
  - New combined-view screenshots (`gantt-with-staff-panel.png`, `gantt-with-equipment-panel.png`) demonstrating the **Panels** dock.
  - New `vacations-view.png` for the previously screenshot-less *Vacations & Time Off* page.
  - New `what-if-active.png` showing the active What-If state with Discard/Exit, replacing `what-if.png`.
  - New collaboration screenshots (`collab-online-users.png`, `collab-presence-viewing.png`, `collab-activity-feed.png`) for the previously text-only *Real-Time Collaboration* page.
  - `custom-columns.png` now shows populated values rather than the empty Manage Columns modal.

## [1.0.1] - 2026-05-06

### Fixed
- Docker image now builds again — added `g++` to the Python builder stage so `psutil` and `jpype1` source builds succeed when no precompiled wheel is available for the target platform.
- `/health` and `/api/health` now report the correct version inside Docker. The `VERSION` file is now copied into the runtime image; previously it was missing and `__version__` fell back to `0.0.0`.

## [1.0.0] - 2026-05-06

`1.0.0` is a stability declaration — it captures the current shipping state of
the application and starts the formal SemVer + CHANGELOG discipline. From here
on, every code-impacting change bumps `VERSION` and lands a CHANGELOG entry in
the same PR.

### Added
- Adopted [Semantic Versioning](https://semver.org/) — single source of truth at `/VERSION`.
- Adopted [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format for `CHANGELOG.md`.
- New `.github/workflows/version-check.yml` CI gate that fails PRs whose `VERSION` bump is missing a matching `## [<version>]` heading in `CHANGELOG.md`.
- Backend now reads its version from `/VERSION` at startup (`app/__init__.py`) — exposed via `/health` and `/api/health`.

### Changed
- Backend `__version__` reconciled from the inconsistent hardcoded `2.0.0` down to the canonical `1.0.0` baseline. Frontend `package.json` version aligned to match (and is now static — only `/VERSION` is bumped going forward).

### Removed
- Stale repo-root documentation files that pre-date or duplicate the MkDocs site at `docs/`:
  - `AUDIT.md` — one-off Feb-2026 audit report whose remediation items have either landed or migrated to GitHub issues.
  - `USER_MANUAL.md` — duplicate of the MkDocs `docs/user-guide/` content; the canonical end-user manual is published at [docs-milestone.verdet.me](https://docs-milestone.verdet.me).
  - `DEVELOPMENT.md` — superseded by `docs/developer-guide/`.
