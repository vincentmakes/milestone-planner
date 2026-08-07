# Milestone Planner

**Milestone Planner** is a web-based R&D project management platform designed for multi-site organizations. It provides interactive Gantt charts, staff allocation with capacity tracking, equipment booking, and real-time collaboration.

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
| [Developer Guide](developer-guide/architecture.md) | Architecture, local development, API reference |

## Try It Out

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

Launch a fully configured development environment in your browser with PostgreSQL, Python, Node.js, and a pre-seeded demo tenant. The backend starts automatically on port 8485 — the demo is usable as soon as the Codespace is ready.

### Demo Credentials

| Access | URL | Email | Password |
|--------|-----|-------|----------|
| **Admin Portal** | `/admin/` | `admin@demo.local` | `demo1234` |
| **Demo Tenant** | `/t/demo/` | `admin@demo.local` | `demo1234` |

The demo tenant includes 2 sites, 4 projects with phases and staff assignments, 8 staff members with skills, and 8 equipment items. All staff accounts use password `demo1234`.
