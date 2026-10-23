# Gantt Charts

The Gantt Chart is the primary view and the default when you log in. It combines a hierarchical project list with an interactive timeline.

![Main Gantt view: projects expanded into phases, custom columns populated, today indicator](../assets/screenshots/gantt-main.png){ loading=lazy }

## Project Panel

The left panel displays your projects in a tree structure. The header buttons sit at the right edge of the panel, after any custom columns:

- **Staff & Equipment** — Show or hide the assignment rows
- **Filter** — [Filter projects by their dropdown fields and tags](#filtering-projects)
- **Group by** — [Group projects by a dropdown field](#grouping-projects-by-a-field) (shown once a dropdown field has an item at the site)
- **Colour by** — [Colour the project bars by a dropdown field or the tags](#project-colours) (shown once there is a dropdown field or a tag at the site)
- **Column Visibility** — Show or hide custom columns
- **+ New Project** — Create a new project
- **Import** — Import from CSV, XML, or MPP
- **Manage Columns** — Configure custom data columns
- Expand/collapse projects to see phases, subphases, and assignments
- Status indicators: confirmed (green) or unconfirmed (gray)

The panel is resizable — drag the divider between the panel and timeline to adjust width (200px to 600px).

## Timeline

The right side shows horizontal bars representing duration of each project, phase, and subphase:

- **Project bars** span the full project duration
- **Phase bars** are color-coded by phase type
- **Subphase bars** support unlimited nesting depth
- A red vertical line marks today's date, and the current month is highlighted in the header
- Week numbers follow **ISO 8601**: weeks start on Monday and week 1 is the week containing the first Thursday of the year, so 1–3 January 2027 show as week 53 (of 2026)
- The timeline opens centred on today in every view
- Bank holidays and company events are highlighted on the background; a company event marked as a [site closure](settings.md#site-closures) gets a stronger, hatched tint (tooltip *Site closed: &lt;name&gt;*)
- Staff assignment bars are marked on days the person is away — an unavailable absence, or a closure of one of their sites

## Resource Panels

People who can edit any project (administrators and superusers by default) and project managers (users who manage at least one project) can dock the **Staff Overview** or **Equipment** view directly below the Gantt chart from the **Panels** button in the header. The two panels are mutually exclusive — you can show one at a time. Drag the divider between the chart and the docked panel to resize each region.

This is the fastest way to see scheduling and capacity together: changes you make in the Gantt are reflected in the panel below in real time.

An administrator can choose a panel that opens every time the Gantt chart is opened, and default skills or equipment types for the panels' filters, in [Settings → Features & defaults](settings.md#features-defaults). You can still close the panel or change the filter; the default applies again the next time you open the Gantt chart.

![Gantt chart with the Staff Overview panel docked below, showing assignments per person](../assets/screenshots/gantt-with-staff-panel.png){ loading=lazy }

![Gantt chart with the Equipment panel docked below, showing equipment availability](../assets/screenshots/gantt-with-equipment-panel.png){ loading=lazy }

## Who Can Edit a Project

With the default roles (an administrator can change them in [Settings → Roles](settings.md#roles-permissions)), and only for projects at the sites you can see:

| | Admin / Superuser | Project manager | Everyone else |
|---|---|---|---|
| View the project | Yes | Yes | Yes |
| Create a project, import a project | Yes | No | No |
| Edit details, dates, tags, archive; hand the project to another manager | Yes | Yes | No |
| Add, edit, move, resize, reorder and delete phases and subphases; dependencies; completion | Yes | Yes | No |
| Assign and edit anyone's staff assignments; book equipment | Yes | Yes | No |
| Add themselves, change or remove their own assignment | Yes | Yes | Yes — or by [request](staff-management.md#booking-yourself-when-approval-is-required) when their role needs approval |
| Delete the project | Yes | No | No |

The **project manager** is the person selected in the project's **Project Manager** field. They get these rights on that project only, even with the plain User role, as long as their role can *act as project manager* — controls they can't use on other projects stay disabled. Changing the Project Manager field hands the rights over to someone else. Moving a Kanban card is also open to the card's assignees (see [Kanban Board](kanban-board.md#moving-cards)).

## Creating a Project

Creating a project needs the *Create projects* permission (admins and superusers by default), at one of the sites you can see.

1. Click **+ New Project** in the panel header
2. Fill in required fields: **Project Name**, **Start Date**, **End Date**
3. Optionally set: Project Manager, Customer, Sales PM, Volume (an administrator may have [renamed or hidden](settings.md#project-fields) these)
4. If the site has [teams](settings.md#teams), tick the **Teams** the project belongs to — the teams of the active [team filter](settings.md#team-filter) are ticked already, so the new project shows in the view you are on
5. Fill in any [project fields](#project-fields) and tags
6. Select which **predefined phases** to include (all active phases are pre-selected, unless an administrator [turned that off](settings.md#features-defaults) — then none is, and you pick them)
7. Switch **Confirmed** on if the project is approved
8. Click **Create Project**

## Editing Projects, Phases & Subphases

- **Edit a project**: Click the **Edit** button or right-click and select "Edit"
- **Add a phase**: Right-click on a project and select "Add Phase"
- **Add a subphase**: Right-click on a phase and select "Add Subphase" (supports unlimited nesting)
- **Delete**: Right-click on any item and select "Delete" (with confirmation). A project manager can delete phases and subphases, but deleting the project itself needs the *Delete projects* permission (superusers and admins by default)

When editing a project, export buttons (CSV and XML) are available in the modal footer.

![Edit Project modal with name, dates, customer, tags, and CSV/XML export buttons](../assets/screenshots/project-modal.png){ loading=lazy }

## Picking Dates

Every date in Milestone is picked on the same calendar. Click the **Start Date** or **End Date** field — or press Enter, Space or the down arrow while it has focus — and two months open under the fields (one on a phone); the month and year dropdowns jump to a distant date. The first click sets the start, the second the end, and the calendar closes. The end can never fall before the start: picking a start after the current end moves the end along and keeps the duration, and picking an end before the start makes that day the new start, so you then pick the end. Weekends are greyed, and the current site's bank holidays and closures carry a dot — hover the day to see its name. They are only hints: every day can still be picked. A milestone has a single **Date** field on the same calendar.

![Edit Phase dialog of Bioprocess Scale-Up with the two-month calendar open from the Start Date field, the phase's range highlighted](../assets/screenshots/date-range-picker.png){ loading=lazy }

## Project Fields

Besides its name, dates and manager, a project carries **fields**. Four are built in — **Customer**, **Sales PM**, **Volume** and **Confirmed** — and an administrator can rename them (the new name then replaces the default wherever the field is named), hide the first three, and add fields of the workspace's own in **Settings → Project fields** (see [Project fields in Settings](settings.md#project-fields)). The project dialog shows the added fields after **Teams**, in the order set there:

- **Dropdown** — pick one item (for example *Project type* → Internal / Customer), or several items in a multi-select dropdown such as *Area*: open the dropdown and tick the items (click a row, or move with the arrow keys and press Space); it stays open until you click elsewhere or press Escape, the box lists the chosen items, and **Clear** unticks them all
- **Text** — up to 2,000 characters
- **Number** — any number, shown as typed
- **Switch** — on or off

No field is required. A dropdown item can be limited to some sites and to some [teams](settings.md#teams) of a site, so the dialog only offers the items that apply to the project's site and teams; unticking a project's last matching team removes such an item from the project when you save. People who can manage project fields (admins by default) see a **Manage fields…** link that opens Settings → Project fields.

## Tags

Tags are coloured labels attached to projects to classify and filter them (e.g. *Critical*, *Tech Transfer*). The tag library is shared by the whole workspace: admins define the tags in **Settings → Tags** (see [Tags in Settings](settings.md#tags)), and anyone who can edit a project attaches them. Categories with fixed choices, such as a project type, are [dropdown project fields](#project-fields) rather than tags.

Each tag applies to **all sites** or only to the sites an admin picked, so the picker and the filter only offer the tags that apply to the project's site. A tag can also be limited to some [teams](settings.md#teams) of a site: there, the picker offers it only on projects of one of those teams, and unticking a project's last matching team removes the tag from the project when you save.

![The Edit Project dialog with its Project type and Area fields, and the tag picker's list open under the Tags field](../assets/screenshots/project-tags.png){ loading=lazy }

### Attaching a tag

1. Open the project (Edit, or while creating a new one).
2. Click the **Tags** field (or start typing in it). The list shows the available tags in their order.
3. Type to narrow the list, then click a tag (or press Enter on a unique match) to attach it. It appears as a coloured pill above the field.
4. Click the **×** on a pill to detach the tag.

People who can manage tags (admins by default) see a **Manage tags…** link in the picker that opens Settings → Tags.

## Filtering, Grouping and Colouring Projects

### Filtering projects

The **Filter** button in the project panel header (and in the Kanban toolbar) opens one section per dropdown field that has an item at the site, in field order, then a **Tags** section:

- Tick one or more items of a field to show projects holding **any** of them.
- Tick items in several fields, or tags as well, to show only projects matching **every** field (the tags count as one more field).
- **(None)** in a field matches projects without an item of that field, and combines with the field's items.
- **Clear** removes the whole filter.

![The Filter panel of the project panel, open: the Area field with its (None) option and items, then the Tags section](../assets/screenshots/project-filter.png){ loading=lazy }

The button shows how many choices are ticked, and the panel header shows *x of y* projects while a filter is active. The selection is remembered per site, so switching site or reloading brings it back. Items and tags that are deleted later are simply ignored. With a [team filter](settings.md#team-filter) active, the panel only lists the items and tags available to the selected teams.

!!! note "Upgrading to 2.0.0"
    A filter, grouping or colour choice saved in your browser before version 2.0.0 is reset once, because tag groups became project fields — pick it again.

### Grouping projects by a field

To see the portfolio at a glance, split the project list into sections, one per item of a dropdown field — for example *Project type* → Internal / Customer:

1. Click the **Group by** button in the project panel header (next to **Filter**).
2. Pick a dropdown field. **No grouping** returns to the plain list.

Each section starts with a header showing the item as a coloured pill and the number of projects in it; the timeline shows a matching band across the chart. Projects without an item of that field are listed last under **No *field name***. Sections without projects are left out, and a project holding several items of a multi-select field is listed once, under the first of them in the field's item order.

![Gantt project list grouped by Project type, with a pill header per section](../assets/screenshots/gantt-grouped.png){ loading=lazy }

- Click a section header (or its arrow) to collapse or expand it. **Collapse all** / **Expand all** in the Group by panel act on every section at once.
- The filter applies first, then the grouping: sections only hold the projects that pass the filter. The header count still counts projects.
- Projects cannot be reordered by dragging while the list is grouped; choose **No grouping** to change the order.
- A project you create, or change, into a collapsed section stays hidden until you expand that section.
- The grouping and the collapsed sections are remembered per site in your browser, like the filter.

### Project colours

Each user can colour the project bars by a dropdown field or by the tags:

1. Click the **Colour by** button in the project panel header (next to **Group by**).
2. Pick a dropdown field, or **Tags**. **Default** returns to the standard bar colour.

With a field, the project bar on the timeline takes the colour of the project's item of that field — for example blue for internal projects and green for customer projects. A project holding several items of a multi-select field takes the colour of the first of them in the field's item order (the same item *Group by* files it under). With **Tags**, the bar takes the colour of the project's first tag in the tag order. A project without an item of the field (or without a tag) keeps the default colour. Unconfirmed projects keep their striped look on top of the colour.

![The Colour by dropdown open above the Gantt chart: Default, Project type (selected), Area and Tags](../assets/screenshots/gantt-color-by.png){ loading=lazy }

The choice is yours alone: it is remembered per site in your browser, like the filter, and does not change what other users see. It is independent of **Group by** — you can group by one field and colour by another.

### Permissions

| Action                                      | Who can do it                                  |
| ------------------------------------------- | ---------------------------------------------- |
| Fill in project fields, attach / detach a tag | Anyone who can edit the project              |
| Filter, group and colour projects           | Everyone                                       |
| Create, edit, reorder, delete tags          | Admins (Settings → Tags)                       |
| Create, edit, reorder, delete project fields; rename or hide built-in fields | Admins (Settings → Project fields) |

## Drag & Drop

The timeline supports direct manipulation (on projects you can edit; your own assignment bars on any project):

- **Move a bar** — Drag left/right to change dates (phantom preview shows target position)
- **Resize a bar** — Drag left/right edge to extend or shorten duration
- **Reorder phases** — Drag within the project panel to reorder
- **Move a booking inside its phase** — an [unlinked booking](#bookings-on-phases-and-subphases) on a phase or subphase can be dragged and resized, but never past the phase's start or end

### Touch screens

On a tablet or phone, the same gestures work with a finger: press a bar and move it to change its dates, or press one of its edges to resize it (the edge handles are wider on touch screens). A tap opens the item's dialog; a small wobble of the finger during a tap never moves or resizes a bar. A swipe that starts **on a bar you can edit** moves the bar, so swipe on empty row space, the project panel or the header to scroll the chart (bars you cannot edit scroll as usual). If the system interrupts a drag (an incoming call, a gesture the browser takes over), the bar returns to where it was and nothing is saved.

## Bookings on Phases and Subphases

A person booked on a phase or subphase is **linked** to it by default: the booking covers the phase's dates, follows it when the phase moves, and its bar cannot be dragged. The badge at the start of the booking's row in the project panel shows this: it holds a **pin** and the phase's name, and a filled pin means the booking follows the phase dates.

To book someone for only part of a phase — a few days at the start, then a few days at the end — **unlink** the booking:

- **Click the pin** on the booking's row. It turns into an outlined pin (*Own dates*), and the booking keeps the phase's dates for now. Click the outlined pin to make it follow the phase dates again.
- Or turn off **Follow the phase dates** in the [assignment dialog](staff-management.md#assignment-modal) and pick the booking's own dates. The calendar only offers days inside the phase.

An unlinked booking's bar can be moved and resized on the timeline like any other bar, but it stops at the phase's start and end. The pin can only be clicked by people who may change that booking; for everyone else, and while the booking or your change to it awaits approval, it is greyed out but still shows whether the booking follows the phase. An unlinked booking's pin is also greyed out while another booking of the same person on that phase covers part of the phase's dates (*Can't follow the phase dates while another booking of this person overlaps them*): following the phase would make the two overlap.

Click the **phase name** in the badge to scroll the timeline to the booking: to its own start date when it is unlinked, to the phase's start when it follows the phase.

A person can hold **several bookings on the same phase**, as long as their dates do not overlap (adjacent days are fine). Booking someone for days that overlap one of their bookings on that phase is refused with *This person is already booked on this card for overlapping dates*.

When the phase itself changes:

- **Moving the phase** (same duration) moves its unlinked bookings by the same number of days.
- **Shortening it** fits them inside the new dates: a booking that sticks out is cut at the new edge, and a booking left entirely outside is placed against the nearest edge with its length kept (never longer than the phase).
- **Lengthening it** leaves them where they are.

Linked bookings simply keep following the phase. One limit: shortening a phase past two bookings of the same person can push both against the same edge so that they overlap. They are kept as they are until you edit one of them; move one of them apart to resolve it.

### The overview row

When someone has two or more bookings on the same phase or subphase, they are grouped under an **overview row** with the phase or subphase badge (without a pin), the person's name, the number of bookings and their allocation range (*100%*, or *20–60%* when they differ); the bookings under it are listed in date order. On the timeline the overview row shows every booking as a small block (hover one for its dates and allocation; a booking awaiting approval is hatched).

Click the phase name in its badge to scroll the timeline to the person's first booking on that phase. Click the chevron to collapse the group to that one row, and again to expand it. Groups start expanded, and a collapsed group stays collapsed until you reload the page. The overview row itself has no menu: right-click one of the bookings under it to edit or remove it.

![Gantt chart: Charlie Clark's overview row under the Analytics phase of Bioprocess Scale-Up, with his two bookings drawn as blocks, and the two booking rows with their own dates below it](../assets/screenshots/assignment-overview-row.png){ loading=lazy }

## Completion Tracking

Each project and phase has a completion slider (0–100%):

- The filled portion of the bar represents progress
- Click on the completion area to adjust
- Purely informational — does not affect scheduling

The slider also drives the item's column on the [Kanban board](kanban-board.md): 0% is To Do, 100% is Done, and anything in between is In Progress. Moving a card on the board changes the percentage here in the same way. A card you have marked **Blocked** keeps that status when you edit its percentage, since a number cannot express why work has stalled.

## Custom Columns

Add custom data fields to the project panel to track metadata like priority, status codes, budget, or risk levels. Up to **10 columns** can be active per site (including global columns).

![Project panel with custom columns (Priority dropdown, Owner text, Reviewed checkbox) populated per phase](../assets/screenshots/custom-columns.png){ loading=lazy }

### Creating a Column

1. Click **Manage Columns** in the panel header
2. Click **Add Column**
3. Configure:
   - **Column Name** (required, e.g., "Priority", "Status", "Owner")
   - **Column Type** — cannot be changed after creation:
     - **Text** — Free-text field
     - **Checkbox** — Boolean toggle (checked/unchecked)
     - **Dropdown List** — Choose from predefined options
   - **Scope** — **Global** (all sites) or **Local** (current site only)
   - **Column Width** — 60px to 300px (default 120px), adjustable via slider
4. For Dropdown type: add option values using the **Add Option** button (at least one required)
5. Click **Create**

### Editing Values

Custom column values appear as editable cells in the project panel, next to each project, phase, and subphase:

- **Text columns**: Click the cell to edit, press Enter or click away to save, Escape to cancel
- **Checkbox columns**: Click to toggle between checked and unchecked
- **Dropdown columns**: Click to open the options list, select a value or click "Clear selection" to reset

Values are saved automatically as you edit. Changes cascade — editing a phase's value also updates its child subphases. A cascade is saved as one request, so it either succeeds for the whole branch or, if saving fails, every cell it touched returns to its previous value.

**Every built-in role can edit custom-column values** (the *Set custom column values* permission), including the plain User role, on projects at the sites they can see. Creating, editing, reordering and deleting the **columns themselves** needs *Manage custom columns* (admins by default). Values and column changes appear for other signed-in users straight away.

### Managing Columns

Open **Manage Columns** to see all active columns:

![Manage Custom Columns modal with reorder handles and edit/delete actions](../assets/screenshots/manage-columns-modal.png){ loading=lazy }

- **Reorder**: Drag columns by the handle icon to change display order
- **Edit**: Click the edit icon to change name, dropdown options, or width (type cannot be changed)
- **Delete**: Click the delete icon. A confirmation warns that **all values will be lost**

### Column Filtering

Click the **filter icon** on any column header to filter the project list:

1. The dropdown shows all unique values in that column
2. Check values to show only matching rows
3. Use **Select All** / **Clear All** for quick selection
4. Filter by **(Empty)** to find rows with no value set
5. Multiple column filters combine with AND logic

An active filter turns the column header's filter icon blue.

![Column filter dropdown open on the Priority column](../assets/screenshots/column-filter-dropdown.png){ loading=lazy }

### Resizing Column Widths

Drag the **right edge** of any column header to resize its width (60px–400px). The new width is saved automatically.

### Show/Hide Columns

Toggle individual column visibility from the column manager without deleting them.

## Dependencies

Link phases and subphases with dependency relationships to enforce scheduling logic. Dependency arrows are drawn on the timeline to visualize the relationships.

![Dependency arrows linking the Catalyst Optimization phases on the timeline](../assets/screenshots/gantt-dependencies.png){ loading=lazy }

### Dependency Types

| Type | Name | Meaning |
|------|------|---------|
| **FS** | Finish-to-Start | Target starts after source finishes (most common) |
| **SS** | Start-to-Start | Target starts when source starts |
| **FF** | Finish-to-Finish | Target finishes when source finishes |
| **SF** | Start-to-Finish | Target finishes when source starts (rare) |

### Creating a Dependency

Dependencies use a **two-click flow**:

1. Hover over a phase or subphase bar — **link zones** appear at the start (left) and end (right) edges
2. Click a link zone on the **source** item (e.g., the end zone for a Finish-to-Start link)
3. Click a link zone on the **target** item (e.g., the start zone)
4. The dependency type is determined automatically based on which zones you clicked:
   - End → Start = **FS**, Start → Start = **SS**, End → End = **FF**, Start → End = **SF**

After linking, the target item's dates are automatically adjusted:

- **FS**: Target start moves to the day after the source ends
- **SS**: Target start aligns with the source start
- **FF** and **SF**: No automatic date adjustment

Child phases/subphases move along with their parent when dates are adjusted. Parent dates cascade upward to accommodate children.

### Deleting a Dependency

Click the dependency arrow on the timeline and choose **Delete Dependency** in the popup, or edit the target phase or subphase and remove the dependency from its list. This also works for links created by older versions.

### Visual Arrows

Each dependency type has a distinct visual style on the timeline:

- **FS** — Solid arrow from source end to target start
- **SS** — Dashed arrow connecting start edges
- **FF** — Dotted arrow connecting end edges
- **SF** — Dash-dot arrow from source start to target end

### Constraints

- Dependencies can only be created between items **within the same project**
- **Circular dependencies** are detected and blocked — you'll see an alert if a link would create a cycle. The check follows links through phases and subphases alike, and a "shortcut" link that skips an intermediate step (A → C alongside A → B → C) is allowed, because it closes no loop
- Duplicate dependencies (same source, same type) are silently ignored
- Each link remembers whether its source is a phase or a subphase, so arrows and the critical path always attach to the right item even when a phase and a subphase happen to share the same internal id. Links created before this was recorded are read as pointing to a phase first
- **Undo** and **Redo** restore dependency links too, and save them to the server like any other change

## Critical Path

The **Critical Path** highlights the longest sequence of dependent phases through a project, showing the minimum time needed to complete it. Items on the critical path have zero slack — any delay to them delays the entire project.

### How to Use

1. Click the **lightning-bolt button** on the project's row in the project panel (tooltip: *Show Critical Path*)
2. Critical path items are visually highlighted on the timeline
3. Click the button again to return to normal view

![Critical path highlighted across the Catalyst Optimization dependency chain](../assets/screenshots/gantt-critical-path.png){ loading=lazy }

The critical path is calculated using the **Critical Path Method (CPM)** algorithm:

- Forward pass: calculates the earliest possible start and finish for each item
- Backward pass: calculates the latest allowable start and finish
- Items where early start equals late start (zero float) are on the critical path
- Chains in which a successor starts before its predecessor finishes (a lead or overlap) are followed to their end instead of being cut short

!!! tip
    The critical path requires dependencies to be set up between phases. Without dependencies, all items have independent float and no critical path exists.

## Context Menu

Right-click on any item for context-appropriate actions:

![Right-click context menu on a project row](../assets/screenshots/gantt-context-menu.png){ loading=lazy }

| Target | Actions |
|--------|---------|
| Project | Edit, Delete, Add Phase, Assign Staff, Assign me, Assign Equipment, View Details |
| Phase | Edit, Delete, Add Subphase, Assign Staff, Assign me, Assign Equipment |
| Subphase | Edit, Delete, Add Subphase, Assign Staff, Assign me, Assign Equipment |
| Staff Assignment | Edit Assignment, Remove Assignment |
| Equipment Assignment | Edit Assignment, Remove Assignment |

Actions you are not allowed to perform on that project are shown disabled. **Assign me** only appears for people who can't edit the project: it books your own time on the item at your maximum capacity (see [Adding Yourself to a Project](staff-management.md#adding-yourself-to-a-project)) and reads **Assigned to me** once you are on it. On your own staff assignment, **Edit Assignment** and **Remove Assignment** are available to you on any project.

## Archived Projects

Completed or dormant projects can be archived so they no longer clutter the Gantt chart, without deleting their data:

1. Edit the project and tick the **Archived** checkbox, then save.
2. The project disappears from the Gantt and moves to the **Archived** view (sidebar).
3. To restore it, open the Archived view, click the project's edit button, untick **Archived**, and save — it reappears on the Gantt with all phases, assignments, and history intact.

![Archived view listing archived projects](../assets/screenshots/archived-view.png){ loading=lazy }

Archived projects are excluded from the Gantt chart and the cross-site overview, but they remain in the database and are included in the full site Excel export (with an *Archived* column).

## Live Updates and the Offline Badge

Changes made by colleagues appear in your chart automatically, a moment after they save. While
that live connection is down — your network dropped, the server restarted, or a proxy blocks
WebSockets — an **Offline** badge appears in the header. Your own edits still save normally;
only other people's changes stop arriving. The connection is retried automatically, and
immediately when your network comes back or you switch back to the browser tab.

A drag or resize in progress is no longer interrupted when a colleague's change arrives, and
text you are typing in the phase, subphase and assignment dialogs is kept.

## What-If Mode on the Gantt

[What-If mode](what-if-planning.md) is entered from the Gantt chart and stays there: while a plan is
open, the other views and Settings wait until you apply or discard. In it you can move, resize, edit
and delete freely; nothing is saved until you **Apply**. Creating new projects, phases, subphases, assignments, absences and
equipment blocks is unavailable in What-If mode (the controls are disabled with an explanation).
If Apply fails part-way, a banner in the header shows how many changes were applied and offers
**Retry**, **Discard** and **Dismiss** — see
[What-If Planning](what-if-planning.md#if-apply-fails).
