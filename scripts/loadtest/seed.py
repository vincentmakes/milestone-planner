"""
Seed a load-test workspace through the API, as an admin.

Profiles (``--profile``):

- ``pilot``: the pilot customer's size -- 5 sites, 33 projects of 6 phases
  (every other phase with a subphase), 50 equipment spread over the sites
  (every fifth shared by two), 28 users spread over the sites with different
  roles (admin, superuser, user), two staff bookings per phase, equipment
  bookings on the phases, absences and equipment blocks;
- ``stress``: about three times that -- 15 sites, 100 projects, 150
  equipment, 90 users.

Everything goes through the same routes the app uses (so the rows land in the
same tables, with the same side effects). Users are created as
``lt-user-NNN@loadtest.local`` with the password ``LOADTEST_USER_PASSWORD``
(default ``loadtest-1234``) so the runner can sign in as each of them.

Idempotent: a workspace that already holds the profile's sites is left as is.

    python scripts/loadtest/seed.py --profile pilot
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    DEFAULT_BASE_URL,
    NAME_PREFIX,
    USER_PASSWORD,
    login,
    make_client,
    require_ok,
    user_email,
)


@dataclass(frozen=True)
class Profile:
    sites: int
    projects: int
    phases: int
    equipment: int
    users: int


PROFILES = {
    "pilot": Profile(sites=5, projects=33, phases=6, equipment=50, users=28),
    "stress": Profile(sites=15, projects=100, phases=6, equipment=150, users=90),
    # A small workspace for a quick local check of the scripts themselves.
    "tiny": Profile(sites=2, projects=4, phases=3, equipment=4, users=4),
}

START = date(2026, 11, 2)  # a Monday


def role_of(index: int) -> str:
    """Users 1-3 are admins, every fourth of the rest a superuser, else a user."""
    if index <= 3:
        return "admin"
    return "superuser" if index % 4 == 0 else "user"


async def seed(base_url: str, name: str, profile: Profile) -> None:
    started = time.perf_counter()
    async with make_client(base_url, connections=8) as admin:
        await login(admin, ADMIN_EMAIL, ADMIN_PASSWORD)

        existing = require_ok(await admin.get("/api/sites"), "list sites")
        prefix = f"{NAME_PREFIX} Site "
        if any(s["name"].startswith(prefix) for s in existing):
            print(f"Already seeded ({sum(s['name'].startswith(prefix) for s in existing)} sites)")
            return

        # Sites
        site_ids = []
        for i in range(profile.sites):
            body: dict[str, Any] = {
                "name": f"{prefix}{i + 1:02d}",
                "city": f"City {i + 1}",
                "country_code": "CH",
            }
            site_ids.append(require_ok(await admin.post("/api/sites", json=body), "site")["id"])

        # Users: spread over the sites (every sixth at two), different roles.
        users: list[dict[str, Any]] = []
        for i in range(1, profile.users + 1):
            home = site_ids[(i - 1) % len(site_ids)]
            sites = [home]
            if i % 6 == 0 and len(site_ids) > 1:
                sites.append(site_ids[i % len(site_ids)])
            body = {
                "email": user_email(i),
                "password": USER_PASSWORD,
                "first_name": f"Load{i:03d}",
                "last_name": "Tester",
                "job_title": ["Chemist", "Engineer", "Technician", "Lab manager"][i % 4],
                "role": role_of(i),
                "is_resource": True,
                "site_ids": sites,
            }
            created = require_ok(await admin.post("/api/users", json=body), f"user {i}")
            users.append({"id": created["id"], "sites": sites})
        staff_by_site = {
            sid: [u["id"] for u in users if sid in u["sites"]] or [users[0]["id"]]
            for sid in site_ids
        }

        # Equipment: spread over the sites, every fifth shared by two.
        equipment_by_site: dict[int, list[int]] = {sid: [] for sid in site_ids}
        equipment_ids = []
        for i in range(profile.equipment):
            sites = [site_ids[i % len(site_ids)]]
            if i % 5 == 4 and len(site_ids) > 1:
                sites.append(site_ids[(i + 1) % len(site_ids)])
            body = {
                "name": f"{NAME_PREFIX} Instrument {i + 1:03d}",
                "type": ["HPLC", "GC", "Reactor", "Oven", "Balance"][i % 5],
                "site_ids": sites,
            }
            eid = require_ok(await admin.post("/api/equipment", json=body), "equipment")["id"]
            equipment_ids.append(eid)
            for sid in sites:
                equipment_by_site[sid].append(eid)

        # Equipment blocks (maintenance) on every fifth instrument.
        for n, eid in enumerate(equipment_ids[::5]):
            day = START + timedelta(days=7 * (n % 20))
            body = {
                "equipment_id": eid,
                "start_date": str(day),
                "end_date": str(day + timedelta(days=2)),
            }
            require_ok(await admin.post("/api/equipment-blocks", json=body), "block")

        # Absences for every other user.
        for n, user in enumerate(users[::2]):
            day = START + timedelta(days=5 * (n % 30))
            body = {
                "staff_id": user["id"],
                "start_date": str(day),
                "end_date": str(day + timedelta(days=4)),
                "description": "Vacation",
            }
            require_ok(await admin.post("/api/vacations", json=body), "vacation")

        # Projects with their phases, subphases, staff and equipment bookings,
        # a few at a time.
        gate = asyncio.Semaphore(6)
        counters = {"phases": 0, "subphases": 0, "staff": 0, "equipment": 0}

        async def one_project(p: int) -> None:
            async with gate:
                await _seed_project(
                    admin, p, profile, site_ids, users, staff_by_site, equipment_by_site, counters
                )

        await asyncio.gather(*(one_project(p) for p in range(profile.projects)))

    print(
        f"Seeded profile {name}: {profile.sites} sites, {profile.users} users, "
        f"{profile.equipment} equipment, {profile.projects} projects, "
        f"{counters['phases']} phases, {counters['subphases']} subphases, "
        f"{counters['staff']} staff bookings, {counters['equipment']} equipment bookings "
        f"in {time.perf_counter() - started:.0f}s"
    )


async def _seed_project(
    admin: Any,
    p: int,
    profile: Profile,
    site_ids: list[int],
    users: list[dict[str, Any]],
    staff_by_site: dict[int, list[int]],
    equipment_by_site: dict[int, list[int]],
    counters: dict[str, int],
) -> None:
    site_id = site_ids[p % len(site_ids)]
    start = START + timedelta(days=7 * (p % 26))
    phases = [
        {
            "type": f"Phase {k + 1}",
            "start_date": str(start + timedelta(days=14 * k)),
            "end_date": str(start + timedelta(days=14 * k + 11)),
        }
        for k in range(profile.phases)
    ]
    staff = staff_by_site[site_id]
    body = {
        "name": f"{NAME_PREFIX} Project {p + 1:03d}",
        "site_id": site_id,
        "customer": f"Customer {p % 12}",
        "pm_id": staff[p % len(staff)],
        "confirmed": p % 3 != 0,
        "start_date": str(start),
        "end_date": str(start + timedelta(days=14 * profile.phases)),
        "phases": phases,
    }
    project_id = require_ok(await admin.post("/api/projects", json=body), "project")["id"]
    detail = require_ok(await admin.get(f"/api/projects/{project_id}"), "project detail")
    equipment = equipment_by_site[site_id]
    for k, phase in enumerate(detail["phases"]):
        counters["phases"] += 1
        if k % 2 == 0:
            sub = {
                "name": f"Step {k + 1}.1",
                "start_date": phase["start_date"][:10],
                "end_date": (
                    date.fromisoformat(phase["start_date"][:10]) + timedelta(days=4)
                ).isoformat(),
                "project_id": project_id,
            }
            require_ok(await admin.post(f"/api/phases/{phase['id']}/subphases", json=sub), "sub")
            counters["subphases"] += 1
        for b in range(2):
            booking = {
                "staff_id": staff[(p + k + b) % len(staff)],
                "project_id": project_id,
                "allocation": 40 if b else 60,
            }
            response = await admin.post(f"/api/phases/{phase['id']}/staff", json=booking)
            if response.status_code < 300:
                counters["staff"] += 1
            elif response.status_code != 409:  # a person already on the card
                require_ok(response, "staff booking")
        if k % 2 == 1 and equipment:
            for attempt in range(len(equipment)):
                eid = equipment[(p + k + attempt) % len(equipment)]
                body = {
                    "equipment_id": eid,
                    "start_date": phase["start_date"][:10],
                    "end_date": phase["end_date"][:10],
                }
                response = await admin.post(f"/api/projects/{project_id}/equipment", json=body)
                if response.status_code < 300:
                    counters["equipment"] += 1
                    break
                if response.status_code != 409:  # booked or blocked then: next one
                    require_ok(response, "equipment booking")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--profile", choices=sorted(PROFILES), default="pilot")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    args = parser.parse_args()
    if not ADMIN_PASSWORD:
        raise SystemExit(
            "Set LOADTEST_ADMIN_PASSWORD (and LOADTEST_ADMIN_EMAIL if not the default)"
        )
    asyncio.run(seed(args.base_url, args.profile, PROFILES[args.profile]))


if __name__ == "__main__":
    main()
