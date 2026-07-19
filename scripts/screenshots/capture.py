"""
Headless Playwright capture for MkDocs single-user screenshots.

Outputs PNGs at 1440x900 to docs/assets/screenshots/.

Prerequisites
-------------
1. Demo instance running at http://localhost:8486/t/demo/ — see scripts/screenshots/README.md.
2. seed_extras.sql applied so custom columns, vacations, and bank holidays are populated:
       docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \\
         < scripts/screenshots/seed_extras.sql
3. Playwright Python in a venv:
       python3 -m venv /tmp/pw-venv
       /tmp/pw-venv/bin/pip install playwright
       /tmp/pw-venv/bin/playwright install chromium

Usage
-----
    /tmp/pw-venv/bin/python scripts/screenshots/capture.py            # all shots
    /tmp/pw-venv/bin/python scripts/screenshots/capture.py main staff # subset
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

URL = "http://localhost:8486/t/demo/"
EMAIL = "admin@demo.local"
PASSWORD = "demo1234"
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "assets" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(msg, flush=True)


def login(page: Page) -> None:
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() > 0:
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"]', PASSWORD)
        page.click('button:has-text("Sign In")')
        page.wait_for_load_state("networkidle")
    try:
        page.click('button[aria-label="Switch to light mode"]', timeout=2000)
    except Exception:
        pass
    page.wait_for_timeout(1500)


def use_quarter_view(page: Page) -> None:
    page.locator('header').get_by_role('button', name='Q', exact=True).click()
    page.wait_for_timeout(400)


def click_today(page: Page) -> None:
    page.click('button:has-text("Today")')
    page.wait_for_timeout(600)


def expand_all_projects(page: Page) -> None:
    for _ in range(3):
        buttons = page.locator('button[title="Expand one level"]').all()
        if not buttons:
            break
        for btn in buttons:
            try:
                # Short timeout: rows re-render as levels expand, so buttons
                # from this snapshot can go stale — skip them fast.
                btn.click(timeout=2000)
            except Exception:
                pass
        page.wait_for_timeout(400)


def go_to_gantt(page: Page) -> None:
    nav = page.locator('aside, nav').first
    try:
        nav.get_by_role('button', name='Gantt Chart', exact=True).click()
    except Exception:
        page.click('button:has-text("Gantt Chart")')
    page.wait_for_timeout(400)


def open_panel(page: Page, label: str) -> None:
    page.click('button[title="Toggle overview panels"]')
    page.wait_for_timeout(400)
    page.locator('header').get_by_role('button', name=label, exact=True).click()
    page.wait_for_timeout(1500)


def open_sidebar_item(page: Page, label: str) -> None:
    """Click a sidebar navigation or admin-section item by its visible label."""
    nav = page.locator('aside, nav').first
    try:
        nav.get_by_role('button', name=label, exact=True).click()
    except Exception:
        page.click(f'button:has-text("{label}")')
    page.wait_for_timeout(800)


def right_click_row(page: Page, name: str) -> None:
    """Right-click a project-panel row by its visible text to open the context menu."""
    row = page.get_by_text(name, exact=True).first
    row.scroll_into_view_if_needed()
    row.click(button="right")
    page.wait_for_timeout(400)


def open_project_modal(page: Page, project: str = "Bioprocess Scale-Up") -> None:
    """Open the Edit Project modal for a project via the context menu."""
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    right_click_row(page, project)
    page.get_by_text("Edit Project", exact=True).click()
    page.wait_for_timeout(800)


# --------------------------- shots ---------------------------


def shot_gantt_main(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    expand_all_projects(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "gantt-main.png"))
    log("[done] gantt-main.png")
    page.close()


def shot_gantt_with_staff(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    expand_all_projects(page)
    click_today(page)
    open_panel(page, "Staff")
    page.screenshot(path=str(OUT / "gantt-with-staff-panel.png"))
    log("[done] gantt-with-staff-panel.png")
    # Panel visibility persists in localStorage — close it again so later
    # shots (modals, What-If) capture a clean Gantt.
    open_panel(page, "Staff")
    page.close()


def shot_gantt_with_equipment(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    expand_all_projects(page)
    click_today(page)
    open_panel(page, "Equipment")
    page.screenshot(path=str(OUT / "gantt-with-equipment-panel.png"))
    log("[done] gantt-with-equipment-panel.png")
    # Panel visibility persists in localStorage — close it again so later
    # shots (modals, What-If) capture a clean Gantt.
    open_panel(page, "Equipment")
    page.close()


def shot_what_if_active(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    expand_all_projects(page)
    click_today(page)
    page.click('button:has-text("What If")')
    page.wait_for_timeout(800)
    bar = page.locator('.gantt-bar').first
    box = bar.bounding_box()
    if box:
        sx = box['x'] + box['width'] / 2
        sy = box['y'] + box['height'] / 2
        page.mouse.move(sx, sy)
        page.mouse.down()
        for i in range(1, 9):
            page.mouse.move(sx + i * 8, sy, steps=2)
        page.mouse.up()
        page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "what-if-active.png"))
    log("[done] what-if-active.png")
    page.close()


def shot_vacations_view(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    nav = page.locator('aside, nav').first
    try:
        nav.get_by_role('button', name='Staff Overview', exact=True).click()
    except Exception:
        page.click('button:has-text("Staff Overview")')
    page.wait_for_timeout(1500)
    use_quarter_view(page)
    click_today(page)
    page.wait_for_timeout(500)
    try:
        page.locator('button[title="Expand one level"]').first.click()
        page.wait_for_timeout(800)
    except Exception:
        pass
    page.screenshot(path=str(OUT / "vacations-view.png"))
    log("[done] vacations-view.png")
    page.close()


def shot_custom_columns(context: BrowserContext) -> None:
    """Crop of the project panel showing populated custom column cells."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    expand_all_projects(page)
    page.wait_for_timeout(800)
    page.screenshot(
        path=str(OUT / "custom-columns.png"),
        clip={"x": 0, "y": 0, "width": 800, "height": 600},
    )
    log("[done] custom-columns.png")
    page.close()


