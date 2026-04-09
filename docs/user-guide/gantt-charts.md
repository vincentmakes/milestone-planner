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

Add additional data fields to the project panel:

1. Click **Manage Columns** in the panel header
2. Click **+ New Column**
3. Configure: Name, Data Type (Text, Number, Checkbox, Date, Dropdown), Default Value, Width
4. For Dropdown type: provide comma-separated options

Custom columns support inline editing, show/hide toggles, and resizable widths.

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
