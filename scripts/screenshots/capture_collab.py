"""
Headless Playwright capture for multi-user collaboration screenshots.

User A (admin) is captured. User B (Bob Brown) drives presence + edit events
through a separate browser context — the WebSocket events fire naturally so
User A's UI (online avatars, activity feed toast) reacts the same way it
would in production.

Outputs PNGs to docs/assets/screenshots/.

Prerequisites
-------------
- Demo instance running, seeded via app.scripts.seed_demo (provides
  admin@demo.local + bob.brown@demo.local with password 'demo1234').
- See capture.py header for venv setup.

Usage
-----
    /tmp/pw-venv/bin/python scripts/screenshots/capture_collab.py
"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

URL = "http://localhost:8486/t/demo/"
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "assets" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(msg, flush=True)


def login(page: Page, email: str, password: str) -> None:
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() > 0:
        page.fill('input[type="email"]', email)
        page.fill('input[type="password"]', password)
        page.click('button:has-text("Sign In")')
        page.wait_for_load_state("networkidle")
    try:
        page.click('button[aria-label="Switch to light mode"]', timeout=2000)
    except Exception:
        pass
    page.wait_for_timeout(1500)


def quarter_today_expand(page: Page) -> None:
    page.click('button:has-text("Gantt Chart")')
    page.wait_for_timeout(400)
    page.locator('header').get_by_role('button', name='Q', exact=True).click()
    page.wait_for_timeout(400)
    page.click('button:has-text("Today")')
    page.wait_for_timeout(600)
    for _ in range(3):
        btns = page.locator('button[title="Expand one level"]').all()
        if not btns:
            break
        for b in btns:
            try:
                b.click()
            except Exception:
                pass
        page.wait_for_timeout(400)
    page.click('button:has-text("Today")')
    page.wait_for_timeout(600)


def _hover_online_users(page: Page, enter: bool) -> None:
    events = (
        ['mouseenter', 'mouseover', 'pointerenter', 'pointerover']
        if enter
        else ['mouseleave', 'mouseout', 'pointerleave', 'pointerout']
    )
    page.evaluate(
        """(events) => {
          const dot = document.querySelector('[class*=statusDot]');
          if (!dot) return;
          const c = dot.closest('[class*=container]') || dot.parentElement;
          events.forEach(ev =>
            c.dispatchEvent(new MouseEvent(ev, {bubbles:true, view:window})));
        }""",
        events,
    )
    page.wait_for_timeout(500)


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_a = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx_b = browser.new_context(viewport={"width": 1280, "height": 720})

        page_a = ctx_a.new_page()
        page_b = ctx_b.new_page()

        log("Login A (admin)…")
        login(page_a, "admin@demo.local", "demo1234")
        quarter_today_expand(page_a)

        log("Login B (Bob)…")
        login(page_b, "bob.brown@demo.local", "demo1234")
        page_b.wait_for_timeout(2000)

        # WebSocket needs a moment to sync onlineUsers state in A.
        page_a.wait_for_timeout(2500)

        # Shot 1 — header crop with both avatars + green status dot.
        page_a.screenshot(
            path=str(OUT / "collab-online-users.png"),
            clip={"x": 1100, "y": 0, "width": 340, "height": 60},
        )
        log("[done] collab-online-users.png")

        # Shot 2 — hover the OnlineUsers indicator to reveal the dropdown.
        _hover_online_users(page_a, enter=True)
        page_a.wait_for_timeout(800)
        page_a.screenshot(
            path=str(OUT / "collab-presence-viewing.png"),
            clip={"x": 1100, "y": 0, "width": 340, "height": 220},
        )
        log("[done] collab-presence-viewing.png")
        _hover_online_users(page_a, enter=False)
        page_a.wait_for_timeout(500)

        # Shot 3 — User B edits a phase via API; activity feed toast appears.
        upd = ctx_b.request.put(
            f"{URL}api/phases/8",
            data=json.dumps({"start_date": "2026-07-22", "end_date": "2026-09-02"}),
            headers={"Content-Type": "application/json"},
        )
        log(f"  PUT /api/phases/8 status={upd.status}")
        page_a.wait_for_timeout(900)
        page_a.screenshot(path=str(OUT / "collab-activity-feed.png"))
        log("[done] collab-activity-feed.png")

        ctx_a.close()
        ctx_b.close()
        browser.close()


if __name__ == "__main__":
    main()
