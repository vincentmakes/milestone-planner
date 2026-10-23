# Dashboards

**Dashboards** turn the plan into numbers and charts: how many weeks people are booked on each project, how a team's time splits between confirmed and unconfirmed work, how many projects run at each site. A dashboard is a page of **widgets** — KPI tiles, bar, line and pie charts and tables — that anyone allowed can open, and that people who build dashboards can arrange, duplicate and share.

Open it from **Dashboards** in the sidebar, just below My Work. The entry needs the **Dashboards** permission (Superuser and User by default, see [Roles & Permissions](settings.md#roles-permissions)).

![The Overview dashboard: four KPI tiles across the top, then booked weeks per project, booked time per team by Confirmed, booked weeks per month and projects by site](../assets/screenshots/dashboards.png){ loading=lazy }

## Opening a Dashboard

The **Dashboard** picker at the top lists every dashboard you may open, in this order:

| Label | Which dashboards |
|-------|------------------|
| **Default** | The **Overview**, shared with everyone |
| **Mine** | The dashboards you built, whoever you shared them with |
| **Shared by** *name* | Dashboards someone shared with one of your roles (*Shared with me* when the owner's account is gone) |
| **Everyone** | Dashboards shared with everyone who can open the view |

Type in the picker's search box to find one by name. Milestone remembers the last dashboard you opened and shows it next time.

**Refresh** recomputes every widget. You rarely need it: when someone changes a project, a booking, a team or a project field, the open dashboard updates by itself within a couple of seconds.

### Everyone Sees Their Own Numbers

A dashboard is a set of questions, not a copy of the answers. Each viewer gets the answers for the **sites they can see**: a colleague who works only at Frankfurt sees Frankfurt figures on the same Overview where an administrator sees every site. Archived projects are left out unless a widget asks for them.

A widget can need a permission you do not hold — a breakdown by **person** needs the **Staff overview** permission, a widget that includes **archived projects** needs **Archived projects**. Such a widget shows *This widget needs the Staff view permission* (or *the Archived view permission*) in place of its chart; the rest of the dashboard works as usual.

## The Overview

Every Milestone instance starts with the **Overview**, shared with everyone:

| Widget | What it shows |
|--------|---------------|
| **Active projects** | Projects whose dates touch this year |
| **Confirmed share** | The share of those projects that are confirmed |
| **Booked weeks this year** | Planned person-weeks on all projects this year |
| **People booked** | How many different people have a booking this year |
| **Booked weeks per project** | The ten projects with the most booked weeks this year |
| **Booked time per team by Confirmed** | Each team's booked time this year, split 100 % between confirmed and unconfirmed projects |
| **Booked weeks per month** | Booked weeks in each of the last 12 months |
| **Projects by site** | This year's projects per site |

People who build dashboards can **Duplicate** it and adapt the copy. Only an administrator can change or delete the Overview itself; once deleted, it does not come back.

## What the Numbers Mean

Booked time is **planned** time — what the bookings in the Gantt chart say, not hours recorded afterwards.

- **Booked days** — for each booking, its allocation times the **working days** it covers inside the period. A booking at 50 % over two working weeks counts 5 days
- **Booked weeks** — booked days divided by 5
- A **working day** is Monday to Friday, except the [bank holidays](settings.md#bank-holidays) of the **project's site**. Absences and site closures do not reduce booked time
- A booking on a phase or subphase counts only inside its card's dates; a booking on the whole project counts over its own dates. Someone booked both on the project and on one of its phases counts twice, as on the [Staff overview](staff-management.md)
- **Bookings waiting for approval are not counted** until they are approved
- **Bookings** counts booking rows, **People booked** counts different people, **Projects** and **Phases** count projects and phases whose dates touch the period (in every month, quarter or year they touch, when broken down by period)
- **Project weeks** and **Phase weeks** are the working weeks a project or phase lasts inside the period, whoever is booked; **Project volume** adds up the projects' *Volume* field
- A breakdown by **Team** uses the teams of the booked person at the project's site (someone in two teams counts in both; *No team* otherwise). **Project team** uses the teams the project belongs to
- A project with two tags, or two items of a multi-select field, appears under each of them; the total counts it once. The widget then says so under its chart
- Empty values have their own bucket: *No customer*, *No manager*, *No tag*, *No team*, *No site*, *No phase* (a booking on the whole project), *Not set* (a project field)

## Building a Dashboard

Building dashboards needs the **Manage dashboards** permission (Superuser by default). The buttons beside the picker:

| Button | What it does |
|--------|--------------|
| **New** | Asks for a name, an optional description and who sees it, then opens the empty dashboard for editing |
| **Duplicate** | Copies the open dashboard as a private *Copy of …* and opens it for editing |
| **Edit** | Lets you move, resize, add, change and remove widgets (your own dashboards; administrators: any) |
| **Share…** | Changes the name, the description and who sees it |
| **Delete** | Deletes the dashboard and its widgets, after a confirmation |

### Editing the Layout

While you edit, the toolbar shows **Add widget**, **Save** and **Cancel**, and the status beside the picker reads *Editing* — *Editing — unsaved changes* once you change something.

- **Move** a widget by dragging its header
- **Resize** it from its bottom-right corner
- The **edit** and **remove** icons in a widget's header open it in the widget editor or take it off the dashboard

Nothing is saved until you click **Save**. **Cancel**, choosing another dashboard or leaving the view asks before discarding your changes. A dashboard holds up to 50 widgets.

On a phone (640 px wide or less) dashboards are view-only.

### The Widget Editor

**Add widget** (or a widget's edit icon) opens the editor. A **live preview** on the right shows the real result as you change the settings.

![The widget editor: a bar chart of booked weeks by person this year, with the live preview beside the form](../assets/screenshots/dashboard-builder.png){ loading=lazy }

1. **Kind** — KPI, Bar, Line, Pie or Table
2. **Title**
3. **Measure** — Booked days, Booked weeks, Bookings, People booked, Projects, Project weeks, Project volume, Phases or Phase weeks
4. **Dimension 1** and **Dimension 2** — how to break the measure down: Site, Team, Project team, Person, Project, Project manager, Customer, Confirmed, Tag, Phase, any dropdown or toggle **project field**, or Period (by year, quarter, month or week). Only the dimensions that make sense for the measure are offered; a pie takes one dimension, a KPI at most one
5. **Filters** — limit the widget to some sites, teams, project teams, people, projects, tags, field items, confirmed or unconfirmed projects; include archived projects or show only them
6. **Period** — This year, Last year, This quarter, Last quarter, Last 12 months, All time, or a custom range
7. **Percent of** — show shares instead of amounts: of the **total**, or within each value of the **first dimension** (each bar adds up to 100 %)
8. **Top N** — keep the largest values and group the rest as *Other*
9. **Options** — stacked or 100 % bars and their orientation, a legend for lines and pies, the number format. A KPI showing a share needs a **Bucket**: the value whose share it shows (for example *Confirmed*)

If the combination cannot be answered, the preview says why in plain words, and **Add widget** / **Save Changes** waits until you fix it. A new widget is placed below the others; arrange it on the grid afterwards.

### Sharing

**Share…** (and **New**) set who sees a dashboard:

| Visibility | Who sees it |
|------------|-------------|
| **Private** | You (and administrators) |
| **Shared with roles** | Everyone holding one of the roles you tick, if their role has the **Dashboards** permission |
| **Everyone** | Everyone who can open the Dashboards view |

A custom role does not get the **Dashboards** permission automatically: an administrator allows it in [Settings → Roles](settings.md#roles-permissions) before the role's members see dashboards shared with them. If every role a dashboard was shared with is deleted, it reads *Shared with no role* and only you and the administrators see it.

Only the owner (or an administrator) can change or delete a dashboard. When two people edit the same dashboard at once, the last one to save wins.

## Limits

- A period covers at most **five years**. **All time** runs from the first to the last project in scope; when that is longer than five years it ends at most a year from today and the widget says *Period cut to five years*
- Bank holidays count only for the years an administrator **loaded** for the site (see [Bank Holidays](settings.md#bank-holidays)); in a year without holidays every weekday is a working day
- Bookings waiting for approval are never counted
- "Today" and "this year" follow the server's date (UTC)
- The **People** filter lists the people of the site selected in the header, although a dashboard covers every site you can see

## What-If Mode

The Dashboards entry is disabled while a [What-If plan](what-if-planning.md) is open: dashboards always show the saved plan. Apply or discard the plan first.
