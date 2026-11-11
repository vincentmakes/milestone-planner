"""
Simulate browsers loading and using the app the way the frontend does.

Each simulated browser signs in as a different seeded user (so the visible-
sites scoping runs per user) and then:

1. **Startup** -- ``loadAllData`` (``frontend/src/hooks/useDataLoader.ts``):
   every request of its ``Promise.all`` at once (sites, staff and equipment of
   all sites, equipment blocks, absences, settings, skills, tags, project
   fields, teams, absence types; the equipment ones only with
   ``views.equipment``), then the first visible site's holidays, events and
   custom columns one after the other, then the projects -- with ``--projects
   bulk`` through ``GET /api/projects/details`` (2.5.1), with ``--projects
   detail`` the old way (the list, then one ``GET /api/projects/{id}`` per
   project, all at once). A writer edits a project during the startup.
2. **Write burst** (unless ``--no-burst``) -- an admin makes the writes users
   make all day (project update, phase move, staff booking, equipment
   booking, equipment edit, person edit, absence, and the deletes); after each
   one every other browser refetches the slices the change event reloads
   (``slicesForEntity`` in ``frontend/src/contexts/wsSlices.ts``, refetched as
   ``WebSocketContext.tsx`` does), staff and equipment included.

``--connections`` caps each browser's parallel connections (6 = HTTP/1.1);
``--unlimited-browsers`` adds browsers without a cap (HTTP/2 behind a proxy).

The report has one line per endpoint (requests, non-2xx, median, p95, max).
Exit status 1 on any non-2xx, on a request slower than ``--max-seconds`` or a
p95 above ``--max-p95``. No retries: a browser does not retry either, and
under overload retries only multiply the load.

    python scripts/loadtest/run.py --browsers 28 --connections 6
"""

from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import sys
import time
from datetime import date, timedelta
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    DEFAULT_BASE_URL,
    NAME_PREFIX,
    USER_PASSWORD,
    Recorder,
    login,
    make_client,
    report,
    user_email,
    verdict,
)

PAGE = 200

# slicesForEntity (frontend/src/contexts/wsSlices.ts), for the entities the
# burst changes. 'roles' and 'dashboards' reload only once loaded (Settings,
# the Dashboards view), which a freshly started browser has not.
SLICES_FOR_ENTITY: dict[str, list[str]] = {
    "project": ["projects"],
    "phase": ["projects"],
    "staff_assignment": ["projects"],
    "equipment_assignment": ["projects"],
    "equipment": ["equipment", "projects"],
    "user": ["staff", "currentUser", "projects", "teams"],
    "vacation": ["vacations"],
    "equipment_block": ["equipmentBlocks"],
}


class Browser:
    def __init__(
        self, number: int, email: str, connections: int | None, args: Any, recorder: Recorder
    ):
        self.number = number
        self.email = email
        self.connections = connections
        self.args = args
        self.recorder = recorder
        self.client = make_client(args.base_url, connections)
        self.me: dict[str, Any] = {}
        self.site_id: int | None = None
        self.load_seconds = 0.0

    @property
    def sees_equipment(self) -> bool:
        return "views.equipment" in set(self.me.get("permissions") or [])

    async def get(self, url: str) -> Any:
        return await self.recorder.request(self.client, "GET", url)

    async def sign_in(self) -> None:
        self.me = await login(self.client, self.email, USER_PASSWORD, self.recorder)

    async def startup(self) -> None:
        started = time.perf_counter()
        first = [
            "/api/sites",
            "/api/staff?includeAllSites=true",
            "/api/vacations",
            "/api/settings",
            "/api/skills",
            "/api/tags",
            "/api/project-fields",
            "/api/teams",
            "/api/absence-types",
        ]
        if self.sees_equipment:
            first += ["/api/equipment?includeAllSites=true", "/api/equipment-blocks"]
        responses = await asyncio.gather(*(self.get(url) for url in first))
        sites = responses[0].json() if responses[0] is not None and responses[0].is_success else []
        own = set(self.me.get("siteIds") or [])
        visible = [s for s in sites if self.me.get("canSeeAllSites") or s["id"] in own]
        if visible:
            self.site_id = min(s["id"] for s in visible)
            await self.site_calendar()
            await self.get(f"/api/custom-columns/with-values?site_id={self.site_id}")
        await self.load_projects()
        self.load_seconds = time.perf_counter() - started

    async def site_calendar(self) -> None:
        await self.get(f"/api/sites/{self.site_id}/holidays")
        await self.get(f"/api/sites/{self.site_id}/events")

    async def load_projects(self) -> None:
        if self.args.projects == "bulk":
            for offset in range(0, 100_000, PAGE):
                response = await self.get(
                    f"/api/projects/details?archived=all&limit={PAGE}&offset={offset}"
                )
                if response is None or not response.is_success:
                    return
                page = response.json()
                if len(page["items"]) < PAGE or offset + PAGE >= page["total"]:
                    return
            return
        ids: list[int] = []
        for offset in range(0, 100_000, PAGE):
            response = await self.get(f"/api/projects?archived=all&limit={PAGE}&offset={offset}")
            if response is None or not response.is_success:
                return
            page = response.json()
            ids += [p["id"] for p in page["items"]]
            if len(page["items"]) < PAGE or len(ids) >= page["total"]:
                break
        await asyncio.gather(*(self.get(f"/api/projects/{pid}") for pid in ids))

    async def refetch(self, slices: list[str]) -> None:
        tasks = []
        for slice_name in slices:
            if slice_name == "projects":
                tasks.append(self.load_projects())
            elif slice_name == "staff":
                tasks.append(self.get("/api/staff?includeAllSites=true"))
            elif slice_name == "equipment" and self.sees_equipment:
                tasks.append(self.get("/api/equipment?includeAllSites=true"))
            elif slice_name == "equipmentBlocks" and self.sees_equipment:
                tasks.append(self.get("/api/equipment-blocks"))
            elif slice_name == "vacations":
                tasks.append(self.get("/api/vacations"))
            elif slice_name == "teams":
                tasks.append(self.get("/api/teams"))
            elif slice_name == "currentUser":
                tasks.append(self.get("/api/auth/me"))
        await asyncio.gather(*tasks)


