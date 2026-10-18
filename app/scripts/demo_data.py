"""
The demo tenant's data, as plain Python — no database.

`build_demo(today)` returns every row the demo seed inserts, keyed by *names*
(e-mails for people, names for sites/projects/phases/equipment/tags) and with
every date relative to `today`. `app/scripts/seed_demo.py` resolves the names
to ids as it inserts; `tests/test_demo_data.py` checks the data against the
app's rules (status/completion pairs, single-select tag groups, site-restricted
tags, mention tokens, dependency shape, PM membership) without a database.

The four canonical projects (Bioprocess Scale-Up, Catalyst Optimization,
Analytical Method Transfer, Quality System Upgrade) and the people's names are
referenced by the documentation screenshots — keep them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from app.services.card_status import DEFAULT_IN_PROGRESS_COMPLETION

Row = dict[str, Any]
EntityKind = Literal["phase", "subphase"]

DEMO_ADMIN_EMAIL = "admin@demo.local"
DEMO_PASSWORD = "demo1234"

WINTERTHUR = "Winterthur"
FRANKFURT = "Frankfurt"

PHASE_TYPES = ["Preparation", "Analytics", "Trial", "Cleaning", "Report"]

# Project names the screenshot pipeline (scripts/screenshots/capture.py) and the
# docs refer to. Order = insertion order = default Gantt order for ties.
CATALYST = "Catalyst Optimization"
BIOPROCESS = "Bioprocess Scale-Up"
ANALYTICAL = "Analytical Method Transfer"
QUALITY = "Quality System Upgrade"
LEGACY = "Legacy Filtration Study"

ALICE = "alice.anderson@demo.local"
BOB = "bob.brown@demo.local"
CHARLIE = "charlie.clark@demo.local"
DIANA = "diana.davis@demo.local"
EDWARD = "edward.evans@demo.local"
FIONA = "fiona.fischer@demo.local"
GEORGE = "george.garcia@demo.local"
HANNAH = "hannah.harris@demo.local"


@dataclass
class DemoData:
    """Everything the demo seed inserts, in insertion order."""

    today: date
    admin_email: str = DEMO_ADMIN_EMAIL  # the is_system admin, mentioned and notified
    settings: list[tuple[str, str]] = field(default_factory=list)
    predefined_phases: list[str] = field(default_factory=list)
    sites: list[Row] = field(default_factory=list)
    skills: list[Row] = field(default_factory=list)
    users: list[Row] = field(default_factory=list)  # incl. the admin
    equipment: list[Row] = field(default_factory=list)
    tag_groups: list[Row] = field(default_factory=list)
    tags: list[Row] = field(default_factory=list)
    projects: list[Row] = field(default_factory=list)
    phases: list[Row] = field(default_factory=list)
    subphases: list[Row] = field(default_factory=list)
    dependencies: list[Row] = field(default_factory=list)
    project_assignments: list[Row] = field(default_factory=list)
    phase_assignments: list[Row] = field(default_factory=list)
    subphase_assignments: list[Row] = field(default_factory=list)
    equipment_bookings: list[Row] = field(default_factory=list)
    equipment_blocks: list[Row] = field(default_factory=list)
    bank_holidays: list[Row] = field(default_factory=list)
    company_events: list[Row] = field(default_factory=list)
    vacations: list[Row] = field(default_factory=list)
    custom_columns: list[Row] = field(default_factory=list)
    custom_column_values: list[Row] = field(default_factory=list)
    comments: list[Row] = field(default_factory=list)
    notifications: list[Row] = field(default_factory=list)
    staff_notes: list[Row] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Status / completion
# ---------------------------------------------------------------------------


def phase_progress(start: date, end: date, today: date) -> tuple[int, str]:
    """Plausible completion/status for a demo card, from its dates.

    Finished work is done, work spanning today is part-way through, future
    work is untouched. Pairs follow app/services/card_status.py: `todo` is 0 %,
    `done` is 100 %, `in_progress` is strictly between.
    """
    if end < today:
        return 100, "done"
    if start > today:
        return 0, "todo"
    span = max((end - start).days, 1)
    elapsed = max((today - start).days, 0)
    pct = min(max(round(elapsed / span * 100), 5), 95)
    return pct, "in_progress"


# ---------------------------------------------------------------------------
# Public holidays (static rules, no network)
# ---------------------------------------------------------------------------


def easter_sunday(year: int) -> date:
    """Gregorian Easter (Anonymous algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    m = (32 + 2 * e + 2 * i - h - k) % 7
    n = (a + 11 * h + 22 * m) // 451
    month, day = divmod(h + m - 7 * n + 114, 31)
    return date(year, month, day + 1)


def swiss_holidays(year: int) -> list[tuple[date, str]]:
    """Canton Zurich public holidays."""
    e = easter_sunday(year)
    return [
        (date(year, 1, 1), "New Year's Day"),
        (date(year, 1, 2), "Berchtoldstag"),
        (e - timedelta(days=2), "Good Friday"),
        (e + timedelta(days=1), "Easter Monday"),
        (date(year, 5, 1), "Labour Day"),
        (e + timedelta(days=39), "Ascension"),
        (e + timedelta(days=50), "Whit Monday"),
        (date(year, 8, 1), "Swiss National Day"),
        (date(year, 12, 25), "Christmas Day"),
        (date(year, 12, 26), "St. Stephen's Day"),
    ]


def german_holidays(year: int) -> list[tuple[date, str]]:
    """Hesse public holidays."""
    e = easter_sunday(year)
    return [
        (date(year, 1, 1), "New Year's Day"),
        (e - timedelta(days=2), "Good Friday"),
        (e + timedelta(days=1), "Easter Monday"),
        (date(year, 5, 1), "Labour Day"),
        (e + timedelta(days=39), "Ascension Day"),
        (e + timedelta(days=50), "Whit Monday"),
        (e + timedelta(days=60), "Corpus Christi"),
        (date(year, 10, 3), "German Unity Day"),
        (date(year, 12, 25), "Christmas Day"),
        (date(year, 12, 26), "Boxing Day"),
    ]


# ---------------------------------------------------------------------------
# The data
# ---------------------------------------------------------------------------


def build_demo(  # noqa: PLR0915 — one table after another, by design
    today: date,
    *,
    admin_email: str = DEMO_ADMIN_EMAIL,
    instance_title: str = "Demo Instance",
) -> DemoData:
    """The demo data set for `today`.

    `admin_email` is the tenant's system admin (the demo tenant's
    admin@demo.local, or the e-mail a portal admin gave a new tenant) and
    `instance_title` the workspace name shown in the header.
    """
    d = DemoData(today=today, admin_email=admin_email)
    day = timedelta

    d.settings = [("instance_title", instance_title), ("fiscal_year_start", "1")]
    d.predefined_phases = list(PHASE_TYPES)

    d.sites = [
        dict(
            name=WINTERTHUR,
            location="Winterthur",
            city="Winterthur",
            country_code="CH",
            region_code="ZH",
            timezone="Europe/Zurich",
        ),
        dict(
            name=FRANKFURT,
            location="Frankfurt",
            city="Frankfurt",
            country_code="DE",
            region_code="HE",
            timezone="Europe/Berlin",
        ),
    ]

    d.skills = [
        dict(name="Project Management", description="Planning and execution", color="#3b82f6"),
        dict(name="HPLC", description="High-Performance Liquid Chromatography", color="#e74c3c"),
        dict(name="Data Analysis", description="Statistical analysis", color="#8b5cf6"),
        dict(name="Cell Culture", description="Mammalian cell culture", color="#10b981"),
        dict(name="Technical Writing", description="Documentation and reports", color="#f59e0b"),
        dict(name="Quality Control", description="QC procedures", color="#ef4444"),
    ]

    def person(
        email: str,
        first: str,
        last: str,
        title: str,
        role: str,
        sites: list[str],
        skills: tuple[str, ...] = (),
        *,
        max_capacity: int = 100,
        active: bool = True,
        is_system: bool = False,
    ) -> Row:
        return dict(
            email=email,
            first_name=first,
            last_name=last,
            job_title=title,
            role=role,
            sites=list(sites),
            skills=list(skills),
            max_capacity=max_capacity,
            active=active,
            is_system=is_system,
        )

    d.users = [
        person(
            admin_email,
            "Admin",
            "User",
            "System Administrator",
            "admin",
            [WINTERTHUR, FRANKFURT],
            is_system=True,
        ),
        person(
            ALICE,
            "Alice",
            "Anderson",
            "Research Scientist",
            "superuser",
            [WINTERTHUR],
            ("HPLC", "Data Analysis", "Technical Writing"),
        ),
        person(
            BOB,
            "Bob",
            "Brown",
            "Project Manager",
            "superuser",
            [WINTERTHUR],
            ("Project Management", "Technical Writing"),
        ),
        # Part-time: 60 % capacity (ring on the status dot, capacity badge).
        person(
            CHARLIE,
            "Charlie",
            "Clark",
            "Lab Technician",
            "user",
            [WINTERTHUR],
            ("HPLC", "Cell Culture", "Quality Control"),
            max_capacity=60,
        ),
        # On both sites: appears in both site views and the cross-site view.
        person(
            DIANA,
            "Diana",
            "Davis",
            "Data Analyst",
            "user",
            [WINTERTHUR, FRANKFURT],
            ("Data Analysis", "Technical Writing"),
        ),
        # Left the company: the Users panel's inactive state; never assigned.
        person(
            EDWARD,
            "Edward",
            "Evans",
            "Process Engineer",
            "user",
            [WINTERTHUR],
            active=False,
        ),
        person(
            FIONA,
            "Fiona",
            "Fischer",
            "Analytical Chemist",
            "user",
            [FRANKFURT],
            ("HPLC", "Quality Control"),
        ),
        person(
            GEORGE,
            "George",
            "Garcia",
            "R&D Engineer",
            "user",
            [FRANKFURT],
            ("Cell Culture", "Data Analysis"),
        ),
        person(
            HANNAH,
            "Hannah",
            "Harris",
            "Quality Specialist",
            "user",
            [FRANKFURT],
            ("Quality Control",),
        ),
    ]

    d.equipment = [
        dict(name="HPLC System 1", type="Analytical", sites=[WINTERTHUR]),
        # Shared by both sites: one row per site in the equipment lists.
        dict(name="Mass Spectrometer", type="Analytical", sites=[WINTERTHUR, FRANKFURT]),
        dict(name="PCR Thermocycler", type="Molecular Biology", sites=[WINTERTHUR]),
        dict(name="Biosafety Cabinet", type="Cell Culture", sites=[WINTERTHUR]),
        dict(name="Centrifuge", type="General Lab", sites=[WINTERTHUR]),
        dict(name="HPLC System 2", type="Analytical", sites=[FRANKFURT]),
        dict(name="Plate Reader", type="Analytical", sites=[FRANKFURT]),
        dict(name="Freeze Dryer", type="Processing", sites=[FRANKFURT]),
    ]

    d.tag_groups = [
        dict(name="Project type", single_select=True, sort_order=0),
        dict(name="Area", single_select=False, sort_order=1),
    ]
    d.tags = [
        dict(name="Internal", color="#6366f1", group="Project type", sort_order=0, sites=None),
        dict(name="Customer", color="#0ea5e9", group="Project type", sort_order=1, sites=None),
        dict(name="Process", color="#f97316", group="Area", sort_order=0, sites=None),
        dict(name="Analytics", color="#8b5cf6", group="Area", sort_order=1, sites=None),
        dict(name="QA", color="#10b981", group="Area", sort_order=2, sites=None),
        dict(name="Critical", color="#ef4444", group=None, sort_order=0, sites=None),
        dict(name="Tech Transfer", color="#14b8a6", group=None, sort_order=1, sites=None),
        # Site-restricted: only Frankfurt projects may carry it.
        dict(name="GMP", color="#a855f7", group=None, sort_order=2, sites=[FRANKFURT]),
    ]

    def project(
        name: str,
        site: str,
        customer: str,
        confirmed: bool,
        start: date,
        end: date,
        *,
        pm: str | None = None,
        sales_pm: str | None = None,
        tags: tuple[str, ...] = (),
        archived: bool = False,
        notes: str | None = None,
    ) -> Row:
        return dict(
            name=name,
            site=site,
            customer=customer,
            confirmed=confirmed,
            start_date=start,
            end_date=end,
            pm=pm,
            sales_pm=sales_pm,
            tags=list(tags),
            archived=archived,
            notes=notes,
        )

    d.projects = [
        project(
            CATALYST,
            WINTERTHUR,
            "Novachem AG",
            True,
            today - day(30),
            today + day(150),
            sales_pm="M. Keller",
            tags=("Internal", "Critical", "Analytics"),
        ),
        project(
            BIOPROCESS,
            WINTERTHUR,
            "BioGen Ltd",
            True,
            today - day(15),
            today + day(200),
            pm=BOB,
            tags=("Customer", "Critical", "Process", "Tech Transfer"),
        ),
        project(
            ANALYTICAL,
            WINTERTHUR,
            "PharmaCore",
            False,
            today + day(14),
            today + day(120),
            pm=CHARLIE,  # a plain user who manages one project (PM rule)
            sales_pm="S. Weber",
            tags=("Customer", "Analytics", "QA"),
        ),
        project(
            QUALITY,
            FRANKFURT,
            "Internal",
            True,
            today - day(60),
            today + day(90),
            tags=("Internal", "QA", "GMP"),
        ),
        project(
            LEGACY,
            WINTERTHUR,
            "AquaPure GmbH",
            True,
            today - day(120),
            today + day(30),
            archived=True,
        ),
    ]

    # Phases: the five templates back to back over the project; the first phase
    # that has not started yet is blocked (so the Kanban Blocked column is not
    # empty). The archived project gets no phases.
    phase_window: dict[tuple[str, str], tuple[date, date]] = {}
    for p in d.projects:
        if p["archived"]:
            continue
        p_start: date = p["start_date"]
        p_end: date = p["end_date"]
        phase_len = max((p_end - p_start).days // len(PHASE_TYPES), 7)
        blocked_index = next(
            (i for i in range(len(PHASE_TYPES)) if p_start + day(i * phase_len) > today),
            None,
        )
        for i, ptype in enumerate(PHASE_TYPES):
            ps = p_start + day(i * phase_len)
            pe = min(ps + day(phase_len - 1), p_end)
            if ps > p_end:
                break
            completion, status = phase_progress(ps, pe, today)
            if i == blocked_index:
                status = "blocked"
            d.phases.append(
                dict(
                    project=p["name"],
                    type=ptype,
                    start_date=ps,
                    end_date=pe,
                    sort_order=i,
                    completion=completion,
                    status=status,
                    is_milestone=False,
                )
            )
            phase_window[(p["name"], ptype)] = (ps, pe)

    def subphase(
        proj: str,
        phase: str,
        name: str,
        offset: int,
        length: int,
        *,
        parent: str | None = None,
        milestone: bool = False,
        order: int = 0,
    ) -> Row:
        """A subphase inside its phase's window (`offset` days after the phase start)."""
        ps, pe = phase_window[(proj, phase)]
        start = min(ps + day(offset), pe)
        end = start if milestone else min(start + day(max(length - 1, 0)), pe)
        completion, status = phase_progress(start, end, today)
        return dict(
            project=proj,
            phase=phase,
            parent=parent,  # a subphase name → nested (depth 2)
            name=name,
            start_date=start,
            end_date=end,
            is_milestone=milestone,
            sort_order=order,
            depth=2 if parent else 1,
            completion=completion,
            status=status,
        )

    d.subphases = [
        subphase(BIOPROCESS, "Trial", "Pilot batch 1", 0, 14, order=0),
        subphase(BIOPROCESS, "Trial", "Pilot batch 2", 16, 14, order=1),
        subphase(BIOPROCESS, "Trial", "Sampling", 2, 5, parent="Pilot batch 1"),
        subphase(BIOPROCESS, "Trial", "Batch release", 32, 1, milestone=True, order=2),
        subphase(CATALYST, "Analytics", "Screening", 0, 10, order=0),
        subphase(CATALYST, "Analytics", "Kinetics", 10, 12, order=1),
        subphase(QUALITY, "Preparation", "Gap analysis", 0, 8, order=0),
        subphase(QUALITY, "Preparation", "Training plan", 8, 6, order=1),
    ]

    # Dependencies: successor ← predecessor, JSON `{id, type, lag, entity}` on
    # the successor (ids resolved by the loader). The Catalyst FS chain has zero
    # float, so the critical-path screenshot highlights every phase.
    def dep(
        succ: tuple[EntityKind, str, str],
        pred: tuple[EntityKind, str, str],
        dep_type: str = "FS",
        lag: int = 0,
    ) -> Row:
        return dict(successor=succ, predecessor=pred, type=dep_type, lag=lag)

    d.dependencies = [
        dep(("phase", CATALYST, "Analytics"), ("phase", CATALYST, "Preparation")),
        dep(("phase", CATALYST, "Trial"), ("phase", CATALYST, "Analytics")),
        dep(("phase", CATALYST, "Cleaning"), ("phase", CATALYST, "Trial")),
        dep(("phase", CATALYST, "Report"), ("phase", CATALYST, "Cleaning")),
        dep(
            ("subphase", BIOPROCESS, "Pilot batch 2"),
            ("subphase", BIOPROCESS, "Pilot batch 1"),
            "FS",
            2,
        ),
        dep(("phase", BIOPROCESS, "Trial"), ("subphase", BIOPROCESS, "Sampling"), "SS", 0),
    ]

    # Phase assignments: deterministic rotation through each site's active staff
    # (the pool excludes Edward, who is inactive). Alice is over-allocated for a
    # week on Bioprocess via her project-level booking below.
    wt_pool = [ALICE, BOB, CHARLIE, DIANA]
    ff_pool = [FIONA, GEORGE, HANNAH, DIANA]
    allocations = [50, 100, 75, 50, 25]
    for pi, p in enumerate(p for p in d.projects if not p["archived"]):
        pool = wt_pool if p["site"] == WINTERTHUR else ff_pool
        for ph in (x for x in d.phases if x["project"] == p["name"]):
            i = ph["sort_order"]
            first = pool[(pi + i) % len(pool)]
            second = pool[(pi + i + 2) % len(pool)]
            d.phase_assignments.append(
                dict(
                    project=p["name"], phase=ph["type"], staff=first, allocation=allocations[i % 5]
                )
            )
            if i % 2 == 0:
                d.phase_assignments.append(
                    dict(project=p["name"], phase=ph["type"], staff=second, allocation=25)
                )

    trial_start, _ = phase_window[(BIOPROCESS, "Trial")]
    d.project_assignments = [
        dict(
            project=BIOPROCESS,
            staff=BOB,
            allocation=20,
            start_date=today - day(15),
            end_date=today + day(200),
        ),
        # Overlaps Alice's 100 % phase booking → heatmap conflict for that week.
        dict(
            project=BIOPROCESS,
            staff=ALICE,
            allocation=50,
            start_date=trial_start,
            end_date=trial_start + day(6),
        ),
    ]
    d.subphase_assignments = [
        dict(project=BIOPROCESS, subphase="Pilot batch 1", staff=ALICE, allocation=100),
        dict(project=BIOPROCESS, subphase="Pilot batch 2", staff=CHARLIE, allocation=60),
        dict(project=CATALYST, subphase="Screening", staff=DIANA, allocation=50),
    ]

    d.equipment_bookings = [
        dict(
            project=CATALYST,
            equipment="HPLC System 1",
            start_date=today - day(5),
            end_date=today + day(10),
        ),
        # Overlaps the Catalyst booking → OverlapWarningIcon.
        dict(
            project=BIOPROCESS,
            equipment="HPLC System 1",
            start_date=today + day(5),
            end_date=today + day(15),
        ),
        dict(
            project=QUALITY,
            equipment="Plate Reader",
            start_date=today + day(3),
            end_date=today + day(9),
        ),
    ]
    d.equipment_blocks = [
        dict(
            equipment="HPLC System 1",
            start_date=today - day(2),
            end_date=today + day(5),
            reason="maintenance",
            description="Annual preventive maintenance",
        ),
        dict(
            equipment="Mass Spectrometer",
            start_date=today + day(20),
            end_date=today + day(24),
            reason="defect",
            description="Detector lamp replacement",
        ),
        dict(
            equipment="Freeze Dryer",
            start_date=today + day(40),
            end_date=today + day(41),
            reason="maintenance",
            description="Calibration",
        ),
    ]

    for year in (today.year, today.year + 1):
        for when, name in swiss_holidays(year):
            d.bank_holidays.append(dict(site=WINTERTHUR, date=when, name=name, year=year))
        for when, name in german_holidays(year):
            d.bank_holidays.append(dict(site=FRANKFURT, date=when, name=name, year=year))

    shutdown_start = date(today.year, 12, 24)
    if shutdown_start < today:
        shutdown_start = date(today.year + 1, 12, 24)
    d.company_events = [
        dict(
            name="ISO 9001 audit",
            sites=[WINTERTHUR],
            date=today + day(12),
            end_date=today + day(13),
            color="#f59e0b",
            counts_as_unavailable=False,
        ),
        dict(
            name="Year-end shutdown",
            sites=[WINTERTHUR, FRANKFURT],
            date=shutdown_start,
            end_date=date(shutdown_start.year + 1, 1, 2),
            color="#ef4444",
            counts_as_unavailable=True,
        ),
        dict(
            name="Town hall",
            sites=[FRANKFURT],
            date=today + day(30),
            end_date=None,
            color="#3b82f6",
            counts_as_unavailable=False,
        ),
    ]

    d.vacations = [
        dict(
            staff=ALICE,
            start_date=today + day(30),
            end_date=today + day(37),
            description="Summer vacation",
            type="Holidays",
        ),
        dict(
            staff=BOB,
            start_date=today + day(60),
            end_date=today + day(64),
            description="Conference",
            type="Business Trip",
        ),
        dict(
            staff=CHARLIE,
            start_date=today - day(3),
            end_date=today - day(1),
            description="Flu",
            type="Illness",
        ),
        # Recurring Home Office on Mondays and Wednesdays (0 = Sunday).
        dict(
            staff=DIANA,
            start_date=today - day(60),
            end_date=today + day(120),
            description="[R:1,3] Home Office",
            type="Home Office",
        ),
        dict(
            staff=FIONA,
            start_date=today + day(21),
            end_date=today + day(22),
            description="GMP refresher",
            type="Training",
        ),
        dict(
            staff=GEORGE,
            start_date=today + day(45),
            end_date=today + day(52),
            description="Family holiday",
            type="Holidays",
        ),
    ]

    d.custom_columns = [
        dict(
            name="Priority",
            column_type="list",
            list_options='["High", "Medium", "Low"]',
            site=None,
            display_order=0,
            width=110,
        ),
        dict(
            name="Owner",
            column_type="text",
            list_options=None,
            site=None,
            display_order=1,
            width=140,
        ),
        dict(
            name="Reviewed",
            column_type="boolean",
            list_options=None,
            site=None,
            display_order=2,
            width=90,
        ),
        dict(
            name="Lab",
            column_type="list",
            list_options='["Lab A", "Lab B"]',
            site=FRANKFURT,
            display_order=3,
            width=100,
        ),
    ]
    priorities = ["High", "Medium", "Low"]
    owners = ["A. Anderson", "B. Brown", "C. Clark", "D. Davis"]
    for i, ph in enumerate(
        x for x in d.phases if x["project"] in (CATALYST, BIOPROCESS, ANALYTICAL)
    ):
        ent = ("phase", ph["project"], ph["type"])
        d.custom_column_values.append(dict(column="Priority", entity=ent, value=priorities[i % 3]))
        d.custom_column_values.append(dict(column="Owner", entity=ent, value=owners[i % 4]))
        if i % 2 == 0:
            d.custom_column_values.append(
                dict(column="Reviewed", entity=ent, value="true" if i % 4 == 0 else "false")
            )
    for sp in (x for x in d.subphases if x["project"] == BIOPROCESS and not x["is_milestone"]):
        d.custom_column_values.append(
            dict(column="Priority", entity=("subphase", BIOPROCESS, sp["name"]), value="High")
        )
    for i, ph in enumerate(x for x in d.phases if x["project"] == QUALITY):
        d.custom_column_values.append(
            dict(
                column="Lab",
                entity=("phase", QUALITY, ph["type"]),
                value="Lab A" if i % 2 == 0 else "Lab B",
            )
        )

    # Comments: `{mention:<email>}` becomes `@[Full Name](id)` in the loader
    # (app/services/mentions.py wire format); mentioned_user_ids is derived
    # from the final body there, never from this list.
    d.comments = [
        dict(
            project=BIOPROCESS,
            entity=("subphase", BIOPROCESS, "Pilot batch 1"),
            author=BOB,
            body=f"{{mention:{ALICE}}} can you confirm the sampling plan before we book the HPLC?",
        ),
        dict(
            project=BIOPROCESS,
            entity=("subphase", BIOPROCESS, "Pilot batch 1"),
            author=ALICE,
            body="Confirmed — plan is in the shared folder. HPLC System 1 is blocked until next week though.",
        ),
        dict(
            project=BIOPROCESS,
            entity=("subphase", BIOPROCESS, "Pilot batch 1"),
            author=CHARLIE,
            body=f"{{mention:{BOB}}} do we need the second batch at 60 % or full time?",
        ),
        dict(
            project=CATALYST,
            entity=("phase", CATALYST, "Trial"),
            author=ALICE,
            body=f"Kinetics data is in. {{mention:{admin_email}}} — ready for the review on Friday.",
        ),
    ]

    d.notifications = [
        dict(
            user=admin_email,
            type="mention",
            actor=ALICE,
            entity=("phase", CATALYST, "Trial"),
            project=CATALYST,
            title="Alice Anderson mentioned you on Trial",
            body="Kinetics data is in. Ready for the review on Friday.",
            read=False,
        ),
        dict(
            user=admin_email,
            type="assigned",
            actor=BOB,
            entity=("subphase", BIOPROCESS, "Pilot batch 1"),
            project=BIOPROCESS,
            title="Bob Brown assigned you to Pilot batch 1",
            body=None,
            read=False,
        ),
        dict(
            user=admin_email,
            type="status_change",
            actor=BOB,
            entity=("phase", BIOPROCESS, "Preparation"),
            project=BIOPROCESS,
            title="Bob Brown moved Preparation to Done",
            body=None,
            read=True,
        ),
        dict(
            user=ALICE,
            type="mention",
            actor=BOB,
            entity=("subphase", BIOPROCESS, "Pilot batch 1"),
            project=BIOPROCESS,
            title="Bob Brown mentioned you on Pilot batch 1",
            body="Can you confirm the sampling plan before we book the HPLC?",
            read=False,
        ),
    ]

    d.staff_notes = [
        dict(
            site=WINTERTHUR,
            staff=ALICE,
            date=today + day(7),
            text="Covering weekend shift for stability study sampling",
            type="general",
        )
    ]

    return d


# `DEFAULT_IN_PROGRESS_COMPLETION` is re-exported for the tests' pair check.
__all__ = [
    "DemoData",
    "DEFAULT_IN_PROGRESS_COMPLETION",
    "build_demo",
    "phase_progress",
    "easter_sunday",
    "swiss_holidays",
    "german_holidays",
    "PHASE_TYPES",
]
