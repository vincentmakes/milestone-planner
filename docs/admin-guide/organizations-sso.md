# Organizations & SSO

## Organizations

Organizations group related tenants together and provide shared SSO configuration. For example, a company with separate Milestone instances for different departments can share a single Microsoft Entra ID setup.

### Creating an Organization

1. Go to the **Organizations** tab in the admin portal
2. Click **Create Organization**
3. Enter the organization name and admin email
4. Click **Create**

### Assigning Tenants

After creating an organization, assign tenants to it:

1. Edit the organization
2. Select tenants from the dropdown
3. Save changes

Tenants inherit the organization's SSO configuration automatically.

## Microsoft Entra ID (SSO)

Milestone supports enterprise SSO through Microsoft Entra ID (formerly Azure AD).

### Prerequisites

- An Azure AD tenant
- An App Registration in Azure AD
- A client secret for the App Registration
- The redirect URI configured in Azure AD

### Azure AD App Registration

1. Go to [Azure Portal](https://portal.azure.com) > Azure Active Directory > App Registrations
2. Click **New Registration**
3. Set the redirect URI to: `https://your-domain.com/t/{slug}/api/auth/callback`
4. Under **Certificates & secrets**, create a new client secret
5. Note the **Application (client) ID**, **Directory (tenant) ID**, and the client secret value

### Configuring SSO in Milestone

**Per-Organization (Multi-Tenant):**

1. In the admin portal, go to the **Organizations** tab
2. Click the SSO configure button on the organization
3. Enter:
   - **Client ID** — Application (client) ID from Azure
   - **Tenant ID** — Directory (tenant) ID from Azure
   - **Client Secret** — The secret value
4. Save configuration

All tenants in the organization will share this SSO setup.

**Per-Instance (Single-Tenant):**

Configure SSO in the Settings modal within the application, or set environment variables:

```bash
SSO_ENABLED=true
SSO_CLIENT_ID=your-azure-app-client-id
SSO_CLIENT_SECRET=your-azure-app-client-secret
SSO_TENANT_ID=your-azure-tenant-id
SSO_REDIRECT_URI=https://your-domain.com/api/auth/callback
```

### SSO Login Flow

1. User clicks **Sign in with Microsoft** on the login screen
2. Redirected to Microsoft's login page
3. After authentication, redirected back to Milestone with an authorization code
4. Milestone exchanges the code for tokens and creates/updates the user session
5. If the user doesn't exist in Milestone, their account is automatically created

### Testing SSO

Use the **Test Connection** button in the SSO configuration modal to verify the setup works before rolling it out to users.
