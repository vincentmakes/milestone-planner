# Milestone Multi-Tenant Architecture

## Overview

This update adds multi-tenant support to Milestone, allowing you to serve multiple organizations from a single application instance while maintaining complete data isolation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Milestone Server                          │
├─────────────────────────────────────────────────────────────────┤
│  /admin/*           │  Admin Panel (System-wide management)     │
│  /api/admin/*       │  Admin API (Tenant CRUD, provisioning)    │
│  /t/{slug}/*        │  Tenant Routes (Per-tenant application)   │
│  /*                 │  Default/Single-tenant routes             │
├─────────────────────────────────────────────────────────────────┤
│                     PostgreSQL Server                            │
├──────────────────┬──────────────────┬──────────────────────────┤
│ milestone_admin  │ milestone_acme   │ milestone_techcorp  │ ...│
│ (Master DB)      │ (Tenant DB)      │ (Tenant DB)         │    │
└──────────────────┴──────────────────┴──────────────────────────┘
```

## Components

### New Files

| File | Purpose |
|------|---------|
| `lib/masterDb.js` | Master database connection, tenant registry, encryption |
| `lib/tenantConnectionManager.js` | Per-tenant database connection pooling |
| `lib/tenantResolver.js` | URL-based tenant resolution middleware |
| `lib/tenantProvisioner.js` | Automated database/user creation |
| `lib/adminRoutes.js` | Admin API endpoints |
| `lib/tenantIntegration.js` | Integration helper for server.js |
| `public/admin/index.html` | Admin panel UI |

### Database Schema

**Master Database (`milestone_admin`):**
- `tenants` - Tenant registry with slug, database name, status, plan
- `tenant_credentials` - Encrypted database passwords
- `tenant_audit_log` - Audit trail for tenant operations
- `admin_users` - System administrators
- `admin_sessions` - Admin session storage

**Tenant Databases:**
- Identical schema to current Milestone
- Completely isolated from other tenants

## Configuration

### Environment Variables

```env
# Enable multi-tenant mode
MULTI_TENANT=true

# Master database (stores tenant registry)
MASTER_DB_NAME=milestone_admin
MASTER_DB_USER=postgres
MASTER_DB_PASSWORD=secure_password

# PostgreSQL admin (for creating tenant databases)
PG_ADMIN_USER=postgres
PG_ADMIN_PASSWORD=admin_password

# Encryption key for tenant credentials
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TENANT_ENCRYPTION_KEY=your_32_byte_hex_key
```

## Usage

### Admin Panel

Access: `http://your-server:8484/admin/`

Default credentials:
- Email: `admin@milestone.app`
- Password: `admin123` (change immediately!)

### Creating a Tenant

1. Log into Admin Panel
2. Click "New Tenant"
3. Fill in:
   - **Name**: Organization display name
   - **Slug**: URL identifier (lowercase, hyphens allowed)
   - **Admin Email**: First user's email
   - **Plan**: free/standard/enterprise
4. Click "Create Tenant"
5. Click "Provision" to create the database

### Accessing Tenants

Tenants are accessed via URL prefix:
```
http://your-server:8484/t/{tenant-slug}/
```

Example:
```
http://your-server:8484/t/acme-corp/
http://your-server:8484/t/techcorp/
```

### Admin API

```bash
# List tenants
GET /api/admin/tenants

# Create tenant
POST /api/admin/tenants
{
  "name": "Acme Corporation",
  "slug": "acme",
  "adminEmail": "admin@acme.com",
  "companyName": "Acme Corp Inc.",
  "plan": "standard"
}

# Provision database
POST /api/admin/tenants/{id}/provision

# Update status (suspend/activate)
PUT /api/admin/tenants/{id}/status
{ "status": "suspended" }

# Get system stats
GET /api/admin/stats
```

## Security Features

1. **Database Isolation**: Each tenant has its own PostgreSQL database
2. **Encrypted Credentials**: Tenant DB passwords encrypted with AES-256-GCM
3. **Connection Pooling**: Automatic pool management with idle cleanup
4. **Audit Logging**: All tenant operations logged
5. **Status Controls**: Suspend/archive tenants without deleting data

## Backward Compatibility

The existing single-tenant setup continues to work:
- Set `MULTI_TENANT=false` (default)
- All routes work at `/` as before
- No migration required

## Deployment Notes

### PostgreSQL Setup

For multi-tenant mode, your PostgreSQL user needs privileges to create databases:

```sql
-- Run as postgres superuser
ALTER USER milestone_admin CREATEDB;
```

Or use a separate admin user for provisioning:
```env
PG_ADMIN_USER=postgres
PG_ADMIN_PASSWORD=your_postgres_password
```

### Docker Compose

The updated `docker-compose.yml` includes all multi-tenant environment variables.

## What's NOT Included Yet

This is Phase 1. Future phases will add:

1. **Data Migration** - Script to migrate existing data into a tenant
2. **Subdomain Routing** - `acme.milestone.app` instead of `/t/acme/`
3. **Custom Domains** - `planning.acme.com` 
4. **Automated Password Rotation** - Schedule credential rotation
5. **Usage Metrics** - Track per-tenant resource usage

## Troubleshooting

### "Tenant not found"
- Check the slug is correct (lowercase, no special characters)
- Verify tenant status is "active" in admin panel

### "Database connection failed"
- Check tenant database was provisioned
- Verify credentials in master DB match actual PostgreSQL user

### "Permission denied creating database"
- Ensure PG_ADMIN_USER has CREATEDB privilege
- Check PG_ADMIN_PASSWORD is correct

## File Changes Summary

**Modified:**
- `server.js` - Added multi-tenant middleware, changed `db` to `req.db`
- `.env.example` - Added multi-tenant configuration
- `docker-compose.yml` - Added multi-tenant environment variables

**Added:**
- `lib/` directory with 6 new modules
- `public/admin/` directory with admin UI