def shot_login(context: BrowserContext) -> None:
    """Unauthenticated login page (light theme pinned via localStorage).

    Uses a fresh, cookie-less context — the shared context is already logged
    in by earlier shots and would render the app instead of the login form.
    """
    fresh = context.browser.new_context(
        viewport={"width": 1440, "height": 900}, locale="en-US"
    )
    page = fresh.new_page()
    page.add_init_script("localStorage.setItem('milestone_theme', 'light')")
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "login.png"))
    log("[done] login.png")
    fresh.close()


def shot_project_modal(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    open_project_modal(page)
    page.screenshot(path=str(OUT / "project-modal.png"))
    log("[done] project-modal.png")
    page.close()


def shot_project_tags(context: BrowserContext) -> None:
    """Tag picker inside the project modal, with the tag edit/color panel open."""
    page = context.new_page()
    login(page)
    open_project_modal(page)
    page.click('input[placeholder="Find or create a tag..."]')
    page.wait_for_timeout(400)
    page.locator('button[title="Edit tag"]').first.click()
    page.wait_for_timeout(400)
    # Bring the edit panel's color palette fully into the modal's scroll view.
    try:
        page.get_by_role("button", name="Done", exact=True).scroll_into_view_if_needed()
        page.wait_for_timeout(300)
    except Exception:
        pass
    page.screenshot(path=str(OUT / "project-tags.png"))
    log("[done] project-tags.png")
    page.close()


def shot_assign_staff_modal(context: BrowserContext) -> None:
    """Assign Staff modal (project level) with a member selected so the
    allocation slider is populated."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    right_click_row(page, "Catalyst Optimization")
    page.get_by_text("Assign Staff", exact=True).click()
    page.wait_for_timeout(600)
    # The page has other <select>s (custom-column list cells) — target the
    # modal's staff dropdown via its placeholder option.
    staff_select = page.locator('select:has(option:text("Select staff member"))')
    staff_select.select_option(index=1)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "assign-staff-modal.png"))
    log("[done] assign-staff-modal.png")
    page.close()


def _sidebar_modal_shot(context: BrowserContext, label: str, outfile: str) -> None:
    page = context.new_page()
    login(page)
    open_sidebar_item(page, label)
    page.screenshot(path=str(OUT / outfile))
    log(f"[done] {outfile}")
    page.close()


def shot_settings_modal(context: BrowserContext) -> None:
    _sidebar_modal_shot(context, "Settings", "settings-modal.png")


def shot_manage_sites(context: BrowserContext) -> None:
    _sidebar_modal_shot(context, "Manage Sites", "manage-sites.png")


def shot_manage_users(context: BrowserContext) -> None:
    _sidebar_modal_shot(context, "Manage Users", "manage-users.png")


def shot_manage_equipment(context: BrowserContext) -> None:
    _sidebar_modal_shot(context, "Manage Equipment", "manage-equipment.png")


def shot_predefined_phases(context: BrowserContext) -> None:
    _sidebar_modal_shot(context, "Predefined Phases", "predefined-phases.png")


def shot_skills_mgmt(context: BrowserContext) -> None:
    """Skills management, reached from within Manage Users."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Manage Users")
    page.click('button:has-text("Manage Skills")')
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "skills-mgmt.png"))
    log("[done] skills-mgmt.png")
    page.close()


