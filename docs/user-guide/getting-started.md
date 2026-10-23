# Getting Started

## Logging In

When you navigate to the application URL, you are presented with the login screen.

![Login screen](../assets/screenshots/login.png){ loading=lazy }

- Enter your **email** and **password**, then click **Sign In**.
- If your organization uses **Microsoft Entra ID (SSO)**, click **Sign in with Microsoft** to authenticate through your corporate identity provider. The SSO button only appears if configured by your administrator. Finish the Microsoft sign-in in the same browser window within 10 minutes; otherwise you are asked to start again.
- After 10 failed sign-in attempts for the same e-mail within 15 minutes, further attempts are refused for a while (*"Too many failed sign-in attempts"*). Wait a few minutes or ask an admin to reset your password.
- If your session expires or an admin deactivates your account or changes your role, you are returned to the login screen; anything you were doing in What-If mode is discarded.
- If loading the workspace after sign-in fails, an error screen with a **Retry** button appears instead of an empty workspace.

## The Main Interface

The application is organized into several areas:

- **Sidebar** (far left) — Switch between the main views: Gantt Chart, Kanban Board, My Work, Staff Overview, Equipment, Cross-Site, and Archived
- **Header** (top) — Branding, site selector, date navigation, zoom controls, theme toggle, and user menu
- **Project Panel** (left-center) — Hierarchical list of projects, phases, and subphases
- **Timeline** (right) — Visual Gantt bars aligned to a calendar

## Navigation

### Sidebar Views

| Icon | View | Description |
|------|------|-------------|
| Gantt | **Gantt Chart** | Project timeline with phases and resource assignments (default) |
| Kanban | **Kanban Board** | The same work as cards moving through To Do, In Progress, Blocked and Done |
| Work | **My Work** | Requests waiting for your decision, your bookings and your own requests, with a badge counting the requests to decide — see [My Work](my-work.md) |
| Staff | **Staff Overview** | Staff members with assignments and availability |
| Equipment | **Equipment** | Equipment items with booking timelines |
| Cross-Site | **Cross-Site** | Overview of projects across the sites you can see (needs at least two) |
| Archive | **Archived** | Completed/archived projects |

Which views you see depends on your role: a view your role does not include is not listed, and **Cross-Site** is shown disabled while you can see only one site. The sidebar can be collapsed to icon-only mode for more screen space. Admins and superusers — anyone whose role manages one of the Settings sections — also see a **Settings** entry in the **Admin** section, which opens the [Settings window](settings.md) — users, sites, calendars, equipment, phases and SSO, limited to what your role can change. Your own time off is under **My absences** in the user menu (see [Vacations & Time Off](vacations.md#my-absences)).

### Header Controls

**Left — Branding & Context:**

- Logo and instance title (customizable by admin)
- Site selector dropdown to switch between locations — it lists only the sites you can see
- **Teams** filter — appears when the site has teams; narrows the views to one or more teams of the site, or to what has no team. Remembered per site in your browser (see [Team Filter](settings.md#team-filter))

**Center — Timeline Navigation:**

- Arrow buttons to scroll the timeline backward/forward
- **Today** button to jump to the current date
- View mode: **W** (Week), **M** (Month), **Q** (Quarter), **Y** (Year)
- Zoom controls (**−**, the current percentage, **+**) to adjust timeline cell width (12px to 120px)

**Right — Actions & User Menu:**

- **Panels** toggle — Show/hide Staff and Equipment panels below the Gantt chart
- **What-If** toggle — Enter/exit scenario planning mode (Gantt chart only; shown when your role includes What-If mode)
- Theme toggle (light/dark)
- Online users indicator
- **Offline** badge — appears only while live updates are disconnected. Your edits still save; you just don't see colleagues' changes until the connection is back. It reconnects by itself when the network returns or you switch back to the tab
- User menu (your name and role, My absences, logout, and the version this instance is running)

!!! note "The header adapts to the window width"
    On a narrower window the bar collapses in stages rather than crowding. Button labels shorten to icons first; below roughly 1280px the zoom and undo/redo controls move into a **⋯** menu beside the notification bell, and below about 1024px the view switcher and the theme and What-If toggles join them. Nothing is removed — everything stays reachable in that menu, and zoom and undo/redo also have [keyboard shortcuts](keyboard-shortcuts.md).

### Checking your version

The bottom of the user menu shows the version this instance is running, for example `v1.4.0`. It is read from the server each time you open the menu, so if your administrator upgrades the instance while you have the application open, the number changes here — reload the page to pick up the new version.

## User Roles

Your **role** decides what you can do. Milestone ships with three roles, and an administrator can adjust them or add others (for example a *Team Lead*) in [Settings → Roles](settings.md#roles-permissions):

| Role | Default permissions |
|------|---------------------|
| **Administrator** | Everything, at every site: users, roles, sites, settings, projects, assignments |
| **Superuser** | Manage projects, assignments, equipment, calendars and teams at their own sites, use What-If mode; cannot manage roles, user accounts or settings |
| **User** | View projects and timelines at their sites; book their own absences; add themselves to projects and Kanban cards and manage their own assignments. The **project manager** of a project can also edit that project, its phases, assignments, equipment bookings and cards (but not delete it) |

Your role's name is shown in the user menu. Depending on the role, booking your own time may need [approval](settings.md#approvals) — the buttons then read *Request to assign me* or *Request to join*, and your booking waits in a dashed row until someone approves it.

**You see only your sites.** Unless your role has *See all sites* (administrators by default), the site selector lists only the sites you belong to, and you cannot see or change anything at the others.

See [Who Can Edit a Project](gantt-charts.md#who-can-edit-a-project) for the details.
