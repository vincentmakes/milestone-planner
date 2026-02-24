# Milestone v91 - Organization-Level SSO Frontend Implementation

## Overview

This update implements the frontend for organization-level SSO support that was added in the backend. The admin panel now includes a full Organizations tab with SSO configuration and tenant management capabilities.

## New Features

### 1. Organizations Tab in Admin Panel
- New "Organizations" tab in the admin navigation
- View all organizations with tenant counts and SSO status
- Stats showing total organizations, SSO-enabled count, and total managed tenants

### 2. Organization Management
- Create new organizations with name, slug, and optional description
- Edit organization details
- Delete organizations (only when no tenants are assigned)

### 3. Organization SSO Configuration
Tabbed interface within organization details modal:
- **Details Tab**: View/edit organization name and description
- **SSO Configuration Tab**: 
  - Enable/disable SSO for the organization
  - Configure Microsoft Entra settings (Tenant ID, Client ID, Client Secret, Redirect URI)
  - User management settings (auto-create users, default role)
- **Tenants Tab**: 
  - View tenants assigned to the organization
  - Add/remove tenants
  - Configure group-based access requirements per tenant

### 4. Tenant Group Access Control
Per-tenant configuration within an organization:
- Set required Entra group IDs (comma-separated)
- Choose membership mode:
  - **Any**: User must be member of at least one required group (OR logic)
  - **All**: User must be member of all required groups (AND logic)

### 5. Updated Tenant Views
- TenantList now shows organization column with group count
- TenantDetailsModal shows organization membership and group requirements
- Visual indicators for SSO source (organization vs standalone)

## Files Added/Modified

### New Files
- `frontend/src/components/admin/OrganizationList.tsx` - Organizations list component
- `frontend/src/components/admin/modals/CreateOrganizationModal.tsx` - Create organization modal
- `frontend/src/components/admin/modals/OrganizationDetailsModal.tsx` - Organization details with tabbed interface

### Modified Files
- `frontend/src/api/endpoints/admin.ts` - Added organization types and API functions
- `frontend/src/api/client.ts` - Added `apiPatch` function
- `frontend/src/api/index.ts` - Export `apiPatch`
- `frontend/src/stores/adminStore.ts` - Added organizations state and actions
- `frontend/src/components/admin/AdminDashboard.tsx` - Added Organizations tab
- `frontend/src/components/admin/TenantList.tsx` - Added organization column
- `frontend/src/components/admin/modals/TenantDetailsModal.tsx` - Added organization section
- `frontend/src/components/admin/index.ts` - Export new components

## API Endpoints Used

### Organization Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/organizations` | List all organizations |
| POST | `/api/admin/organizations` | Create organization |
| GET | `/api/admin/organizations/{id}` | Get organization details |
| PUT | `/api/admin/organizations/{id}` | Update organization |
| DELETE | `/api/admin/organizations/{id}` | Delete organization |

### Organization SSO Configuration
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/organizations/{id}/sso` | Get SSO config |
| PUT | `/api/admin/organizations/{id}/sso` | Update SSO config |
| DELETE | `/api/admin/organizations/{id}/sso` | Delete SSO config |

### Tenant Organization Assignment
| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/api/admin/organizations/{org_id}/tenants/{tenant_id}` | Add tenant to org |
| DELETE | `/api/admin/organizations/{org_id}/tenants/{tenant_id}` | Remove tenant from org |
| PATCH | `/api/admin/organizations/tenants/{tenant_id}/groups` | Update group config |

## Building

```bash
cd frontend
npm install
npm run build
```

The build output is in `frontend/dist/` and should be copied to `public/`.

## Usage

1. Go to Admin Portal (`/admin/`)
2. Click "Organizations" tab
3. Create an organization with "Create Organization" button
4. Click on organization name to open details modal
5. Configure SSO in the "SSO Configuration" tab
6. Add tenants in the "Tenants" tab
7. Configure group requirements for each tenant

## Notes

- Organizations allow multiple tenants to share a single Microsoft Entra SSO configuration
- Group-based access control is per-tenant, not per-organization
- Tenants can be standalone (not in an organization) with their own SSO config
- When deleting an organization, tenants are disassociated but not deleted
- The backend migration adds `organization_id`, `required_group_ids`, and `group_membership_mode` columns to the tenants table