def shot_import_modal(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    page.click('button[title="Import Project"]')
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "import-modal.png"))
    log("[done] import-modal.png")
    page.close()


def shot_staff_overview(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Staff Overview")
    page.wait_for_timeout(1000)
    use_quarter_view(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "staff-overview.png"))
    log("[done] staff-overview.png")
    page.close()


def shot_cross_site(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Cross-Site")
    page.wait_for_timeout(1500)
    use_quarter_view(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "cross-site.png"))
    log("[done] cross-site.png")
    page.close()


def shot_equipment_view(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Equipment")
    page.wait_for_timeout(1000)
    use_quarter_view(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "equipment-view.png"))
    log("[done] equipment-view.png")
    page.close()


def shot_equipment_block_modal(context: BrowserContext) -> None:
    """Block Equipment modal, reached from an expanded equipment row."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Equipment")
    page.wait_for_timeout(1000)
    page.get_by_text("HPLC System 1", exact=True).first.click()
    page.wait_for_timeout(400)
    page.get_by_text("Add block (maintenance / defect)", exact=True).click()
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "equipment-block-modal.png"))
    log("[done] equipment-block-modal.png")
    page.close()


def scroll_timeline_right(page: Page, dx: int = 500) -> None:
    """Scroll the timeline pane horizontally (dependency chains often extend
    to the right of the today-centered viewport)."""
    page.mouse.move(1150, 400)
    page.mouse.wheel(dx, 0)
    page.wait_for_timeout(600)


def shot_gantt_dependencies(context: BrowserContext) -> None:
    """Dependency arrows between the Catalyst Optimization phases."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    expand_all_projects(page)
    click_today(page)
    scroll_timeline_right(page)
    page.screenshot(path=str(OUT / "gantt-dependencies.png"))
    log("[done] gantt-dependencies.png")
    page.close()


def shot_gantt_critical_path(context: BrowserContext) -> None:
    """Critical path highlighted on Catalyst Optimization (seeded FS chain)."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    expand_all_projects(page)
    click_today(page)
    page.locator('button[title="Show Critical Path"]').nth(1).click()
    page.wait_for_timeout(800)
    scroll_timeline_right(page)
    page.screenshot(path=str(OUT / "gantt-critical-path.png"))
    log("[done] gantt-critical-path.png")
    page.close()


def shot_gantt_context_menu(context: BrowserContext) -> None:
    """Right-click context menu on a project row — no item is clicked."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    right_click_row(page, "Bioprocess Scale-Up")
    page.screenshot(path=str(OUT / "gantt-context-menu.png"))
    log("[done] gantt-context-menu.png")
    page.close()


def shot_manage_columns_modal(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    page.click('button[title="Manage Custom Columns"]')
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "manage-columns-modal.png"))
    log("[done] manage-columns-modal.png")
    page.close()


def shot_column_filter(context: BrowserContext) -> None:
    """Custom-column filter dropdown on the Priority header."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    page.locator('button[title="Filter column"]').first.click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "column-filter-dropdown.png"))
    log("[done] column-filter-dropdown.png")
    page.close()


def shot_vacation_modal(context: BrowserContext) -> None:
    """Vacation modal from an expanded staff row (capture only — never saved)."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Staff Overview")
    page.wait_for_timeout(1000)
    # Staff rows expand by clicking the row itself.
    page.get_by_text("Alice Anderson", exact=True).first.click()
    page.wait_for_timeout(600)
    page.get_by_text("Add vacation / time off", exact=True).first.click()
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "vacation-modal.png"))
    log("[done] vacation-modal.png")
    page.close()


def shot_staff_filter(context: BrowserContext) -> None:
    """Role/skills filter dropdown in the Staff Overview header."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Staff Overview")
    page.wait_for_timeout(1000)
    page.get_by_role("button", name="Filter", exact=True).click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "staff-filter-dropdown.png"))
    log("[done] staff-filter-dropdown.png")
    page.close()


def shot_bank_holidays(context: BrowserContext) -> None:
    """Staff Overview with the Bank Holidays row expanded."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Staff Overview")
    page.wait_for_timeout(1000)
    use_quarter_view(page)
    click_today(page)
    page.get_by_text("Bank Holidays", exact=True).first.click()
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "bank-holidays.png"))
    log("[done] bank-holidays.png")
    page.close()


