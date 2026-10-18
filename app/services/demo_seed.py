"""
Load the demo data set (app/scripts/demo_data.py) into a tenant database.

Used by two callers: `python -m app.scripts.seed_demo` (the Codespaces /
screenshot demo tenant) and the admin portal's provisioning route, when a
portal admin ticks "Seed demo data" for a new tenant.

Names → ids are resolved as the rows go in, every insert is guarded so a
partially seeded database (an earlier run that stopped half-way) is completed,
never duplicated. Only the asyncpg API (`execute` / `fetchval`) is used.
"""

import json
import re
from typing import Any

from app.scripts.demo_data import DEMO_PASSWORD, DemoData
from app.services.encryption import generate_password, hash_user_password
from app.services.mentions import parse_mention_ids

# ---------------------------------------------------------------------------
# Loader: names → ids, every insert guarded so a partially seeded database
# (an earlier run that stopped half-way) is completed, never duplicated.
# ---------------------------------------------------------------------------


def _placeholders(values: dict[str, Any], offset: int = 0) -> str:
    return ", ".join(f"${i + 1 + offset}" for i in range(len(values)))


def _where(key: dict[str, Any], offset: int) -> str:
    # `IS NOT DISTINCT FROM` so a NULL key column (a global custom column's
    # site_id) still matches.
    return " AND ".join(
        f"{col} IS NOT DISTINCT FROM ${i + 1 + offset}" for i, col in enumerate(key)
    )


async def _insert_once(conn: Any, table: str, values: dict[str, Any], key: dict[str, Any]) -> None:
    """INSERT unless a row with the same natural key exists (no id needed)."""
    sql = (
        f"INSERT INTO {table} ({', '.join(values)}) "
        f"SELECT {_placeholders(values)} "
        f"WHERE NOT EXISTS (SELECT 1 FROM {table} WHERE {_where(key, len(values))})"
    )
    await conn.execute(sql, *values.values(), *key.values())


async def _insert_id(conn: Any, table: str, values: dict[str, Any], key: dict[str, Any]) -> int:
    """`_insert_once`, then the id of the row with that natural key."""
    await _insert_once(conn, table, values, key)
    row_id = await conn.fetchval(
        f"SELECT id FROM {table} WHERE {_where(key, 0)} ORDER BY id LIMIT 1", *key.values()
    )
    if row_id is None:
        raise RuntimeError(f"{table}: row {key} missing after insert")
    return int(row_id)


