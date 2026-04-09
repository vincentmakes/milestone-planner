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

## Context Menu

Right-click on any item for context-appropriate actions:

| Target | Actions |
|--------|---------|
| Project | Edit, Delete, Add Phase, Assign Staff, Assign Equipment, View Details |
| Phase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Subphase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Staff Assignment | Edit Assignment, Remove Assignment |
| Equipment Assignment | Edit Assignment, Remove Assignment |
