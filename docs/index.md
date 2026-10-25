# Milestone Planner

**Milestone Planner** is a web-based R&D project management platform designed for multi-site organizations. It provides interactive Gantt charts, staff allocation with capacity tracking, equipment booking, and real-time collaboration. It is open source under the [Functional Source License 1.1 with MIT Future License (FSL-1.1-MIT)](https://github.com/vincentmakes/milestone-planner/blob/main/LICENSE): free to self-host, use internally and modify, and each release becomes MIT two years after publication.

!!! info inline end "Current release"
    See the [Release Notes](release-notes.md) for the current version and full history.

## Key Features

- **Interactive Gantt Charts** — Drag-and-drop timeline with phases, subphases, and completion tracking
- **Staff Allocation** — Percentage-based capacity management with overallocation warnings
- **Equipment Booking** — Reserve lab instruments and equipment across projects
- **Multi-Site Support** — Manage resources across geographic locations with cross-site visibility
- **What-If Planning** — Test scheduling scenarios without affecting live data
- **Real-Time Collaboration** — WebSocket-powered live updates across all connected clients
- **Import/Export** — Exchange data with Microsoft Project (CSV, XML, MPP)
- **Microsoft Entra SSO** — Enterprise single sign-on with group-based access control
- **Multi-Tenant SaaS** — Isolated databases per organization with centralized admin portal

## Quick Links

| Section | Description |
|---------|-------------|
| [User Guide](user-guide/getting-started.md) | Day-to-day usage: Gantt charts, staff, equipment, vacations |
| [Admin Guide](admin-guide/overview.md) | Installation, multi-tenant management, SSO, database operations |
| [Developer Guide](developer-guide/architecture.md) | Architecture, local development, API reference, codebase reference |

## Try It Out

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

Launch a fully configured development environment in your browser with PostgreSQL, Python, Node.js, and a pre-seeded demo tenant. The backend starts automatically on port 8485 — the demo is usable as soon as the Codespace is ready.

### Demo Credentials

| Access | URL | Email | Password |
|--------|-----|-------|----------|
| **Admin Portal** | `/admin/` | `admin@demo.local` | `demo1234` |
| **Demo Tenant** | `/t/demo/` | `admin@demo.local` | `demo1234` |

The demo tenant includes 2 sites (Winterthur, Frankfurt), 5 projects (one archived) with phases, nested subphases, dependencies, staff and equipment bookings, 9 people (incl. a part-time member, a project manager and an inactive account) with skills, 8 equipment items, tag groups, custom columns, bank holidays, a site closure, absences of every type, Kanban comments and notifications. All staff accounts use password `demo1234`.
