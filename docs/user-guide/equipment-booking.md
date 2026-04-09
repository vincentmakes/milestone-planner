# Equipment Booking

The **Equipment View** provides a timeline for tracking equipment availability and bookings across projects. It can be accessed from the sidebar or embedded below the main Gantt chart via the **Panels** toggle.

## Equipment List Panel

The left panel lists all equipment items for the selected site with:

- **Status indicator**: Green dot (available) or Red dot (currently booked)
- **Equipment name**: Primary identifier
- **Type and status**: Equipment type badge and "In use" / "Available" label
- **Drag handle**: Admins and Superusers can drag equipment onto the Gantt timeline to create bookings

The panel is resizable — drag the divider between the panel and timeline (200px–500px).

## Equipment Timeline

The right side shows a horizontal timeline with booking bars:

- Bars are **color-coded by project** for easy identification
- Multiple bookings can overlap on the same equipment, displayed as stacked bars
- Click any booking bar to edit the assignment (dates, equipment)
- Timeline zoom and date navigation sync with the main Gantt chart when embedded

## Booking Equipment

### Method 1: Drag & Drop

1. Grab an equipment item by the drag handle in the Equipment panel
2. Drag it onto a project or phase bar on the Gantt timeline
3. The Equipment Assignment Modal opens pre-filled with the target project/phase dates

### Method 2: Context Menu

1. Right-click on a project, phase, or subphase in the Gantt chart
2. Select **Assign Equipment**
3. The Equipment Assignment Modal opens

### Assignment Modal

- Select the **equipment item** from a dropdown
- Set **start and end dates** for the booking
- Click **Save** to confirm

## Filtering by Type

Click the **filter button** in the Equipment panel header to filter by equipment type:

1. A dropdown shows all available types as checkboxes
2. Check types to show (e.g., Analytical, Pilot Plant, Safety)
3. Use **Select All** / **Clear** for quick selection
4. The filter button shows the active count when filtering (e.g., "3 types")

## Managing Equipment

Open the **Equipment Management** modal from the sidebar admin section (Admins and Superusers only).

### Adding Equipment

1. Click **Add Equipment**
2. Fill in:
   - **Name** (required, e.g., "Pilot Plant A", "Mass Spec 1")
   - **Type** — select an existing type or click **+ New type** to create one inline
   - **Site** (required) — select which site the equipment belongs to
3. Click **Create Equipment**

### Editing Equipment

1. Click the **edit icon** on an equipment row
2. Modify the name, type, description, or active status
3. Click **Save Changes**

Setting equipment to **inactive** removes it from booking lists and the Equipment View. Inactive equipment and their existing bookings are preserved.

### Deleting Equipment

Click **Delete Equipment** in the edit form. A confirmation dialog warns that all assignments for the equipment will also be removed. This action is irreversible.

### Equipment Types

Types are managed via the **Manage Types** button in the Equipment Management modal. See [Settings — Equipment Types](settings.md#equipment-types) for details on creating, renaming, and deleting types.

## Permissions

| Action | Admin | Superuser | User |
|--------|-------|-----------|------|
| View equipment & bookings | Yes | Yes | Yes |
| Assign equipment to projects | Yes | Yes | No |
| Add/edit/delete equipment | Yes | Yes (own sites only) | No |
| Manage equipment types | Yes | Yes | No |
