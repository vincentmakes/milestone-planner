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
                btn.click()
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


# --------------------------- main ---------------------------


def main() -> None:
    args = set(sys.argv[1:])
    targets = {
        "main": shot_gantt_main,
        "staff": shot_gantt_with_staff,
        "equipment": shot_gantt_with_equipment,
        "whatif": shot_what_if_active,
        "vacations": shot_vacations_view,
        "columns": shot_custom_columns,
    }
    if not args:
        args = set(targets.keys())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        for key in ["main", "staff", "equipment", "whatif", "vacations", "columns"]:
            if key in args:
                try:
                    targets[key](context)
                except Exception as e:  # pragma: no cover
                    log(f"[ERROR] {key}: {e}")
        browser.close()


if __name__ == "__main__":
    main()