class Writer:
    """The admin making the writes, on a client of its own."""

    def __init__(self, args: Any, recorder: Recorder):
        self.args = args
        self.recorder = recorder
        self.client = make_client(args.base_url, 6)
        self.project: dict[str, Any] = {}
        self.staff_id = 0
        self.equipment_id = 0
        self.person_id = 0

    async def prepare(self) -> None:
        await login(self.client, ADMIN_EMAIL, ADMIN_PASSWORD)
        listing = (await self.client.get(f"/api/projects?limit={PAGE}")).json()["items"]
        seeded = [p for p in listing if p["name"].startswith(NAME_PREFIX)] or listing
        if not seeded:
            raise SystemExit("No project to write to: seed first (scripts/loadtest/seed.py)")
        target = seeded[len(seeded) // 2]
        self.project = (await self.client.get(f"/api/projects/{target['id']}")).json()
        site_id = self.project["site_id"]
        staff = (await self.client.get(f"/api/staff?siteId={site_id}")).json()
        equipment = (await self.client.get(f"/api/equipment?siteId={site_id}")).json()
        if not staff or not equipment:
            raise SystemExit("The write target's site has no staff or no equipment")
        self.staff_id = staff[-1]["id"]
        self.equipment_id = equipment[-1]["id"]
        self.person_id = staff[0]["id"]

    async def send(self, method: str, url: str, body: Any = None, label: str = "") -> Any:
        key = f"WRITE {method} {label or url}"
        response = await self.recorder.request(self.client, method, url, json=body, label=key)
        return response.json() if response is not None and response.content else None

    async def during_load(self, stop: asyncio.Event) -> None:
        n = 0
        while not stop.is_set():
            n += 1
            await self.send(
                "PUT",
                f"/api/projects/{self.project['id']}",
                {"notes": f"load test edit {n}"},
                "/api/projects/{id} (during startup)",
            )
            try:
                await asyncio.wait_for(stop.wait(), self.args.writer_interval)
            except TimeoutError:
                pass

    def burst(self) -> list[tuple[str, str, str, Any, str]]:
        """``(entity, method, url, body, label)`` of each write, in order."""
        phase = self.project["phases"][0]
        start = date.fromisoformat(phase["start_date"][:10])
        end = date.fromisoformat(phase["end_date"][:10])
        pid = self.project["id"]
        day = date(2027, 6, 7) + timedelta(days=self.project["id"] % 50)
        return [
            ("project", "PUT", f"/api/projects/{pid}", {"notes": "burst"}, "/api/projects/{id}"),
            (
                "phase",
                "PUT",
                f"/api/phases/{phase['id']}",
                {"start_date": str(start + timedelta(days=1)), "end_date": str(end)},
                "/api/phases/{id} (move)",
            ),
            (
                "phase",
                "PUT",
                f"/api/phases/{phase['id']}",
                {"start_date": str(start), "end_date": str(end)},
                "/api/phases/{id} (move back)",
            ),
            (
                "staff_assignment",
                "POST",
                f"/api/phases/{phase['id']}/staff",
                {"staff_id": self.staff_id, "project_id": pid, "allocation": 10},
                "/api/phases/{id}/staff",
            ),
            (
                "equipment_assignment",
                "POST",
                f"/api/projects/{pid}/equipment",
                {"equipment_id": self.equipment_id, "start_date": str(day), "end_date": str(day)},
                "/api/projects/{id}/equipment",
            ),
            (
                "equipment",
                "PUT",
                f"/api/equipment/{self.equipment_id}",
                {"description": f"load test {time.time():.0f}"},
                "/api/equipment/{id}",
            ),
            (
                "user",
                "PUT",
                f"/api/users/{self.person_id}",
                {"job_title": "Load tester"},
                "/api/users/{id}",
            ),
            (
                "vacation",
                "POST",
                "/api/vacations",
                {"staff_id": self.person_id, "start_date": str(day), "end_date": str(day)},
                "/api/vacations",
            ),
            (
                "equipment_block",
                "POST",
                "/api/equipment-blocks",
                {
                    "equipment_id": self.equipment_id,
                    "start_date": str(day + timedelta(days=3)),
                    "end_date": str(day + timedelta(days=3)),
                },
                "/api/equipment-blocks",
            ),
        ]

    @staticmethod
    def cleanup(entity: str, created: Any) -> str | None:
        """The URL of the DELETE undoing a create of the burst, if it created a row."""
        if not isinstance(created, dict) or "id" not in created:
            return None
        base = {
            "staff_assignment": "/api/phase-staff",
            "equipment_assignment": "/api/equipment-assignments",
            "vacation": "/api/vacations",
            "equipment_block": "/api/equipment-blocks",
        }.get(entity)
        return f"{base}/{created['id']}" if base else None


async def run(args: Any) -> int:
    recorder = Recorder()
    browsers = [
        Browser(i, user_email(args.first_user + i), args.connections, args, recorder)
        for i in range(args.browsers)
    ] + [
        Browser(
            args.browsers + i,
            user_email(args.first_user + args.browsers + i),
            None,
            args,
            recorder,
        )
        for i in range(args.unlimited_browsers)
    ]
    writer = Writer(args, recorder)
    await writer.prepare()
    for chunk in range(0, len(browsers), 10):  # sign in a few at a time, like people do
        await asyncio.gather(*(b.sign_in() for b in browsers[chunk : chunk + 10]))
    sign_in = Recorder(samples=dict(recorder.samples), errors=list(recorder.errors))
    recorder.samples.clear()
    recorder.errors.clear()
    if sign_in.failures():
        report(sign_in, "sign-in")
        return 1

    print(
        f"{len(browsers)} browsers ({args.browsers} x {args.connections or 'unlimited'} "
        f"connections + {args.unlimited_browsers} unlimited), projects: {args.projects}"
    )
    stop = asyncio.Event()
    started = time.perf_counter()
    writing = asyncio.create_task(writer.during_load(stop))
    await asyncio.gather(*(b.startup() for b in browsers))
    stop.set()
    await writing
    loads = [b.load_seconds for b in browsers]
    print(
        f"startup: all browsers loaded in {time.perf_counter() - started:.1f}s; per browser "
        f"min {min(loads):.1f}s median {statistics.median(loads):.1f}s max {max(loads):.1f}s"
    )

    if not args.no_burst:
        burst_started = time.perf_counter()
        for entity, method, url, body, label in writer.burst():
            created = await writer.send(method, url, body, label)
            await asyncio.gather(*(b.refetch(SLICES_FOR_ENTITY[entity]) for b in browsers))
            undo = Writer.cleanup(entity, created)
            if undo:
                await writer.send("DELETE", undo, label=undo.rsplit("/", 1)[0] + "/{id}")
                await asyncio.gather(*(b.refetch(SLICES_FOR_ENTITY[entity]) for b in browsers))
        print(f"write burst with refetches: {time.perf_counter() - burst_started:.1f}s")

    for browser in browsers:
        await browser.client.aclose()
    await writer.client.aclose()

    report(recorder, "per endpoint")
    problems = verdict(recorder, max_seconds=args.max_seconds, max_p95=args.max_p95)
    if problems:
        print("\nFAIL: " + "; ".join(problems))
        return 1
    print("\nPASS")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--browsers", type=int, default=28, help="browsers with a connection cap")
    parser.add_argument("--connections", type=int, default=6, help="connections per browser")
    parser.add_argument("--unlimited-browsers", type=int, default=0)
    parser.add_argument("--first-user", type=int, default=1, help="first seeded user number")
    parser.add_argument("--projects", choices=["bulk", "detail"], default="bulk")
    parser.add_argument("--no-burst", action="store_true", help="startup only")
    parser.add_argument("--writer-interval", type=float, default=0.5)
    parser.add_argument("--max-seconds", type=float, default=20.0, help="slowest request allowed")
    parser.add_argument("--max-p95", type=float, default=None)
    args = parser.parse_args()
    if not ADMIN_PASSWORD:
        raise SystemExit(
            "Set LOADTEST_ADMIN_PASSWORD (and LOADTEST_ADMIN_EMAIL if not the default)"
        )
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
