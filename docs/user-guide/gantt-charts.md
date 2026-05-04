# Gantt Charts

The Gantt Chart is the primary view and the default when you log in. It combines a hierarchical project list with an interactive timeline.

## Project Panel

The left panel displays your projects in a tree structure:

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
- A red vertical line marks today's date
- Bank holidays and company events are highlighted on the background

## Creating a Project

1. Click **+ New Project** in the panel header
2. Fill in required fields: **Project Name**, **Start Date**, **End Date**
3. Optionally set: Project Manager, Customer, Sales PM, Project Volume
4. Select which **predefined phases** to include (all active phases are pre-selected)
5. Check **Project Confirmed** if the project is approved
6. Click **Create Project**

## Editing Projects, Phases & Subphases

- **Edit a project**: Click the **Edit** button or right-click and select "Edit"
- **Add a phase**: Right-click on a project and select "Add Phase"
- **Add a subphase**: Right-click on a phase and select "Add Subphase" (supports unlimited nesting)
- **Delete**: Right-click on any item and select "Delete" (with confirmation)

When editing a project, export buttons (CSV and XML) are available in the modal footer.

## Tags

Tags are colored labels you can attach to projects to group, filter, or visually classify them (e.g., *Critical*, *Internal*, *Customer X*). The same tag library is shared across every project in the instance — once a tag is created, anyone can attach it to their projects.

Tags are managed from the **Tags** field in the project create/edit modal.

### Attaching a tag

1. Open the project (Edit, or while creating a new one).
2. Click the **Find or create a tag…** field under *Tags*.
3. Start typing to filter the dropdown of existing tags. Click a result — or press Enter on a unique match — to attach it. The tag appears as a colored pill above the search field.
4. Click the **×** on any pill to detach it from the project.

### Creating a new tag

Available to admins and superusers.

1. In the same field, type the new tag name.
2. If no existing tag matches, a **Create "<name>"** row appears at the bottom of the dropdown. Click it (or press Enter).
3. The tag is created instantly with a randomly chosen color and attached to the project. The dropdown then shows a small **Pick a color for "<name>"** panel.
4. Click any swatch (or use the native color picker) to set the color. Changes apply immediately and propagate to every other project that uses this tag. Click **Done** to dismiss the panel.

### Editing or deleting a tag

Available to admins and superusers.

1. Open the dropdown and locate the tag you want to change.
2. Click the **pencil** icon next to it. The dropdown switches to an edit panel with a name field and color palette.
3. Edit the name (commits on Enter or when you click away) and pick a color (applies immediately).
4. To remove the tag from the entire instance, click **Delete** in this panel. You'll be asked to confirm — deletion removes the tag from every project that uses it and cannot be undone.
5. Click **Done** to close the panel.

To simply remove a tag from one project without deleting it, use the **×** on the pill instead of the Delete button.

### Permissions

| Action                              | Who can do it                                  |
| ----------------------------------- | ---------------------------------------------- |
| Attach / detach an existing tag     | Anyone who can edit the project                |
| Create a new tag                    | Admins and superusers                          |
| Rename a tag or change its color    | Admins and superusers                          |
| Delete a tag from every project     | Admins and superusers                          |

## Drag & Drop

The timeline supports direct manipulation:

- **Move a bar** — Drag left/right to change dates (phantom preview shows target position)
- **Resize a bar** — Drag left/right edge to extend or shorten duration
- **Reorder phases** — Drag within the project panel to reorder

## Completion Tracking

Each project and phase has a completion slider (0–100%):

- The filled portion of the bar represents progress
- Click on the completion area to adjust
- Purely informational — does not affect scheduling

## Custom Columns

Add custom data fields to the project panel to track metadata like priority, status codes, budget, or risk levels. Up to **10 columns** can be active per site (including global columns).

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

Values are saved automatically as you edit. Changes cascade — editing a phase's value also updates its child subphases.

### Managing Columns

Open **Manage Columns** to see all active columns:

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

### Resizing Column Widths

Drag the **right edge** of any column header to resize its width (60px–400px). The new width is saved automatically.

### Show/Hide Columns

Toggle individual column visibility from the column manager without deleting them.

## Dependencies

Link phases and subphases with dependency relationships to enforce scheduling logic. Dependency arrows are drawn on the timeline to visualize the relationships.

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

Right-click on a phase or subphase, edit it, and remove the dependency from the dependencies list.

### Visual Arrows

Each dependency type has a distinct visual style on the timeline:

- **FS** — Solid arrow from source end to target start
- **SS** — Dashed arrow connecting start edges
- **FF** — Dotted arrow connecting end edges
- **SF** — Dash-dot arrow from source start to target end

### Constraints

- Dependencies can only be created between items **within the same project**
- **Circular dependencies** are detected and blocked — you'll see an alert if a link would create a cycle
- Duplicate dependencies (same source, same type) are silently ignored

## Critical Path

The **Critical Path** highlights the longest sequence of dependent phases through a project, showing the minimum time needed to complete it. Items on the critical path have zero slack — any delay to them delays the entire project.

### How to Use

1. Right-click on a project and select **Toggle Critical Path** (or use the project context menu)
2. Critical path items are visually highlighted on the timeline
3. Toggle it off to return to normal view

The critical path is calculated using the **Critical Path Method (CPM)** algorithm:

- Forward pass: calculates the earliest possible start and finish for each item
- Backward pass: calculates the latest allowable start and finish
- Items where early start equals late start (zero float) are on the critical path

!!! tip
    The critical path requires dependencies to be set up between phases. Without dependencies, all items have independent float and no critical path exists.

## Context Menu

Right-click on any item for context-appropriate actions:

| Target | Actions |
|--------|---------|
| Project | Edit, Delete, Add Phase, Assign Staff, Assign Equipment, View Details |
| Phase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Subphase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Staff Assignment | Edit Assignment, Remove Assignment |
| Equipment Assignment | Edit Assignment, Remove Assignment |
