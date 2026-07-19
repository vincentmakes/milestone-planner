"""
Headless Playwright capture for MkDocs admin-portal screenshots.

Captures the /admin portal (master DB) plus the two shots that need
organization state: the tenant audit log and the read-only tenant SSO form
shown while organization SSO takes precedence.

Outputs PNGs at 1440x900 to docs/assets/screenshots/.

Prerequisites
-------------
1. Demo instance running at http://localhost:8486/ with the demo tenant
   seeded — see scripts/screenshots/README.md.
2. A known admin-portal password: set INIT_ADMIN_PASSWORD before the first
   boot (docker-compose.fresh.yml passes it through), and export the same
   value when running this script.

Usage
-----
    INIT_ADMIN_PASSWORD=... /tmp/pw-venv/bin/python scripts/screenshots/capture_admin.py

What it does
------------
1. Logs into /admin as admin@milestone.local.
2. Seeds master-DB demo state over the admin HTTP API (idempotent):
   organization "Demo Holding" with a dummy-but-complete Entra SSO config,
   attaches the demo tenant, and runs one suspend -> activate cycle so the
   tenant audit log has entries. The API encrypts the SSO secret server-side,
   so no raw SQL against the master DB is needed.
3. Captures the four portal tabs + the tenant details modal (Recent Activity).
4. In a second browser context, logs into the demo tenant and captures the
   read-only SSO Configuration modal ("managed by your organization").
5. Detaches the demo tenant from the organization again — otherwise the
   tenant login page grows a "Sign in with Microsoft" button, which would
   contaminate login.png on the next capture.py run.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

BASE = "http://localhost:8486"
ADMIN_URL = f"{BASE}/admin/"
ADMIN_EMAIL = os.environ.get("INIT_ADMIN_EMAIL", "admin@milestone.local")
ADMIN_PASSWORD = os.environ.get("INIT_ADMIN_PASSWORD", "")
TENANT_URL = f"{BASE}/t/demo/"
TENANT_EMAIL = "admin@demo.local"
TENANT_PASSWORD = "demo1234"

ORG_NAME = "Demo Holding"
ORG_SLUG = "demo-holding"

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "assets" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(msg, flush=True)


def admin_login(page: Page) -> None:
    page.goto(ADMIN_URL)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() > 0:
        page.fill('input[type="email"]', ADMIN_EMAIL)
        page.fill('input[type="password"]', ADMIN_PASSWORD)
        page.click('button:has-text("Sign In")')
        page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)


def tenant_login(page: Page) -> None:
    page.goto(TENANT_URL)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() > 0:
        page.fill('input[type="email"]', TENANT_EMAIL)
        page.fill('input[type="password"]', TENANT_PASSWORD)
        # Exact match: with organization SSO active the login page also has a
        # "Sign in with Microsoft" button, which a substring match would hit.
        page.get_by_role("button", name="Sign In", exact=True).click()
        page.wait_for_load_state("networkidle")
    try:
        page.click('button[aria-label="Switch to light mode"]', timeout=2000)
    except Exception:
        pass
    page.wait_for_timeout(1000)


# --------------------------- API seed / cleanup ---------------------------


def api(context: BrowserContext, method: str, path: str, **kwargs):
    """Call the admin API using the browser context's session cookie."""
    resp = getattr(context.request, method)(f"{BASE}{path}", **kwargs)
    if not resp.ok:
        raise RuntimeError(f"{method.upper()} {path} -> {resp.status}: {resp.text()[:200]}")
    return resp.json() if resp.text() else None


def seed_master_state(context: BrowserContext) -> tuple[str, str]:
    """Ensure org + org SSO + attached demo tenant + audit entries.

    Returns (org_id, tenant_id).
    """
    orgs = api(context, "get", "/api/admin/organizations")
    org = next((o for o in orgs if o.get("slug") == ORG_SLUG), None)
    if org is None:
        org = api(
            context,
            "post",
            "/api/admin/organizations",
            data={
                "name": ORG_NAME,
                "slug": ORG_SLUG,
                "description": "Demo organization for documentation screenshots",
            },
        )
        log(f"[seed] created organization {ORG_NAME}")
    org_id = org["id"]

    # Dummy-but-complete Entra config; the API encrypts the secret at rest.
    api(
        context,
        "put",
        f"/api/admin/organizations/{org_id}/sso",
        data={
            "enabled": True,
            "entraTenantId": "11111111-2222-3333-4444-555555555555",
            "clientId": "66666666-7777-8888-9999-aaaaaaaaaaaa",
            "clientSecret": "demo-secret-for-screenshots-only",
            "redirectUri": f"{BASE}/api/auth/sso/callback",
            "autoCreateUsers": True,
            "defaultUserRole": "user",
        },
    )
    log("[seed] organization SSO configured")

    tenants = api(context, "get", "/api/admin/tenants")
    tenant = next(t for t in tenants if t.get("slug") == "demo")
    tenant_id = tenant["id"]

    api(context, "put", f"/api/admin/organizations/{org_id}/tenants/{tenant_id}")
    log("[seed] demo tenant attached to organization")

    # One suspend -> activate cycle gives the audit log deterministic entries.
    api(context, "put", f"/api/admin/tenants/{tenant_id}/status", data={"status": "suspended"})
    api(context, "put", f"/api/admin/tenants/{tenant_id}/status", data={"status": "active"})
    log("[seed] audit entries created (suspend/activate cycle)")

    return org_id, tenant_id


