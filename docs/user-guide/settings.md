# Settings & Configuration

Access settings through the gear icon in the sidebar or through the user menu. Most settings require Admin role.

## Instance Settings

- **Application Title** — Name displayed in the header and browser tab (e.g., "ACME R&D Planner")

## Branding & Themes

- Choose from available **theme families** (color schemes)
- Toggle **light/dark mode** using the sun/moon icon in the header
- Upload custom logos for dark and light themes (drag-and-drop or click to browse)
- Click **Remove** to revert to the default Milestone logo

## Display Settings

| Setting | Description |
|---------|-------------|
| Default View | Initial timeline granularity: Week, Month, Quarter, or Year |
| Week Starts On | Monday or Sunday |
| Show Weekends | Toggle weekend columns on/off |
| Auto-expand Projects | Automatically expand all projects on load |

## Site Management

Sites represent your organization's physical locations:

- **Name**, **City**, **Country**, **Timezone**
- Site-specific **bank holidays** (auto-fetched or manually added)
- Staff and projects are filtered by the selected site

## User Management

Administrators can create, edit, and delete user accounts with:

- Email, name, job title
- Role (Admin, Superuser, User)
- Site assignments (users can belong to multiple sites)

## Skills Management

Skills are colored tags assigned to staff for resource planning and filtering.

### Creating Skills

1. Navigate to **Settings** > **Skills**
2. Click **+ Add Skill**
3. Set a **name**, optional **description**, and a **color** (used as a visual dot/badge)
4. Click **Save**

### Assigning Skills to Staff

1. Go to **User Management** and edit a user
2. In the skills section, select one or more skills from the dropdown
3. Save the user profile

### Filtering by Skills

In the **Staff Overview**, click the **Filter** dropdown and select one or more skills. Each skill shows its assigned color dot for quick visual identification. Staff members matching **any** of the selected skills are shown. The header displays a filtered/total count (e.g., "8/20 staff").

## Equipment Types

Equipment types categorize your inventory for filtering and organization.

### Managing Types

- **Create**: Types are created implicitly when you add equipment items — enter a type name during equipment creation
- **Rename**: In the Equipment View filter dropdown, click the edit icon next to a type to rename it. All equipment items of that type are updated automatically
- **Delete**: Remove a type from the dropdown. Equipment items previously assigned this type will have their type cleared

Types appear as filter checkboxes in the **Equipment View** — use "Select All" and "Clear" for quick filtering.

## Predefined Phases

Phase templates that appear as pre-selected options when creating a new project.

### Managing Templates

1. Navigate to **Settings** > **Predefined Phases**
2. Each template has:
   - **Name** — The phase name (e.g., "Planning", "Execution", "Review")
   - **Color** — Color used for the phase bar on the timeline
   - **Active/Inactive** — Only active templates appear in the project creation modal
   - **Display Order** — Drag to reorder how templates are listed

### How Templates Work

When creating a new project, all **active** predefined phases are pre-selected as checkboxes. Uncheck any you don't need for that project. The selected phases are created with default durations matching the project's start and end dates.

### Adding a Template

1. Click **+ Add Phase**
2. Enter the name and pick a color
3. The new template is active by default and appears at the end of the list
4. Drag to reorder as needed

## Bank Holidays & Company Events

### Bank Holidays

Bank holidays are configured **per site** and affect staff availability calculations.

**Auto-fetch from Nager.Date API:**

1. Go to **Settings** > **Sites** and edit a site
2. Set the site's **country** (e.g., Switzerland, Germany)
3. Click **Refresh Holidays** — Milestone fetches the current year's public holidays from the [Nager.Date API](https://date.nager.at/) based on the country
4. Holidays appear as highlighted columns on the timeline

**Manually add a holiday:**

1. In the site's holiday list, click **+ Add Holiday**
2. Enter the **name** and **date**
3. Save — the holiday is added alongside any auto-fetched ones

Bank holidays are shown as shaded columns on the Gantt timeline and reduce staff availability on those days.

### Company Events

Company events are organization-wide dates displayed as labeled rows at the bottom of the Staff Overview timeline (e.g., "Annual Retreat", "Company Meeting").

1. Navigate to **Settings** > **Company Events**
2. Click **+ Add Event**
3. Enter the **name**, **date**, and optional **description**
4. Save — the event appears on the timeline for all users

Company events are informational markers and do not automatically affect availability calculations.
