"""
The pool-of-one journey: one user's day over the main reads and writes,
against a server started with a pool of ONE connection:

    DB_POOL_SIZE=1 DB_POOL_MAX_OVERFLOW=0 DB_POOL_TIMEOUT=5 uvicorn app.main:app ...

A request that needs two connections at once -- a second session opened
while the request's own still holds its connection -- cannot get the second
one there: it waits ``DB_POOL_TIMEOUT`` and fails (a 500), or, where the
second session's failure is swallowed (the audit row, the change
notifications), it stalls for those 5 s. So the journey fails on any non-2xx
**and** on any request slower than ``--max-seconds`` (default 3 s, below the
5 s timeout), deterministically, without any concurrency. Run the server
with its log captured and grep it for ``QueuePool limit`` and ``could not be
written`` too (the CI job does).

The journey creates its own project and removes everything it creates.

    python scripts/loadtest/journey.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from datetime import date, timedelta
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    DEFAULT_BASE_URL,
    Recorder,
    login,
    make_client,
    report,
    verdict,
)


class Journey:
    def __init__(self, client: Any, recorder: Recorder):
        self.client = client
        self.recorder = recorder

    async def call(self, method: str, url: str, body: Any = None) -> Any:
        response = await self.recorder.request(self.client, method, url, json=body)
        if response is None or not response.is_success:
            raise JourneyFailed(f"{method} {url}")
        return response.json() if response.content else None

    async def get(self, url: str) -> Any:
        return await self.call("GET", url)

    async def run(self) -> None:
        await login(self.client, ADMIN_EMAIL, ADMIN_PASSWORD, self.recorder)
        await self.get("/api/auth/me")

        # The startup reads (loadAllData).
        sites = await self.get("/api/sites")
        if not sites:
            raise JourneyFailed("the workspace has no site")
        staff = await self.get("/api/staff?includeAllSites=true")
        equipment = await self.get("/api/equipment?includeAllSites=true")
        # A site with equipment and staff when there is one (the project's).
        staffed = {s.get("site_id") for s in staff}
        with_both = [e["site_id"] for e in equipment if e.get("site_id") in staffed]
        site_id = min(with_both) if with_both else min(s["id"] for s in sites)
        await self.get(f"/api/staff?siteId={site_id}")
        await self.get(f"/api/equipment?siteId={site_id}")
        await self.get("/api/equipment-blocks")
        await self.get("/api/vacations")
        for url in (
            "/api/settings",
            "/api/skills",
            "/api/tags",
            "/api/project-fields",
            "/api/teams",
            "/api/absence-types",
            f"/api/sites/{site_id}/holidays",
            f"/api/sites/{site_id}/events",
            f"/api/custom-columns/with-values?site_id={site_id}",
            "/api/projects?archived=all&limit=200",
            "/api/projects/details?archived=all&limit=200",
        ):
            await self.get(url)

        # A project of our own, with a phase, a subphase and bookings.
        start = date(2027, 3, 1)
        project = await self.call(
            "POST",
            "/api/projects",
            {
                "name": f"Pool-of-one journey {int(time.time())}",
                "site_id": site_id,
                "start_date": str(start),
                "end_date": str(start + timedelta(days=60)),
                "phases": [
                    {
                        "type": "Design",
                        "start_date": str(start),
                        "end_date": str(start + timedelta(days=13)),
                    }
                ],
            },
        )
        pid = project["id"]
        try:
            await self.with_project(pid, site_id, start, staff, equipment)
        finally:
            await self.call("DELETE", f"/api/projects/{pid}")

        await self.get("/api/approval-requests")
        await self.get("/api/notifications")
        await self.get("/api/notifications/unread-count")
        await self.call("PUT", "/api/notifications/read-all")

    async def with_project(
        self, pid: int, site_id: int, start: date, staff: list, equipment: list
    ) -> None:
        detail = await self.get(f"/api/projects/{pid}")
        await self.call("PUT", f"/api/projects/{pid}", {"notes": "pool of one"})
        phase = await self.call(
            "POST",
            f"/api/projects/{pid}/phases",
            {
                "type": "Build",
                "start_date": str(start + timedelta(days=14)),
                "end_date": str(start + timedelta(days=27)),
            },
        )
        first_phase = detail["phases"][0]["id"]
        phase_id = phase["id"]
        await self.call(
            "PUT",
            f"/api/phases/{phase_id}",
            {
                "start_date": str(start + timedelta(days=15)),
                "end_date": str(start + timedelta(days=28)),
            },
        )
        await self.call(
            "PUT", f"/api/projects/{pid}/phases/reorder", {"phase_order": [phase_id, first_phase]}
        )
        sub = await self.call(
            "POST",
            f"/api/phases/{phase_id}/subphases",
            {
                "name": "Step 1",
                "start_date": str(start + timedelta(days=15)),
                "end_date": str(start + timedelta(days=18)),
                "project_id": pid,
            },
        )
        sub_id = sub["id"]
        await self.call("PUT", f"/api/subphases/{sub_id}", {"name": "Step 1 (renamed)"})

        person = next((s["id"] for s in staff if s.get("site_id") == site_id), staff[0]["id"])
        booking = await self.call(
            "POST",
            f"/api/phases/{phase_id}/staff",
            {"staff_id": person, "project_id": pid, "allocation": 50},
        )
        await self.call(
            "PUT",
            f"/api/phase-staff/{booking['id']}",
            {"allocation": 60},
        )
        sub_booking = await self.call(
            "POST",
            f"/api/subphases/{sub_id}/staff",
            {"staff_id": person, "project_id": pid, "allocation": 20},
        )
        project_booking = await self.call(
            "POST",
            f"/api/projects/{pid}/staff",
            {
                "staff_id": person,
                "allocation": 10,
                "start_date": str(start),
                "end_date": str(start + timedelta(days=5)),
            },
        )
        await self.get(f"/api/staff/{person}")
        await self.get(f"/api/staff/{person}/assignments")

        # Equipment: a booking, an edit, a block, availability.
        instrument = next(
            (e["id"] for e in equipment if e.get("site_id") == site_id),
            equipment[0]["id"] if equipment else None,
        )
        if instrument is not None:
            booking_eq = await self.call(
                "POST",
                f"/api/projects/{pid}/equipment",
                {
                    "equipment_id": instrument,
                    "start_date": str(start + timedelta(days=40)),
                    "end_date": str(start + timedelta(days=41)),
                },
            )
            await self.call(
                "PUT",
                f"/api/equipment-assignments/{booking_eq['id']}",
                {"note": "pool of one"},
            )
            await self.get(f"/api/equipment/{instrument}")
            await self.get(
                f"/api/equipment/{instrument}/availability"
                f"?startDate={start}&endDate={start + timedelta(days=30)}"
            )
            await self.call("PUT", f"/api/equipment/{instrument}", {"description": "journey"})
            block = await self.call(
                "POST",
                "/api/equipment-blocks",
                {
                    "equipment_id": instrument,
                    "start_date": str(start + timedelta(days=50)),
                    "end_date": str(start + timedelta(days=51)),
                },
            )
            await self.call(
                "PUT", f"/api/equipment-blocks/{block['id']}", {"reason": "calibration"}
            )
            await self.call("DELETE", f"/api/equipment-blocks/{block['id']}")
            await self.call("DELETE", f"/api/equipment-assignments/{booking_eq['id']}")

        # An absence.
        absence = await self.call(
            "POST",
            "/api/vacations",
            {
                "staff_id": person,
                "start_date": str(start + timedelta(days=70)),
                "end_date": str(start + timedelta(days=71)),
            },
        )
        await self.call("PUT", f"/api/vacations/{absence['id']}", {"description": "Journey"})
        await self.call("DELETE", f"/api/vacations/{absence['id']}")

        # Kanban: counts, people, a status change, a comment thread.
        await self.get(f"/api/kanban/projects/{pid}/comment-counts")
        await self.get(f"/api/kanban/sites/{site_id}/comment-counts")
        await self.get(f"/api/kanban/sites/{site_id}/mentionable-users")
        await self.call(
            "PUT", f"/api/kanban/cards/phase/{phase_id}/status", {"status": "in_progress"}
        )
        await self.call(
            "POST", f"/api/kanban/cards/phase/{phase_id}/comments", {"body": "Pool of one"}
        )
        await self.get(f"/api/kanban/cards/phase/{phase_id}/comments")

        # Dashboards: the list and the data of the first one.
        dashboards = await self.get("/api/dashboards")
        listed = dashboards.get("items", dashboards) if isinstance(dashboards, dict) else dashboards
        if listed:
            await self.call("POST", f"/api/dashboards/{listed[0]['id']}/data", {})

        # The removals, then the whole tree again.
        await self.call("DELETE", f"/api/assignments/{project_booking['id']}")
        await self.call("DELETE", f"/api/subphase-staff/{sub_booking['id']}")
        await self.call("DELETE", f"/api/phase-staff/{booking['id']}")
        await self.call("DELETE", f"/api/subphases/{sub_id}")
        await self.call("DELETE", f"/api/phases/{phase_id}")
        await self.get(f"/api/projects/{pid}")
        await self.get("/api/projects/details?archived=all&limit=200")


class JourneyFailed(Exception):
    pass


async def main_async(args: Any) -> int:
    recorder = Recorder()
    started = time.perf_counter()
    failed = None
    async with make_client(args.base_url, 1, timeout=60) as client:
        try:
            await Journey(client, recorder).run()
        except JourneyFailed as exc:
            failed = str(exc)
    report(recorder, f"pool-of-one journey ({time.perf_counter() - started:.1f}s)")
    problems = verdict(recorder, max_seconds=args.max_seconds)
    if failed:
        problems.insert(0, f"stopped at {failed}")
    if problems:
        print("\nFAIL: " + "; ".join(problems))
        return 1
    print("\nPASS")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--max-seconds", type=float, default=3.0)
    args = parser.parse_args()
    if not ADMIN_PASSWORD:
        raise SystemExit(
            "Set LOADTEST_ADMIN_PASSWORD (and LOADTEST_ADMIN_EMAIL if not the default)"
        )
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