def cleanup_master_state(context: BrowserContext) -> None:
    """Detach the demo tenant from the screenshot organization (looked up by
    slug, so this works even after a partial seed)."""
    orgs = api(context, "get", "/api/admin/organizations")
    org = next((o for o in orgs if o.get("slug") == ORG_SLUG), None)
    tenants = api(context, "get", "/api/admin/tenants")
    tenant = next((t for t in tenants if t.get("slug") == "demo"), None)
    if org and tenant and tenant.get("organization_id") == org["id"]:
        api(context, "delete", f"/api/admin/organizations/{org['id']}/tenants/{tenant['id']}")
        log("[cleanup] demo tenant detached from organization")
    else:
        log("[cleanup] nothing to detach")


# --------------------------- shots ---------------------------


def open_tab(page: Page, label: str) -> None:
    page.locator("nav").get_by_role("button", name=label).click()
    page.wait_for_timeout(800)


def shot_admin_tabs(page: Page) -> None:
    open_tab(page, "Tenants")
    page.screenshot(path=str(OUT / "admin-tenants.png"))
    log("[done] admin-tenants.png")

    open_tab(page, "Organizations")
    page.screenshot(path=str(OUT / "admin-organizations.png"))
    log("[done] admin-organizations.png")

    open_tab(page, "Admin Users")
    page.screenshot(path=str(OUT / "admin-users.png"))
    log("[done] admin-users.png")

    open_tab(page, "System Stats")
    page.screenshot(path=str(OUT / "admin-stats.png"))
    log("[done] admin-stats.png")


def shot_create_tenant_modal(page: Page) -> None:
    """Create Tenant modal (capture only — never submitted)."""
    open_tab(page, "Tenants")
    page.get_by_role("button", name="Create Tenant").click()
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "admin-create-tenant-modal.png"))
    log("[done] admin-create-tenant-modal.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)


def shot_org_sso_config(page: Page) -> None:
    """Editable organization SSO configuration in the admin portal."""
    open_tab(page, "Organizations")
    page.locator('button[title="View Details & Configure SSO"]').first.click()
    page.wait_for_timeout(1000)
    page.get_by_role("button", name="SSO Configuration").click()
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "admin-org-sso-config.png"))
    log("[done] admin-org-sso-config.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)


def shot_tenant_audit(page: Page) -> None:
    open_tab(page, "Tenants")
    page.locator('button[title="View Details"]').first.click()
    page.wait_for_timeout(1000)
    try:
        page.get_by_text("Recent Activity", exact=True).scroll_into_view_if_needed()
        page.wait_for_timeout(400)
    except Exception:
        pass
    page.screenshot(path=str(OUT / "admin-tenant-audit.png"))
    log("[done] admin-tenant-audit.png")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)


def shot_sso_org_precedence(context: BrowserContext) -> None:
    """Tenant-side SSO Configuration modal in its read-only state while
    organization SSO takes precedence."""
    page = context.new_page()
    tenant_login(page)
    nav = page.locator("aside, nav").first
    try:
        nav.get_by_role("button", name="SSO Configuration", exact=True).click()
    except Exception:
        page.click('button:has-text("SSO Configuration")')
    page.wait_for_timeout(1000)
    page.screenshot(path=str(OUT / "sso-org-precedence.png"))
    log("[done] sso-org-precedence.png")
    page.close()


# --------------------------- main ---------------------------


def main() -> None:
    if not ADMIN_PASSWORD:
        log("ERROR: set INIT_ADMIN_PASSWORD to the admin portal password.")
        sys.exit(1)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        admin_ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US")
        admin_page = admin_ctx.new_page()
        admin_page.add_init_script("localStorage.setItem('milestone_theme', 'light')")
        admin_login(admin_page)

        try:
            seed_master_state(admin_ctx)

            # Reload so the freshly seeded org/audit data is in the UI.
            admin_page.reload()
            admin_page.wait_for_load_state("networkidle")
            admin_page.wait_for_timeout(1000)

            shot_admin_tabs(admin_page)
            shot_create_tenant_modal(admin_page)
            shot_org_sso_config(admin_page)
            shot_tenant_audit(admin_page)

            tenant_ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US")
            shot_sso_org_precedence(tenant_ctx)
            tenant_ctx.close()
        finally:
            # Runs even after a partial seed — an attached tenant would leave
            # a "Sign in with Microsoft" button on the login page.
            cleanup_master_state(admin_ctx)
        browser.close()


if __name__ == "__main__":
    main()