def shot_archived_view(context: BrowserContext) -> None:
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Archived")
    page.wait_for_timeout(1200)
    use_quarter_view(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "archived-view.png"))
    log("[done] archived-view.png")
    page.close()


def shot_site_modal(context: BrowserContext) -> None:
    """Site edit modal (country/region codes) from Manage Sites."""
    page = context.new_page()
    login(page)
    open_sidebar_item(page, "Manage Sites")
    page.locator('button[title="Edit site"]').first.click()
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "site-edit-modal.png"))
    log("[done] site-edit-modal.png")
    page.close()


def shot_equipment_assign_modal(context: BrowserContext) -> None:
    """Assign Equipment modal with a piece of equipment selected."""
    page = context.new_page()
    login(page)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    right_click_row(page, "Bioprocess Scale-Up")
    page.get_by_text("Assign Equipment", exact=True).click()
    page.wait_for_timeout(600)
    equip_select = page.locator('select:has(option:text("Select equipment"))')
    equip_select.select_option(index=1)
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / "equipment-assignment-modal.png"))
    log("[done] equipment-assignment-modal.png")
    page.close()


def shot_dark_theme(context: BrowserContext) -> None:
    """Gantt in the dark theme. Fresh context so the shared (light) context
    is untouched; must run last anyway to keep run order deterministic."""
    fresh = context.browser.new_context(
        viewport={"width": 1440, "height": 900}, locale="en-US"
    )
    page = fresh.new_page()
    page.add_init_script("localStorage.setItem('milestone_theme', 'dark')")
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() > 0:
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"]', PASSWORD)
        page.get_by_role("button", name="Sign In", exact=True).click()
        page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    go_to_gantt(page)
    use_quarter_view(page)
    click_today(page)
    expand_all_projects(page)
    click_today(page)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "dark-theme.png"))
    log("[done] dark-theme.png")
    fresh.close()


# --------------------------- main ---------------------------

# Ordered: shot key -> capture function. Order matters for reproducibility
# (independent shots, but a stable run order keeps logs comparable).
TARGETS = {
    "main": shot_gantt_main,
    "staff": shot_gantt_with_staff,
    "equipment": shot_gantt_with_equipment,
    "whatif": shot_what_if_active,
    "vacations": shot_vacations_view,
    "columns": shot_custom_columns,
    "login": shot_login,
    "project-modal": shot_project_modal,
    "tags": shot_project_tags,
    "assign-staff": shot_assign_staff_modal,
    "settings": shot_settings_modal,
    "sites": shot_manage_sites,
    "users": shot_manage_users,
    "equipment-mgmt": shot_manage_equipment,
    "phases": shot_predefined_phases,
    "skills": shot_skills_mgmt,
    "import": shot_import_modal,
    "staff-view": shot_staff_overview,
    "crosssite": shot_cross_site,
    "equipment-view": shot_equipment_view,
    "block-modal": shot_equipment_block_modal,
    "dependencies": shot_gantt_dependencies,
    "critical-path": shot_gantt_critical_path,
    "context-menu": shot_gantt_context_menu,
    "manage-columns": shot_manage_columns_modal,
    "column-filter": shot_column_filter,
    "vacation-modal": shot_vacation_modal,
    "staff-filter": shot_staff_filter,
    "bank-holidays": shot_bank_holidays,
    "archived": shot_archived_view,
    "site-modal": shot_site_modal,
    "equipment-assign": shot_equipment_assign_modal,
    "dark-theme": shot_dark_theme,  # keep last: the only intentionally dark shot
}


def main() -> None:
    args = set(sys.argv[1:])
    unknown = args - set(TARGETS)
    if unknown:
        log(f"Unknown shot keys: {', '.join(sorted(unknown))}")
        log(f"Available: {', '.join(TARGETS)}")
        sys.exit(1)
    if not args:
        args = set(TARGETS.keys())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # locale pinned so date formatting is deterministic regardless of the
        # host's locale (a POSIX host locale even crashes Intl.DateTimeFormat).
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US")
        for key, shot in TARGETS.items():
            if key in args:
                try:
                    shot(context)
                except Exception as e:  # pragma: no cover
                    log(f"[ERROR] {key}: {e}")
        browser.close()


if __name__ == "__main__":
    main()
