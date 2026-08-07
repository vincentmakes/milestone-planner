# Admin Guide Overview

This guide covers installation, configuration, and administration of Milestone Planner, including multi-tenant SaaS deployment.

## Deployment Modes

Milestone supports two deployment modes:

### Single-Tenant

A single organization with one database. Simplest setup — suitable for on-premises or small-team deployments.

- One PostgreSQL database holds all data
- No master database or admin portal needed
- Users are managed within the application

### Multi-Tenant (SaaS)

Multiple organizations, each with an isolated database. Includes a centralized admin portal for tenant and organization management.

- **Master database** (`milestone_admin`) stores tenant registry, admin users, organizations, and SSO config
- **Tenant databases** (`milestone_<slug>`) hold per-tenant isolated data
- Admin portal at `/admin/` for tenant lifecycle management
- Organization-level SSO with Microsoft Entra ID
- Automatic database provisioning for new tenants

## System Requirements

| Component | Requirement |
|-----------|-------------|
| **OS** | Linux (Ubuntu 22.04+ recommended), macOS, or Windows with Docker |
| **Docker** | Docker Engine 24+ and Docker Compose v2 |
| **PostgreSQL** | 15+ (included in `docker-compose.fresh.yml`) |
| **Memory** | 1 GB minimum (2 GB+ recommended for multi-tenant) |
| **Disk** | 500 MB for application + database storage |
| **Java** | JRE 11+ (for MPP file import; included in Docker image) |
| **Node.js** | 24 (for frontend development only; not required for production) |

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │          Port 8485                   │
                    │        FastAPI Backend               │
                    ├─────────────────────────────────────┤
                    │  /api/*          → API endpoints    │
                    │  /t/{slug}/api/* → Tenant API       │
                    │  /admin/         → Admin SPA        │
                    │  /t/{slug}/*     → Tenant SPA       │
                    │  /*              → Main SPA         │
                    │  /health         → Health check     │
                    └──────────┬──────────────────────────┘
                               │
                    ┌──────────┴──────────────────────────┐
                    │          PostgreSQL 15+              │
                    ├─────────────────────────────────────┤
                    │  milestone_admin  (master DB)       │
                    │  milestone_acme   (tenant DB)       │
                    │  milestone_pharma (tenant DB)       │
                    │  ...                                │
                    └─────────────────────────────────────┘
```

The FastAPI backend serves both the API and the pre-built React frontend as static files. All authentication is session-based with secure cookies.
