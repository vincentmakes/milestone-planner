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

Skills are tags assigned to staff for resource planning:

- Create skills with a **name**, **description**, and **color**
- Assign skills to staff through user management
- Filter staff by skills in the Staff Overview

## Equipment Types

Categorize equipment inventory:

- Create types (e.g., Analytical, Molecular Biology, General Lab)
- Equipment items are assigned a type during creation
- Types appear as filter options in the Equipment View

## Predefined Phases

Phase templates that appear when creating a new project:

- Set **name**, **color**, and **active/inactive** status
- Control display **order**
- Only active phases appear in the project creation modal

## Bank Holidays & Company Events

**Bank Holidays:**

- Configured per site based on country/region
- Auto-refreshed from the Nager.Date API or manually added
- Highlighted on the timeline and affect availability calculations

**Company Events:**

- Organization-wide events (e.g., retreat, annual meeting)
- Created with name, date, and description
- Displayed as labeled rows on the timeline