async def insert_demo_data(
    conn: Any, demo: DemoData, *, admin_password_hash: str | None = None
) -> dict[str, int]:
    """Insert `demo` through `conn` (asyncpg API: execute / fetchval).

    Without `admin_password_hash` (the Codespaces / screenshot demo tenant)
    every person signs in with DEMO_PASSWORD. With it (the admin portal's
    "Seed demo data" option) the admin (`demo.admin_email`) gets that hash —
    the password the portal shows once — and the sample people get a random,
    discarded password: they are staff to plan with, not accounts to sign in
    as, until a tenant admin sets a password in Settings → Users.

    Returns the number of rows the data set holds per table, for the summary.
    """
    password_hash = hash_user_password(
        DEMO_PASSWORD if admin_password_hash is None else generate_password(32)
    )
    counts: dict[str, int] = {}

    await conn.execute(
        "INSERT INTO sso_config (id, enabled) VALUES (1, 0) ON CONFLICT (id) DO NOTHING"
    )
    for key, value in demo.settings:
        await conn.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
            key,
            value,
        )
    for order, name in enumerate(demo.predefined_phases):
        await conn.execute(
            "INSERT INTO predefined_phases (name, sort_order, is_active) VALUES ($1, $2, 1) "
            "ON CONFLICT (name) DO NOTHING",
            name,
            order,
        )

    site_id: dict[str, int] = {}
    for s in demo.sites:
        site_id[s["name"]] = await _insert_id(conn, "sites", dict(s), {"name": s["name"]})
    counts["sites"] = len(site_id)

    skill_id: dict[str, int] = {}
    for sk in demo.skills:
        skill_id[sk["name"]] = await _insert_id(conn, "skills", dict(sk), {"name": sk["name"]})

    user_id: dict[str, int] = {}
    full_name: dict[str, str] = {}
    for u in demo.users:
        user_id[u["email"]] = await _insert_id(
            conn,
            "users",
            {
                "email": u["email"],
                "password": (
                    admin_password_hash
                    if admin_password_hash and u["email"] == demo.admin_email
                    else password_hash
                ),
                "first_name": u["first_name"],
                "last_name": u["last_name"],
                "job_title": u["job_title"],
                "role": u["role"],
                "max_capacity": u["max_capacity"],
                "active": 1 if u["active"] else 0,
                "is_system": 1 if u["is_system"] else 0,
            },
            {"email": u["email"]},
        )
        full_name[u["email"]] = f"{u['first_name']} {u['last_name']}"
        for site in u["sites"]:
            await conn.execute(
                "INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                user_id[u["email"]],
                site_id[site],
            )
        for skill in u["skills"]:
            await conn.execute(
                "INSERT INTO user_skills (user_id, skill_id, proficiency) VALUES ($1, $2, 4) "
                "ON CONFLICT DO NOTHING",
                user_id[u["email"]],
                skill_id[skill],
            )
    counts["users"] = len(user_id)

    equipment_id: dict[str, int] = {}
    for e in demo.equipment:
        # Legacy `site_id` = the lowest linked site; links live in equipment_sites.
        primary = min(site_id[s] for s in e["sites"])
        equipment_id[e["name"]] = await _insert_id(
            conn,
            "equipment",
            {"name": e["name"], "type": e["type"], "site_id": primary, "active": 1},
            {"name": e["name"]},
        )
        for site in e["sites"]:
            await conn.execute(
                "INSERT INTO equipment_sites (equipment_id, site_id) VALUES ($1, $2) "
                "ON CONFLICT DO NOTHING",
                equipment_id[e["name"]],
                site_id[site],
            )
    counts["equipment"] = len(equipment_id)

    group_id: dict[str, int] = {}
    for g in demo.tag_groups:
        group_id[g["name"]] = await _insert_id(conn, "tag_groups", dict(g), {"name": g["name"]})
    tag_id: dict[str, int] = {}
    for t in demo.tags:
        tag_id[t["name"]] = await _insert_id(
            conn,
            "tags",
            {
                "name": t["name"],
                "color": t["color"],
                "group_id": group_id[t["group"]] if t["group"] else None,
                "all_sites": t["sites"] is None,
                "sort_order": t["sort_order"],
            },
            {"name": t["name"]},
        )
        for site in t["sites"] or []:
            await conn.execute(
                "INSERT INTO tag_sites (tag_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                tag_id[t["name"]],
                site_id[site],
            )
    counts["tags"] = len(tag_id)

    project_id: dict[str, int] = {}
    for p in demo.projects:
        project_id[p["name"]] = await _insert_id(
            conn,
            "projects",
            {
                "name": p["name"],
                "site_id": site_id[p["site"]],
                "customer": p["customer"],
                "pm_id": user_id[p["pm"]] if p["pm"] else None,
                "sales_pm": p["sales_pm"],
                "confirmed": 1 if p["confirmed"] else 0,
                "start_date": p["start_date"],
                "end_date": p["end_date"],
                "notes": p["notes"],
                "archived": 1 if p["archived"] else 0,
            },
            {"name": p["name"], "site_id": site_id[p["site"]]},
        )
        for tag in p["tags"]:
            await conn.execute(
                "INSERT INTO project_tags (project_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                project_id[p["name"]],
                tag_id[tag],
            )
    counts["projects"] = len(project_id)

    phase_id: dict[tuple[str, str], int] = {}
    for ph in demo.phases:
        pid = project_id[ph["project"]]
        phase_id[(ph["project"], ph["type"])] = await _insert_id(
            conn,
            "project_phases",
            {
                "project_id": pid,
                "type": ph["type"],
                "start_date": ph["start_date"],
                "end_date": ph["end_date"],
                "is_milestone": 1 if ph["is_milestone"] else 0,
                "sort_order": ph["sort_order"],
                "completion": ph["completion"],
                "status": ph["status"],
            },
            {"project_id": pid, "type": ph["type"]},
        )
    counts["phases"] = len(phase_id)

    subphase_id: dict[tuple[str, str], int] = {}
    # Parents first: a nested subphase names a depth-1 sibling as its parent.
    for sp in sorted(demo.subphases, key=lambda x: x["depth"]):
        pid = project_id[sp["project"]]
        if sp["parent"]:
            parent_type, parent_id = "subphase", subphase_id[(sp["project"], sp["parent"])]
        else:
            parent_type, parent_id = "phase", phase_id[(sp["project"], sp["phase"])]
        subphase_id[(sp["project"], sp["name"])] = await _insert_id(
            conn,
            "project_subphases",
            {
                "parent_id": parent_id,
                "parent_type": parent_type,
                "project_id": pid,
                "name": sp["name"],
                "start_date": sp["start_date"],
                "end_date": sp["end_date"],
                "is_milestone": 1 if sp["is_milestone"] else 0,
                "sort_order": sp["sort_order"],
                "depth": sp["depth"],
                "completion": sp["completion"],
                "status": sp["status"],
            },
            {"project_id": pid, "name": sp["name"]},
        )
    counts["subphases"] = len(subphase_id)

    def entity_id(ent: tuple[str, str, str]) -> int:
        kind, proj, name = ent
        return phase_id[(proj, name)] if kind == "phase" else subphase_id[(proj, name)]

    # Dependencies: one JSON list per successor, written only where nothing is
    # set yet (an edit made in the app is never overwritten).
    by_successor: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for dep in demo.dependencies:
        by_successor.setdefault(dep["successor"], []).append(
            {
                "id": entity_id(dep["predecessor"]),
                "type": dep["type"],
                "lag": dep["lag"],
                "entity": dep["predecessor"][0],
            }
        )
    for successor, links in by_successor.items():
        table = "project_phases" if successor[0] == "phase" else "project_subphases"
        await conn.execute(
            f"UPDATE {table} SET dependencies = $1 "
            "WHERE id = $2 AND (dependencies IS NULL OR dependencies IN ('', '[]'))",
            json.dumps(links),
            entity_id(successor),
        )
    counts["dependencies"] = len(demo.dependencies)

    for a in demo.phase_assignments:
        await _insert_once(
            conn,
            "phase_staff_assignments",
            {
                "project_id": project_id[a["project"]],
                "phase_id": phase_id[(a["project"], a["phase"])],
                "staff_id": user_id[a["staff"]],
                "allocation": a["allocation"],
            },
            {"phase_id": phase_id[(a["project"], a["phase"])], "staff_id": user_id[a["staff"]]},
        )
    for a in demo.project_assignments:
        await _insert_once(
            conn,
            "project_assignments",
            {
                "project_id": project_id[a["project"]],
                "staff_id": user_id[a["staff"]],
                "allocation": a["allocation"],
                "start_date": a["start_date"],
                "end_date": a["end_date"],
            },
            {
                "project_id": project_id[a["project"]],
                "staff_id": user_id[a["staff"]],
                "start_date": a["start_date"],
            },
        )
    for a in demo.subphase_assignments:
        sid = subphase_id[(a["project"], a["subphase"])]
        await _insert_once(
            conn,
            "subphase_staff_assignments",
            {
                "project_id": project_id[a["project"]],
                "subphase_id": sid,
                "staff_id": user_id[a["staff"]],
                "allocation": a["allocation"],
            },
            {"subphase_id": sid, "staff_id": user_id[a["staff"]]},
        )
    counts["staff_assignments"] = (
        len(demo.phase_assignments) + len(demo.project_assignments) + len(demo.subphase_assignments)
    )

    for b in demo.equipment_bookings:
        await _insert_once(
            conn,
            "equipment_assignments",
            {
                "project_id": project_id[b["project"]],
                "equipment_id": equipment_id[b["equipment"]],
                "start_date": b["start_date"],
                "end_date": b["end_date"],
            },
            {
                "project_id": project_id[b["project"]],
                "equipment_id": equipment_id[b["equipment"]],
                "start_date": b["start_date"],
            },
        )
    for b in demo.equipment_blocks:
        await _insert_once(
            conn,
            "equipment_blocks",
            {
                "equipment_id": equipment_id[b["equipment"]],
                "start_date": b["start_date"],
                "end_date": b["end_date"],
                "reason": b["reason"],
                "description": b["description"],
            },
            {
                "equipment_id": equipment_id[b["equipment"]],
                "reason": b["reason"],
                "start_date": b["start_date"],
            },
        )
    counts["equipment_bookings"] = len(demo.equipment_bookings)
    counts["equipment_blocks"] = len(demo.equipment_blocks)

    for h in demo.bank_holidays:
        await _insert_once(
            conn,
            "bank_holidays",
            {
                "site_id": site_id[h["site"]],
                "date": h["date"],
                "name": h["name"],
                "year": h["year"],
                "is_custom": 0,
            },
            {"site_id": site_id[h["site"]], "date": h["date"], "name": h["name"]},
        )
    counts["bank_holidays"] = len(demo.bank_holidays)

    for ev in demo.company_events:
        # Legacy `site_id` = the first linked site; links live in company_event_sites.
        event_id = await _insert_id(
            conn,
            "company_events",
            {
                "site_id": site_id[ev["sites"][0]],
                "date": ev["date"],
                "end_date": ev["end_date"],
                "name": ev["name"],
                "color": ev["color"],
                "counts_as_unavailable": ev["counts_as_unavailable"],
            },
            {"name": ev["name"], "date": ev["date"]},
        )
        for site in ev["sites"]:
            await conn.execute(
                "INSERT INTO company_event_sites (event_id, site_id) VALUES ($1, $2) "
                "ON CONFLICT DO NOTHING",
                event_id,
                site_id[site],
            )
    counts["company_events"] = len(demo.company_events)

    for v in demo.vacations:
        # Absence types are seeded by the tenant schema; look them up by name.
        type_id = await conn.fetchval("SELECT id FROM absence_types WHERE name = $1", v["type"])
        await _insert_once(
            conn,
            "vacations",
            {
                "staff_id": user_id[v["staff"]],
                "start_date": v["start_date"],
                "end_date": v["end_date"],
                "description": v["description"],
                "absence_type_id": type_id,
            },
            {
                "staff_id": user_id[v["staff"]],
                "start_date": v["start_date"],
                "description": v["description"],
            },
        )
    counts["vacations"] = len(demo.vacations)

    column_id: dict[str, int] = {}
    for c in demo.custom_columns:
        c_site = site_id[c["site"]] if c["site"] else None
        column_id[c["name"]] = await _insert_id(
            conn,
            "custom_columns",
            {
                "name": c["name"],
                "column_type": c["column_type"],
                "list_options": c["list_options"],
                "site_id": c_site,
                "display_order": c["display_order"],
                "width": c["width"],
            },
            {"name": c["name"], "site_id": c_site},
        )
    for val in demo.custom_column_values:
        kind = val["entity"][0]
        await _insert_once(
            conn,
            "custom_column_values",
            {
                "custom_column_id": column_id[val["column"]],
                "entity_type": kind,
                "entity_id": entity_id(val["entity"]),
                "value": val["value"],
            },
            {
                "custom_column_id": column_id[val["column"]],
                "entity_type": kind,
                "entity_id": entity_id(val["entity"]),
            },
        )
    counts["custom_columns"] = len(column_id)

    for cm in demo.comments:
        body = render_mentions(cm["body"], user_id, full_name)
        kind = cm["entity"][0]
        await _insert_once(
            conn,
            "card_comments",
            {
                "entity_type": kind,
                "entity_id": entity_id(cm["entity"]),
                "project_id": project_id[cm["project"]],
                "author_id": user_id[cm["author"]],
                "body": body,
                "mentioned_user_ids": json.dumps(parse_mention_ids(body)),
            },
            {
                "entity_type": kind,
                "entity_id": entity_id(cm["entity"]),
                "project_id": project_id[cm["project"]],
                "body": body,
            },
        )
    counts["comments"] = len(demo.comments)

    for n in demo.notifications:
        # The natural key is passed again as its own placeholders ($10-$12):
        # a parameter used both in the SELECT list and in a comparison makes
        # PostgreSQL deduce two types for it (text vs character varying) and
        # refuse the statement, as `_insert_once` avoids with `_where`.
        await conn.execute(
            "INSERT INTO notifications "
            "(user_id, type, actor_id, entity_type, entity_id, project_id, title, body, read_at) "
            "SELECT $1, $2, $3, $4, $5, $6, $7, $8, "
            "CASE WHEN $9::boolean THEN CURRENT_TIMESTAMP ELSE NULL END "
            "WHERE NOT EXISTS (SELECT 1 FROM notifications "
            "WHERE user_id = $10 AND type = $11 AND title = $12)",
            user_id[n["user"]],
            n["type"],
            user_id[n["actor"]],
            n["entity"][0],
            entity_id(n["entity"]),
            project_id[n["project"]],
            n["title"],
            n["body"],
            bool(n["read"]),
            user_id[n["user"]],
            n["type"],
            n["title"],
        )
    counts["notifications"] = len(demo.notifications)

    for note in demo.staff_notes:
        await _insert_once(
            conn,
            "staff_notes",
            {
                "site_id": site_id[note["site"]],
                "staff_id": user_id[note["staff"]],
                "date": note["date"],
                "text": note["text"],
                "type": note["type"],
            },
            {"site_id": site_id[note["site"]], "text": note["text"]},
        )
    counts["staff_notes"] = len(demo.staff_notes)

    return counts


MENTION_PLACEHOLDER_RE = re.compile(r"\{mention:([^}]+)\}")


def render_mentions(body: str, user_id: dict[str, int], full_name: dict[str, str]) -> str:
    """`{mention:<email>}` → `@[Full Name](id)` (app/services/mentions.py format)."""

    def repl(match: re.Match[str]) -> str:
        email = match.group(1)
        return f"@[{full_name[email]}]({user_id[email]})"

    return MENTION_PLACEHOLDER_RE.sub(repl, body)
