# Milestone Planner — User Manual

> **Version:** 1.0
> **Last Updated:** February 2026
> **Platform:** Web application (desktop browser recommended)

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
   - [Logging In](#21-logging-in)
   - [First Look: The Main Interface](#22-first-look-the-main-interface)
3. [Navigation](#3-navigation)
   - [Sidebar](#31-sidebar)
   - [Header Controls](#32-header-controls)
4. [Gantt Chart View](#4-gantt-chart-view)
   - [Project Panel (Left)](#41-project-panel-left)
   - [Timeline (Right)](#42-timeline-right)
   - [Creating a Project](#43-creating-a-project)
   - [Editing Projects, Phases & Subphases](#44-editing-projects-phases--subphases)
   - [Drag & Drop on the Timeline](#45-drag--drop-on-the-timeline)
   - [Completion Tracking](#46-completion-tracking)
   - [Custom Columns](#47-custom-columns)
   - [Context Menu (Right-Click)](#48-context-menu-right-click)
5. [Staff Overview](#5-staff-overview)
   - [Staff List Panel](#51-staff-list-panel)
   - [Staff Timeline](#52-staff-timeline)
   - [Assigning Staff](#53-assigning-staff)
   - [Filtering Staff](#54-filtering-staff)
6. [Equipment View](#6-equipment-view)
   - [Equipment List Panel](#61-equipment-list-panel)
   - [Equipment Timeline](#62-equipment-timeline)
   - [Booking Equipment](#63-booking-equipment)
7. [Cross-Site View](#7-cross-site-view)
8. [Archived Projects](#8-archived-projects)
9. [Vacation & Time-Off Management](#9-vacation--time-off-management)
   - [Creating Vacations](#91-creating-vacations)
   - [Recurring Absences](#92-recurring-absences)
   - [Importing from Calendar (ICS)](#93-importing-from-calendar-ics)
   - [Exporting to Outlook](#94-exporting-to-outlook)
10. [Import & Export](#10-import--export)
    - [Importing Projects](#101-importing-projects)
    - [Exporting Projects](#102-exporting-projects)
11. [Settings & Configuration](#11-settings--configuration)
    - [Instance Settings](#111-instance-settings)
    - [Branding & Themes](#112-branding--themes)
    - [Display Settings](#113-display-settings)
    - [Site Management](#114-site-management)
    - [User Management](#115-user-management)
    - [Skills Management](#116-skills-management)
    - [Equipment Types Management](#117-equipment-types-management)
    - [Predefined Phases](#118-predefined-phases)
    - [Bank Holidays & Company Events](#119-bank-holidays--company-events)
12. [What-If Mode](#12-what-if-mode)
13. [Real-Time Collaboration](#13-real-time-collaboration)
14. [SSO (Microsoft Entra ID)](#14-sso-microsoft-entra-id)
15. [Admin Portal (Multi-Tenant)](#15-admin-portal-multi-tenant)
    - [Tenant Management](#151-tenant-management)
    - [Organization Management](#152-organization-management)
    - [Admin Users](#153-admin-users)
    - [System Statistics](#154-system-statistics)
16. [Keyboard Shortcuts & Tips](#16-keyboard-shortcuts--tips)

---

## 1. Introduction

**Milestone Planner** is a web-based project management platform designed for R&D teams. It provides interactive Gantt charts, staff allocation with capacity tracking, equipment booking, multi-site support, and real-time collaboration — all in a modern, responsive interface.

Key capabilities at a glance:

- **Interactive Gantt Charts** — Visualize projects, phases, and subphases on a drag-and-drop timeline
- **Staff Allocation** — Assign team members with percentage-based capacity tracking
- **Equipment Booking** — Reserve lab instruments and equipment across projects
- **Multi-Site Support** — Manage resources across multiple geographic locations
- **What-If Planning** — Test scenarios without affecting live data
- **Real-Time Collaboration** — See changes from other users instantly via WebSocket
- **Import/Export** — Exchange data with Microsoft Project (CSV, XML)

---

## 2. Getting Started

### 2.1 Logging In

When you navigate to the application URL, you are presented with the login screen.

```
┌──────────────────────────────────────┐
│                                      │
│          ◆ Milestone                 │
│        Sign in to continue           │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ 🪟  Sign in with Microsoft  │    │
│  └──────────────────────────────┘    │
│                                      │
│  ──────── or sign in with email ──── │
│                                      │
│  Email                               │
│  ┌──────────────────────────────┐    │
│  │ your@email.com               │    │
│  └──────────────────────────────┘    │
│                                      │
│  Password                            │
│  ┌──────────────────────────────┐    │
│  │ ••••••••                     │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │          Sign In             │    │
│  └──────────────────────────────┘    │
│                                      │
└──────────────────────────────────────┘
```

- Enter your **email** and **password**, then click **Sign In**.
- If your organization uses **Microsoft Entra ID (SSO)**, click **Sign in with Microsoft** to authenticate through your corporate identity provider. The SSO button only appears if SSO has been configured by your administrator.
- After successful login, you are taken to the main Gantt chart view.

### 2.2 First Look: The Main Interface

The application is organized into a few major areas:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◆ Milestone   │ Site ▼ │  ◀ Today ▶  │ W M Q Y │ - 100% + │ ☀ 👤 │  ← Header
├────┬────────────────────────────────────────────────────────────────┤
│    │                                                                │
│ 📊 │  Project Panel (tree)  │          Timeline (Gantt bars)        │
│ 👥 │  ─────────────────────  │  ════════════════════════════════    │
│ 🔧 │  ▸ Project Alpha        │  ▓▓▓▓▓▓▓▓▓░░░░░░░░░               │
│ 🌐 │    ▸ Phase 1            │     ▓▓▓▓▓▓░░░░                     │
│ 📁 │    ▸ Phase 2            │            ▓▓▓▓▓▓▓▓                 │
│    │  ▸ Project Beta          │        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓           │
│    │                          │              │ ← Today line         │
│Side│                          │                                     │
│bar │──────────────────────────│─────────────────────────────────────│
│    │  Staff/Equipment Panel   │          Resource Timeline          │
│    │                          │                                     │
└────┴────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (far left): Switch between the five main views
- **Header** (top): Branding, site selector, date navigation, zoom, theme, and user menu
- **Project Panel** (left-center): Hierarchical list of projects, phases, and subphases
- **Timeline** (right): Visual Gantt bars aligned to a calendar
- **Overview Panels** (bottom, optional): Staff or Equipment summaries

---

## 3. Navigation

### 3.1 Sidebar

The sidebar on the left edge of the screen provides access to the five main views:

| Icon | View | Description |
|------|------|-------------|
| 📊 | **Gantt Chart** | Project timeline with phases and resource assignments (default view) |
| 👥 | **Staff Overview** | Staff members with their assignments and availability |
| 🔧 | **Equipment** | Equipment items with booking timelines |
| 🌐 | **Cross-Site** | Overview of projects across all sites |
| 📁 | **Archived** | Completed/archived projects |

The sidebar can be **collapsed** by clicking the arrow button at the top, leaving only icons visible. This gives more screen space to the main content area.

When expanded, the sidebar also shows **Quick Stats** at the bottom — a snapshot of key metrics (project count, active staff, etc.).

Administrators and superusers see an additional **Admin** section in the sidebar with links to user management, site management, and other configuration screens.

### 3.2 Header Controls

The header bar is organized in three sections:

**Left — Branding & Context:**
- **Logo** — The Milestone logo (adapts to light/dark theme)
- **Instance Title** — Your organization's custom name for this instance
- **Site Selector** — Dropdown to switch between sites (e.g., "Winterthur", "Frankfurt")

**Center — Timeline Navigation:**
- **◀ ▶ buttons** — Scroll the timeline backward/forward by one period
- **Today** button — Jump back to the current date
- **View Mode** — Four buttons to set the timeline granularity:
  - **W** = Week (each cell = 1 day, headers show weeks)
  - **M** = Month (each cell = 1 day, headers show months)
  - **Q** = Quarter (each cell = 1 week, headers show quarters)
  - **Y** = Year (each cell = 1 month, headers show years)
- **Zoom** — Adjust the width of each timeline cell:
  - **−** to zoom out (minimum 12px per cell)
  - Percentage display (click to reset to 100%)
  - **+** to zoom in (maximum 120px per cell)

**Right — Actions & User Menu:**
- **Panels** button — Toggle the Staff and Equipment overview panels below the Gantt chart (admin only)
- **What-If** button — Enter/exit What-If planning mode (admin/superuser only)
- **Theme toggle** — Switch between light and dark mode (sun/moon icon)
- **Online users** — See who else is currently using the application
- **User menu** — Access your profile, settings, admin portal, and log out

---

## 4. Gantt Chart View

The Gantt Chart is the primary view and the default when you log in. It combines a hierarchical project list with an interactive timeline.

### 4.1 Project Panel (Left)

The project panel displays your projects in a tree structure:

```
┌─────────────────────────────────────┐
│  + New Project    ⬆ Import   ⚙      │
├─────────────────────────────────────┤
│  ▾ ✅ Project Alpha         [Edit]  │
│     ▾ ██ Requirements Analysis       │
│        👤 Alice A. (50%)             │
│        👤 Bob B. (100%)              │
│     ▸ ██ Development                 │
│     ▸ ██ Testing                     │
│  ▸ ⬜ Project Beta           [Edit]  │
│  ▸ ✅ Project Gamma          [Edit]  │
└─────────────────────────────────────┘
```

- **+ New Project** — Create a new project
- **Import** — Import a project from CSV or Microsoft Project XML
- **⚙ Manage Columns** — Configure custom columns
- **▾ / ▸** — Expand or collapse a project to see its phases
- **✅ / ⬜** — Indicates whether the project is **confirmed** (green) or **unconfirmed** (gray)
- **[Edit]** — Opens the project editing modal
- **Phases** appear nested under projects with colored bars matching their type
- **Staff assignments** are shown inline under each phase with the person's name and allocation percentage
- **Equipment assignments** are also shown inline when the "Show Assignments" option is enabled

The panel is **resizable** — drag the vertical divider between the panel and the timeline to adjust the width (200px to 600px).

### 4.2 Timeline (Right)

The timeline displays horizontal bars representing the duration of each project, phase, and subphase:

- **Project bars** span the full project duration
- **Phase bars** are nested under their project, color-coded by phase type
- **Subphase bars** nest further, supporting unlimited depth
- A **red vertical line** marks today's date
- **Bank holidays** are highlighted on the timeline background
- **Company events** are shown as labeled rows

The timeline header shows the date labels according to your selected view mode (weeks, months, quarters, or years).

### 4.3 Creating a Project

1. Click **+ New Project** in the project panel header.
2. The **Project Modal** opens:

```
┌─ Create Project ─────────────────────────────┐
│                                               │
│  Project Name *                               │
│  ┌───────────────────────────────────────┐    │
│  │                                       │    │
│  └───────────────────────────────────────┘    │
│                                               │
│  Start Date *              End Date *         │
│  ┌────────────────┐  ┌────────────────┐       │
│  │ 2026-03-01     │  │ 2026-09-30     │       │
│  └────────────────┘  └────────────────┘       │
│                                               │
│  Project Manager            Customer          │
│  ┌────────────────┐  ┌────────────────┐       │
│  │ Select PM... ▼ │  │                │       │
│  └────────────────┘  └────────────────┘       │
│                                               │
│  Sales PM              Project Volume (CHF)   │
│  ┌────────────────┐  ┌────────────────┐       │
│  │                │  │                │       │
│  └────────────────┘  └────────────────┘       │
│                                               │
│  Phases                                       │
│  ┌─────────┐ ┌───────────┐ ┌─────────┐       │
│  │ ██ Req. │ │ ██ Design │ │ ██ Dev  │ ...   │
│  └─────────┘ └───────────┘ └─────────┘       │
│                                               │
│  ☑ Project Confirmed                          │
│                                               │
│           [ Cancel ]  [ Create Project ]      │
└───────────────────────────────────────────────┘
```

3. Fill in the required fields: **Project Name**, **Start Date**, and **End Date**.
4. Optionally set a **Project Manager** (dropdown of staff assigned to the current site), **Customer**, **Sales PM**, and **Project Volume**.
5. In the **Phases** section, predefined phases are shown as colored tags. Click on any phase to toggle it on or off. All active predefined phases are included by default.
6. Check **Project Confirmed** if the project is approved.
7. Click **Create Project**.

### 4.4 Editing Projects, Phases & Subphases

- **Edit a project**: Click the **[Edit]** button next to the project name, or right-click and select "Edit".
- **Add a phase**: Right-click on a project and select "Add Phase", or use the phase modal.
- **Add a subphase**: Right-click on a phase and select "Add Subphase". Subphases can be nested to any depth.
- **Delete**: Right-click on any item and select "Delete". You will be asked to confirm.

When editing a project, you also have access to **Export** buttons (CSV and XML) in the modal footer.

### 4.5 Drag & Drop on the Timeline

The timeline supports direct manipulation of bars:

- **Move a bar** — Click and drag a phase/subphase bar left or right to change its dates. A phantom preview shows where it will land.
- **Resize a bar** — Hover over the left or right edge of a bar until the cursor changes to a resize handle, then drag to extend or shorten the duration.
- **Reorder phases** — Drag a phase in the project panel to reorder it within its project.

### 4.6 Completion Tracking

Each project and phase has a **completion slider** that shows progress as a percentage:

- The filled portion of the bar represents the completion percentage
- Click on the completion area to adjust it
- Completion is purely informational and does not affect scheduling

### 4.7 Custom Columns

Custom columns let you add additional data fields to the project panel:

1. Click **⚙ Manage Columns** in the project panel header.
2. In the Custom Columns Manager, click **+ New Column**.
3. Configure the column:
   - **Name** — The column header text
   - **Data Type** — Text, Number, Checkbox, Date, or Dropdown
   - **Default Value** — Pre-filled value for new entries
   - **Width** — Column width (80–300px)
   - For Dropdown type: provide comma-separated options
4. Click **Save**.

Custom columns appear between the project name and the timeline. You can:
- **Show/hide columns** using the visibility toggle dropdown
- **Resize columns** by dragging column borders
- **Edit values** by clicking on cells inline
- **Delete columns** through the Manage Columns modal

### 4.8 Context Menu (Right-Click)

Right-clicking on any item in the project panel or timeline opens a context menu with actions relevant to that item:

| Target | Available Actions |
|--------|-------------------|
| Project | Edit, Delete, Add Phase, Assign Staff, Assign Equipment, View Details |
| Phase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Subphase | Edit, Delete, Add Subphase, Assign Staff, Assign Equipment |
| Staff Assignment | Edit Assignment, Remove Assignment |
| Equipment Assignment | Edit Assignment, Remove Assignment |

---

## 5. Staff Overview

The **Staff Overview** provides a timeline view centered on people rather than projects. It shows each staff member's assignments, availability, and time off.

### 5.1 Staff List Panel

```
┌─ Staff Overview (18/20) ─── [Filter ▼] ─┐
│                                           │
│  ⠿ ▸ 🟢 Alice Anderson                  │
│         Research Scientist · 100%         │
│                                           │
│  ⠿ ▸ 🔴 Bob Brown                       │
│         Project Manager · 120% ⚠          │
│                                           │
│  ⠿ ▸ 🟢 Charlie Clark         80%       │
│         Lab Technician · 60%              │
│                                           │
│  ...                                      │
│                                           │
│  ▸ 🏖 Bank Holidays                       │
│  ▸ 🎉 Company Events                      │
└───────────────────────────────────────────┘
```

- **Count** — Shows `X/Y` where X is the filtered count and Y is total (e.g., "18/20")
- **Drag handle** (⠿) — Admins can drag a staff member onto the timeline to create an assignment
- **Status indicator**:
  - 🟢 **Green** — Available (within capacity)
  - 🔴 **Red** — Overallocated (assignments exceed capacity)
- **Part-time badge** — Shows maximum capacity if less than 100% (e.g., "80%")
- **Role and allocation** — Job title and current total allocation percentage

Click the **▸ arrow** to expand a staff member and see their details:

```
│  ▾ 🟢 Alice Anderson                     │
│       Research Scientist · 75%            │
│                                           │
│    🏖 Vacation: Mar 15 – Mar 22          │
│    🔄 Recurring: Mon, Wed (Childcare)    │
│    [+ Add vacation/time off]              │
│                                           │
│    📋 Project Alpha › Phase 1 (50%)      │
│    📋 Project Beta › Testing (25%)       │
```

### 5.2 Staff Timeline

The right side shows a horizontal timeline (same date range and zoom as the Gantt chart) with:

- **Assignment bars** — Colored bars for each project/phase assignment, stacked vertically when overlapping
- **Vacation blocks** — Shown in a distinct color/pattern
- **Workload indicator** — A thin bar at the bottom of each row showing the total utilization level
- **Bank holidays and company events** — Shown as expandable rows at the bottom

### 5.3 Assigning Staff

There are two ways to assign staff to projects:

**Method 1: Drag & Drop**
1. In the Staff Overview panel, grab a staff member by the drag handle (⠿).
2. Drag them onto a project bar, phase bar, or subphase bar on the Gantt timeline.
3. The Staff Assignment Modal opens pre-filled with the target.

**Method 2: Context Menu**
1. Right-click on a project, phase, or subphase in the Gantt chart.
2. Select **Assign Staff**.
3. The Staff Assignment Modal opens.

**Staff Assignment Modal:**

```
┌─ Assign Staff ────────────────────────────┐
│                                            │
│  Assigning to: Phase 1 (Project Alpha)     │
│                                            │
│  Staff Member                              │
│  ┌────────────────────────────────────┐    │
│  │ Alice Anderson ▼                   │    │
│  └────────────────────────────────────┘    │
│                                            │
│  Allocation                                │
│  ├────────────────●───────────┤  50%       │
│  5%                          100%          │
│                                            │
│  📌 This assignment uses the phase's       │
│     dates automatically.                   │
│                                            │
│       [ Cancel ]        [ Assign Staff ]   │
└────────────────────────────────────────────┘
```

- Select a **staff member** from the dropdown
- Set the **allocation percentage** using the slider (5–100% in 5% increments)
- A warning appears if the assignment would exceed the staff member's maximum capacity
- For **project-level** assignments, you can set custom start/end dates
- For **phase/subphase** assignments, dates are inherited automatically

### 5.4 Filtering Staff

Click the **Filter** dropdown in the Staff Overview header to filter by:

- **Role** — Multi-select checkboxes (e.g., Research Scientist, Lab Technician, Project Manager)
- **Skills** — Multi-select checkboxes with colored dots matching each skill's color
- **Clear All** — Reset all filters

The header shows a count like "12/20 staff" when filters are active.

---

## 6. Equipment View

The **Equipment View** provides a timeline view for tracking equipment availability and bookings.

### 6.1 Equipment List Panel

```
┌─ Equipment Overview (15) ─── [Filter ▼] ─┐
│                                            │
│  ⠿ 🟢 HPLC System 1                      │
│       Analytical · Available               │
│                                            │
│  ⠿ 🔴 Mass Spectrometer                  │
│       Analytical · In use                  │
│                                            │
│  ⠿ 🟢 PCR Thermocycler 1                 │
│       Molecular Biology · Available        │
│                                            │
│  ...                                       │
└────────────────────────────────────────────┘
```

- **Status indicator**:
  - 🟢 **Green** — Available
  - 🔴 **Red** — Currently booked
- **Equipment info** — Name, type, and current status
- **Drag handle** (⠿) — Admins can drag equipment onto the timeline to create a booking

### 6.2 Equipment Timeline

The timeline shows equipment bookings as horizontal bars, color-coded by project. Multiple bookings can overlap on the same equipment, displayed as stacked bars.

### 6.3 Booking Equipment

**Method 1: Drag & Drop**
1. Drag an equipment item from the panel onto a project/phase bar on the Gantt timeline.
2. The Equipment Assignment Modal opens.

**Method 2: Context Menu**
1. Right-click on a project, phase, or subphase.
2. Select **Assign Equipment**.

**Equipment Assignment Modal:**
- Select the **equipment item** from a dropdown
- Set **start and end dates** for the booking
- Click **Save** to confirm

### 6.4 Filtering Equipment

The filter dropdown in the Equipment panel header lets you filter by **equipment type** (e.g., Analytical, Molecular Biology, General Lab, Cell Culture, Processing, Safety). Use **Select All** or **Clear** buttons for quick selection.

---

## 7. Cross-Site View

The **Cross-Site View** provides a high-level overview of projects across all sites in your organization.

```
┌─ Cross-Site Overview ─────────────────────────────────┐
│                                                        │
│  📍 Winterthur (current)              3 projects       │
│  ──────────────────────────────────────────────────    │
│  ▸ Project Alpha        ▓▓▓▓▓▓▓▓▓▓░░░░               │
│  ▸ Project Beta         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓             │
│  ▸ Project Gamma            ▓▓▓▓▓▓░░░░░░              │
│                                                        │
│  📍 Frankfurt                         2 projects       │
│  ──────────────────────────────────────────────────    │
│  ▸ Confidential Project ▓▓▓▓▓▓▓▓▓▓▓▓░░               │
│  ▸ Confidential Project     ▓▓▓▓▓▓▓▓▓▓               │
│                                                        │
│  📍 Lyon                              1 project        │
│  ──────────────────────────────────────────────────    │
│  ▸ Confidential Project         ▓▓▓▓▓▓▓▓             │
│                                                        │
└────────────────────────────────────────────────────────┘
```

Key features:

- **Your site's projects** are fully visible with names and details
- **Other sites' projects** are shown as **"Confidential Project"** with masked customer info (`***`) for data privacy
- Projects from all sites appear on the same timeline for company-wide capacity planning
- The current site is highlighted with a special indicator

This view is designed for high-level resource planning without exposing sensitive project details across organizational boundaries.

---

## 8. Archived Projects

The **Archived View** displays projects that have been marked as archived (completed). It uses the same Gantt-style layout as the main view but only shows archived projects.

To archive a project:
1. Edit the project (click [Edit] or right-click → Edit).
2. Check the **Archived** checkbox at the bottom of the form.
3. Click **Save Changes**.

Archived projects are read-only for assignments — you can view and edit metadata, but new staff or equipment assignments cannot be created.

To **restore** a project, uncheck the Archived checkbox in the edit modal.

---

## 9. Vacation & Time-Off Management

Milestone tracks staff vacations and time off to provide accurate availability data.

### 9.1 Creating Vacations

1. In the Staff Overview, expand a staff member and click **[+ Add vacation/time off]**.
2. The Vacation Modal opens:

```
┌─ Add Vacation / Time Off ─────────────────┐
│                                            │
│  👤 Alice Anderson                         │
│     Research Scientist                     │
│                                            │
│  ┌────────────────────────────────────┐    │
│  │  Drop ICS file here or click to    │    │
│  │  browse                            │    │
│  └────────────────────────────────────┘    │
│                                            │
│  From           →          To              │
│  ┌────────────┐    ┌────────────┐          │
│  │ 2026-03-15 │    │ 2026-03-22 │  5 days  │
│  └────────────┘    └────────────┘          │
│                                            │
│  ☐ Recurring absence                       │
│                                            │
│  Description (optional)                    │
│  ┌────────────────────────────────────┐    │
│  │ Annual Leave                       │    │
│  └────────────────────────────────────┘    │
│                                            │
│   [ Cancel ]  [Save & Export ↓]  [ Save ]  │
└────────────────────────────────────────────┘
```

3. Set the **From** and **To** dates. The duration is calculated automatically.
4. Optionally add a **description** (e.g., "Annual Leave", "Conference").
5. Click **Save**.

Administrators can also create vacations for other staff members by selecting from the staff dropdown.

### 9.2 Recurring Absences

For regular part-time patterns (e.g., every Monday and Wednesday off for childcare):

1. Check **Recurring absence** in the Vacation Modal.
2. Select the days of the week:
   ```
   [Mon] [Tue] [Wed] [Thu] [Fri] [Sat] [Sun]
    ✓                  ✓
   ```
3. Selected days appear below (e.g., "Mon, Thu").
4. Click **Save**. The recurring pattern is shown with a 🔄 badge in the staff list.

### 9.3 Importing from Calendar (ICS)

You can import vacation dates directly from Outlook or other calendar applications:

1. In the Vacation Modal, drag-and-drop an **.ics file** onto the upload zone (or click to browse).
2. Milestone parses the calendar events and displays them as a selectable list:
   ```
   ☑ Annual Leave — Mar 15 – Mar 22 (5 days)
   ☑ Team Offsite — Apr 5 – Apr 7 (2 days)
   ☐ Optional Holiday — May 1 (1 day)

   [Select All]  [Deselect All]  [Cancel Import]
   ```
3. Check/uncheck individual events.
4. Click **Import** to create vacation entries for the selected events.

The importer handles UTF-16 encoding (common with SAP calendar exports).

### 9.4 Exporting to Outlook

When saving a vacation, click **Save & Export** (instead of just Save) to download an **.ics file** that you can open in Outlook or any calendar app to add the time-off to your personal calendar.

---

## 10. Import & Export

### 10.1 Importing Projects

Milestone can import project data from external tools:

1. Click **Import** in the project panel header (or use the Import button in the toolbar).
2. The Import Modal opens with a file drop zone.
3. Drag-and-drop or browse to select a file:
   - **CSV** — Comma-separated values with columns for project name, phases, dates, etc.
   - **XML** — Microsoft Project XML format (`.xml`)
   - **MPP/MPT/MPX** — Microsoft Project native format (requires Java on the server)
4. Milestone parses the file and shows a preview.
5. Click **Import Project** to create the project with all its phases and subphases.

After successful import, a summary is displayed:
```
  ✓ Import Complete!
  Project: "Facility Upgrade 2026"
  12 phases, 34 subphases created
```

> **Note:** MPP/MPT/MPX file import requires Java to be installed on the server. CSV and XML imports work without Java.

### 10.2 Exporting Projects

To export a project:

1. Open the project edit modal (click [Edit] or right-click → Edit).
2. At the bottom of the modal, two export buttons are available:
   - **CSV Export** (↓ icon) — Exports the project in CSV format compatible with Microsoft Project
   - **XML Export** (↓ icon) — Exports in Microsoft Project XML format

The exported file includes the project hierarchy (phases, subphases), dates, assignments, and custom column values.

---

## 11. Settings & Configuration

Access settings through the **gear icon** in the sidebar or through the user menu.

### 11.1 Instance Settings

- **Application Title** — The name displayed in the header and browser tab. Change this to your organization's preferred name (e.g., "ACME R&D Planner").

### 11.2 Branding & Themes

**Theme:**
- Choose from available **theme families** (different color schemes)
- Toggle between **light** and **dark mode** using the sun/moon icon in the header

**Custom Logos:**
- Upload a custom logo for **dark theme** (drag-and-drop or click to browse)
- Upload a custom logo for **light theme**
- Click **Remove** to revert to the default Milestone logo

### 11.3 Display Settings

- **Default View** — Set the initial timeline granularity: Week, Month, Quarter, or Year
- **Week Starts On** — Monday or Sunday
- **Show Weekends** — Toggle weekend columns on/off in the Gantt timeline
- **Auto-expand Projects** — Automatically expand all projects when loading the Gantt view

### 11.4 Site Management

Sites represent your organization's physical locations. Each site has:

- **Name** — The site identifier (e.g., "Winterthur", "Frankfurt")
- **City & Country** — Geographic location
- **Timezone** — Used for date calculations
- **Bank Holidays** — Site-specific non-working days (see [Section 11.9](#119-bank-holidays--company-events))

To manage sites:
1. Open the **Site Management** modal from the admin section in the sidebar.
2. Create, edit, or delete sites.
3. Use the **Site Selector** in the header to switch your active site.

Staff members can be assigned to one or more sites, and projects are visible based on the selected site.

### 11.5 User Management

Administrators can manage user accounts:

1. Open the **User Management** modal from the admin section.
2. Available actions:
   - **Create User** — Set email, name, job title, role, and site assignments
   - **Edit User** — Update any user field
   - **Delete User** — Remove a user account

**Roles:**
| Role | Permissions |
|------|-------------|
| **Admin** | Full access: manage users, sites, settings, projects, assignments |
| **Superuser** | Can manage projects and assignments, use What-If mode, but cannot manage users or settings |
| **User** | View-only access to projects and timelines; cannot modify data |

### 11.6 Skills Management

Skills are tags that can be assigned to staff members for resource planning:

1. Open the **Skills Management** modal.
2. Create skills with a **name**, **description**, and **color** (displayed as a colored dot).
3. Assign skills to staff members through the user management interface.

Skills appear in the Staff Overview filter dropdown, allowing you to quickly find staff with specific competencies (e.g., "HPLC", "Python", "Project Management").

### 11.7 Equipment Types Management

Equipment types categorize your equipment inventory:

1. Open the **Equipment Types** modal.
2. Create types like "Analytical", "Molecular Biology", "General Lab", "Cell Culture", "Processing", "Safety".
3. Equipment items are assigned a type during creation.

Types appear as filter options in the Equipment View.

### 11.8 Predefined Phases

Predefined phases are templates that appear when creating a new project:

1. Open the **Predefined Phases** modal.
2. Create phase templates with:
   - **Name** (e.g., "Requirements", "Design", "Development", "Testing", "Deployment")
   - **Color** — The bar color shown on the Gantt chart
   - **Active/Inactive** status — Only active phases appear when creating projects
3. Set the **order** to control the sequence in which phases appear.

When creating a new project, all active predefined phases are pre-selected. Click on any phase tag to include or exclude it.

### 11.9 Bank Holidays & Company Events

**Bank Holidays:**
- Configured per site (each site can have different holidays based on country/region)
- Can be **auto-refreshed** from an external API (Nager.Date) based on the site's country and region codes
- Can be **manually added** using the Bank Holiday modal
- Holidays appear as highlighted columns on the timeline and affect availability calculations

**Company Events:**
- Organization-wide events (e.g., company retreat, annual meeting)
- Created through the Company Event modal with a name, date, and description
- Appear as labeled rows on the timeline

**Custom Holidays:**
- For ad-hoc non-working days not covered by bank holidays
- Created with a date range and optional description

---

## 12. What-If Mode

**What-If Mode** lets administrators and superusers experiment with changes without affecting the live data.

### How It Works

1. Click the **What-If** toggle in the header.
2. The interface shows a visual indicator (body styling changes) to remind you that you're in planning mode.
3. Make any changes: move phases, reassign staff, adjust dates, etc.
4. These changes are **not saved to the database** — they exist only in your session.
5. When done:
   - **Commit changes** — Apply all What-If changes to the live database
   - **Discard changes** — Reload the original data, discarding all modifications

> **Note:** What-If mode changes are broadcast in real-time to other connected users via WebSocket, so collaborators can see your experimental planning. However, the changes are not persisted until committed.

---

## 13. Real-Time Collaboration

Milestone uses **WebSocket connections** to keep all users synchronized in real-time.

### Features

- **Live Updates** — When any user creates, edits, or deletes a project, phase, assignment, or other entity, the change is instantly reflected on all connected clients.
- **Online Users** — The header shows an indicator of who is currently connected. Click to see the list of online users with their avatars.
- **Presence Tracking** — The system tracks which project or site each user is currently viewing.
- **Conflict Prevention** — If two users try to edit the same entity simultaneously, the system helps prevent data loss.

### Visual Indicators

- A **dot** or **count badge** near the online users icon shows the number of active users
- User avatars (first letter of their name) are displayed in the online users panel

---

## 14. SSO (Microsoft Entra ID)

If your organization uses Microsoft Entra ID (formerly Azure AD), Milestone supports **Single Sign-On (SSO)**:

### For Users
- Click **Sign in with Microsoft** on the login screen
- Authenticate through your organization's Microsoft login
- You are automatically logged in and your account is created if it doesn't exist

### For Administrators
SSO is configured in the **SSO Configuration** modal (accessible from Settings):

- **Client ID** — The Application (client) ID from Azure AD app registration
- **Tenant ID** — Your Azure AD tenant ID
- **Client Secret** — The application secret
- **Redirect URI** — The callback URL (automatically generated)
- **Test Connection** — Verify the SSO configuration works

In multi-tenant mode, SSO can be configured per **Organization** (a group of tenants), allowing different companies to use their own identity provider.

---

## 15. Admin Portal (Multi-Tenant)

The **Admin Portal** is a separate interface for managing the multi-tenant SaaS deployment. Access it at `/admin`.

```
┌─ Admin Portal ──────────────────── admin@company.com [Logout] ─┐
│                                                                  │
│  [ Tenants ]  [ Organizations ]  [ Admin Users ]  [ Stats ]     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Tenant Management                    [ + Create Tenant ]  │  │
│  │                                                            │  │
│  │  Name          Slug          Status     Created   Actions  │  │
│  │  ─────────────────────────────────────────────────────────│  │
│  │  ACME Corp     acme-corp     Active     Jan 2026   ⚙ 🗑   │  │
│  │  Pharma Inc    pharma-inc    Active     Feb 2026   ⚙ 🗑   │  │
│  │  BioTech AG    biotech-ag    Pending    Feb 2026   ⚙ 🗑   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 15.1 Tenant Management

Each **tenant** represents a separate organization with its own isolated database.

- **Create Tenant** — Provision a new tenant database, create initial admin user, and generate credentials
- **View Details** — See tenant metadata, database info, and connection status
- **Show Credentials** — Display the generated email/password with copy-to-clipboard buttons
- **Edit** — Update tenant name, slug, or status
- **Delete** — Remove a tenant and its database (with confirmation)
- **Test** — Verify the tenant's database connection

### 15.2 Organization Management

**Organizations** group related tenants together and share SSO configuration:

- **Create Organization** — Set up a new organization with admin email
- **Assign Tenants** — Link tenants to an organization
- **Configure SSO** — Set up Microsoft Entra ID for the organization
- **Delete** — Remove the organization (tenants are unlinked, not deleted)

### 15.3 Admin Users

Admin users have access to the Admin Portal (not the tenant application):

- **Create Admin** — Add a new admin with email and role
- **Roles**: Regular admin (can manage assigned tenants) or Superadmin (full access)
- **Delete** — Remove admin access

The Admin Users tab is only visible to **superadmins**.

### 15.4 System Statistics

The Stats tab provides an overview of the deployment:

- Total tenants, users, and projects across the platform
- Database storage usage
- Active sessions
- API request metrics

---

## 16. Keyboard Shortcuts & Tips

| Shortcut | Action |
|----------|--------|
| **Shift + Hover** | Show tooltip with details for a phase or subphase |
| **Ctrl + Scroll** | Zoom the timeline in/out |
| **Click ▸ arrow** | Expand/collapse a project, phase, or staff member |
| **Right-click** | Open context menu with available actions |
| **Drag bar** | Move a phase/subphase to new dates |
| **Drag bar edge** | Resize a phase/subphase duration |
| **Drag staff/equipment** | Assign to a project bar on the timeline |

### Tips for Efficient Use

1. **Use the site selector** to focus on one location at a time — this filters projects, staff, and equipment to the relevant site.
2. **Zoom to fit** — Use the quarter (Q) or year (Y) view for a high-level overview, then switch to week (W) for detailed scheduling.
3. **Custom columns** are great for tracking project metadata like priority, budget codes, or risk levels without cluttering the main interface.
4. **Import ICS files** to quickly load team vacations from Outlook — much faster than manual entry.
5. **What-If mode** is invaluable for planning ahead — experiment with different resource allocations without disrupting the live schedule.
6. **Check the online users** indicator to see who else is viewing the same data — this helps coordinate changes in real-time.

---

*For technical support or to report issues, contact your system administrator.*
