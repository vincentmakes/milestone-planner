"""
Sites API router.
Handles CRUD operations for sites, bank holidays and company events.

Matches the Node.js API at /api/sites exactly.
"""

import logging
from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin, require_superuser
from app.models.equipment import Equipment, EquipmentSite
from app.models.project import Project
from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite, Site
from app.models.tag import Tag, TagSite
from app.models.team import Team
from app.models.user import User
from app.routers.projects import delete_project_polymorphic_rows
from app.schemas.site import (
    BankHolidayCreate,
    BankHolidayImportRequest,
    BankHolidayResponse,
    BankHolidayUpdate,
    CompanyEventCreate,
    CompanyEventImportRequest,
    CompanyEventImportResult,
    CompanyEventMultiSiteCreate,
    CompanyEventResponse,
    CompanyEventUpdate,
    ImportResult,
    SiteCreate,
    SiteResponse,
    SiteUpdate,
)
from app.services.date_range import MAX_DAY_RANGE, exceeds_max_span, parse_day
from app.services.holidays import (
    custom_holiday_dates,
    custom_holiday_names,
    fetch_holidays,
    is_relevant_holiday,
    should_skip_nager_holiday,
)
from app.services.site_access import can_access_sites, ensure_site_access
from app.services.team_rules import (
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_outside_sites_detail,
)
from app.utils import utcnow_naive

logger = logging.getLogger(__name__)

router = APIRouter()

HOLIDAY_DUPLICATE_DETAIL = "A holiday with this name already exists on this date"


def _validate_range(start: date, end: date | None, label: str = "End date") -> None:
    if end is None:
        return
    if end < start:
        raise HTTPException(status_code=400, detail=f"{label} cannot be before the start date")
    if exceeds_max_span(start, end):
        raise HTTPException(
            status_code=400,
            detail=f"{label} makes the range longer than {MAX_DAY_RANGE} days",
        )


def _holiday_response(h: BankHoliday) -> BankHolidayResponse:
    # Built field by field to avoid lazy loading on the ORM object.
    return BankHolidayResponse(
        id=h.id,
        site_id=h.site_id,
        date=h.date,
        end_date=h.end_date,
        name=h.name,
        is_custom=h.is_custom,
        year=h.year,
        created_at=h.created_at,
    )


# ---------------------------------------------------------
# Sites CRUD
# ---------------------------------------------------------


@router.get("/sites", response_model=list[SiteResponse])
async def get_active_sites(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all active sites.

    Requires authentication.
    Matches: GET /api/sites
    """
    result = await db.execute(select(Site).where(Site.active == 1).order_by(Site.name))
    sites = result.scalars().all()
    return sites


@router.get("/sites/all", response_model=list[SiteResponse])
async def get_all_sites(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get all sites including inactive ones.

    Requires admin authentication.
    Matches: GET /api/sites/all
    """
    result = await db.execute(select(Site).order_by(Site.name))
    sites = result.scalars().all()
    return sites


@router.get("/sites/{site_id}", response_model=SiteResponse)
async def get_site(
    site_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get a specific site by ID.

    Requires authentication.
    """
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    return site


@router.post("/sites", response_model=SiteResponse, status_code=201)
async def create_site(
    data: SiteCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Create a new site.

    Requires admin authentication.
    Matches: POST /api/sites
    """
    site = Site(
        name=data.name,
        location=data.location,
        city=data.city,
        country_code=data.country_code,
        region_code=data.region_code,
        timezone=data.timezone,
        active=1,
    )

    try:
        db.add(site)
        await db.commit()
        await db.refresh(site)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400, detail="A site with this name already exists"
            ) from e
        logger.exception("Database error while saving sites")
        raise HTTPException(status_code=500, detail="Could not save the changes") from e

    # Fetch bank holidays if country code provided
    if site.country_code:
        await fetch_and_store_bank_holidays(db, site)

    return site


@router.put("/sites/{site_id}", response_model=SiteResponse)
async def update_site(
    site_id: int,
    data: SiteUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update a site.

    Requires admin authentication.
    Matches: PUT /api/sites/:id
    """
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    old_country_code = site.country_code

    # Update fields if provided. Name and timezone are required columns, so
    # null means "unchanged" there; the optional fields distinguish an absent
    # key (unchanged) from an explicit null (cleared), so a city/region/
    # country that was once set can be removed again.
    if data.name is not None:
        site.name = data.name
    fields_set = data.model_fields_set
    for field in ("location", "city", "country_code", "region_code"):
        if field in fields_set:
            setattr(site, field, getattr(data, field))
    if data.timezone is not None:
        site.timezone = data.timezone
    if data.active is not None:
        site.active = data.active

    try:
        await db.commit()
        await db.refresh(site)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400, detail="A site with this name already exists"
            ) from e
        logger.exception("Database error while saving sites")
        raise HTTPException(status_code=500, detail="Could not save the changes") from e

    # Re-fetch holidays if country code changed
    if site.country_code and site.country_code != old_country_code:
        await fetch_and_store_bank_holidays(db, site)
        # Refresh again after holiday fetch
        await db.refresh(site)

    # Build response manually to avoid lazy loading issues
    return SiteResponse(
        id=site.id,
        name=site.name,
        location=site.location,
        city=site.city,
        country_code=site.country_code,
        region_code=site.region_code,
        timezone=site.timezone,
        last_holiday_fetch=site.last_holiday_fetch,
        active=site.active,
        created_at=site.created_at,
    )


@router.delete("/sites/{site_id}")
async def delete_site(
    site_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete a site.

    Requires admin authentication.
    Matches: DELETE /api/sites/:id
    """
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    # Events and equipment linked to this site; the junction rows go with the
    # site (ON DELETE CASCADE), so remember the ids to clean up orphans afterwards.
    # The site's teams cascade with it too, and with them every team link
    # (team_members, project/tag/equipment/company-event teams): a surviving
    # event or piece of equipment keeps only its teams at its other sites.
    linked = await db.execute(
        select(CompanyEventSite.event_id).where(CompanyEventSite.site_id == site_id)
    )
    event_ids = list(linked.scalars().all())
    linked = await db.execute(
        select(EquipmentSite.equipment_id).where(EquipmentSite.site_id == site_id)
    )
    equipment_ids = list(linked.scalars().all())

    # The site's projects go with it (ORM cascade + FK ON DELETE CASCADE), but
    # their card comments and custom-column values are polymorphic rows with
    # no FK and must be removed explicitly, like DELETE /projects/{id} does.
    linked = await db.execute(select(Project.id).where(Project.site_id == site_id))
    await delete_project_polymorphic_rows(db, list(linked.scalars().all()))

    # Tags restricted to this site (their tag_sites rows, and the tag_teams
    # rows of the site's teams, cascade too).
    linked = await db.execute(select(TagSite.tag_id).where(TagSite.site_id == site_id))
    tag_ids = list(linked.scalars().all())

    await db.delete(site)
    await db.flush()

    # Events shared with other sites survive; those left without a site go.
    if event_ids:
        await db.execute(
            delete(CompanyEvent)
            .where(CompanyEvent.id.in_(event_ids))
            .where(~exists().where(CompanyEventSite.event_id == CompanyEvent.id))
            .execution_options(synchronize_session=False)
        )

    # Same for equipment: survivors get a remaining linked site as their
    # primary site (equipment.site_id was set to NULL by the FK).
    if equipment_ids:
        await db.execute(
            delete(Equipment)
            .where(Equipment.id.in_(equipment_ids))
            .where(~exists().where(EquipmentSite.equipment_id == Equipment.id))
            .execution_options(synchronize_session=False)
        )
        remaining_site = (
            select(func.min(EquipmentSite.site_id))
            .where(EquipmentSite.equipment_id == Equipment.id)
            .scalar_subquery()
        )
        await db.execute(
            update(Equipment)
            .where(Equipment.id.in_(equipment_ids))
            .values(site_id=remaining_site)
            .execution_options(synchronize_session=False)
        )

    # A site-restricted tag left without any site applies nowhere: delete it.
    if tag_ids:
        await db.execute(
            delete(Tag)
            .where(Tag.id.in_(tag_ids))
            .where(Tag.all_sites.is_(False))
            .where(~exists().where(TagSite.tag_id == Tag.id))
            .execution_options(synchronize_session=False)
        )

    await db.commit()

    return {"success": True}


# ---------------------------------------------------------
# Bank Holidays
# ---------------------------------------------------------


@router.get("/sites/{site_id}/holidays", response_model=list[BankHolidayResponse])
async def get_site_holidays(
    site_id: int,
    year: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get bank holidays for a site.

    Optionally filter by year.
    Matches: GET /api/sites/:id/holidays
    """
    query = select(BankHoliday).where(BankHoliday.site_id == site_id)

    if year:
        query = query.where(BankHoliday.year == year)

    query = query.order_by(BankHoliday.date)

    result = await db.execute(query)
    holidays = result.scalars().all()

    return holidays


@router.post("/sites/{site_id}/holidays", response_model=BankHolidayResponse, status_code=201)
async def add_custom_holiday(
    site_id: int,
    data: BankHolidayCreate,
    db: AsyncSession = Depends(get_db),
    superuser: User = Depends(require_superuser),
):
    """
    Add a custom bank holiday.

    Requires superuser authentication; superusers only for their own sites.
    Matches: POST /api/sites/:id/holidays
    """
    # Verify site exists
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    ensure_site_access(
        superuser, [site_id], "You can only manage holidays for sites you're assigned to"
    )
    _validate_range(data.date, data.end_date)

    holiday = BankHoliday(
        site_id=site_id,
        date=data.date,
        end_date=data.end_date or data.date,
        name=data.name,
        is_custom=1,
        year=data.date.year,
    )

    try:
        db.add(holiday)
        await db.commit()
        await db.refresh(holiday)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(status_code=400, detail=HOLIDAY_DUPLICATE_DETAIL) from e
        logger.exception("Database error while saving sites")
        raise HTTPException(status_code=500, detail="Could not save the changes") from e

    return holiday


@router.post("/sites/{site_id}/holidays/import", response_model=ImportResult)
async def import_holidays(
    site_id: int,
    data: BankHolidayImportRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Import holidays into a site (e.g. parsed from an .ics file).

    Rows are stored as custom holidays, so a later Nager refresh never replaces
    them. Items whose (date, name) already exists on the site - or repeats
    within the batch - are skipped. All rows are written in one transaction.
    """
    site = await db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    ensure_site_access(user, [site_id], "You can only manage holidays for sites you're assigned to")

    for index, item in enumerate(data.items):
        _validate_range(item.date, item.end_date, label=f"Item {index + 1}: end date")

    existing = await db.execute(
        select(BankHoliday.date, BankHoliday.name).where(BankHoliday.site_id == site_id)
    )
    taken = {(row.date, row.name) for row in existing}

    created = skipped = 0
    for item in data.items:
        name = item.name.strip() or item.name
        key = (item.date, name)
        if key in taken:
            skipped += 1
            continue
        taken.add(key)
        db.add(
            BankHoliday(
                site_id=site_id,
                date=item.date,
                end_date=item.end_date or item.date,
                name=name,
                is_custom=1,
                year=item.date.year,
            )
        )
        created += 1

    if created:
        try:
            await db.commit()
        except IntegrityError as e:
            await db.rollback()
            raise HTTPException(status_code=400, detail=HOLIDAY_DUPLICATE_DETAIL) from e

    return {"created": created, "skipped": skipped}


@router.put("/sites/{site_id}/holidays/{holiday_id}", response_model=BankHolidayResponse)
async def update_holiday(
    site_id: int,
    holiday_id: int,
    data: BankHolidayUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Edit a bank holiday.

    Any holiday can be edited, including ones fetched from Nager. An edited
    holiday becomes custom (is_custom=1): custom holidays win over Nager for
    their dates, and a Nager holiday moved to another date is recognised by its
    name (same year, trimmed, case-insensitive), so the edit survives the next
    refresh. Limitation: a holiday both renamed and moved is no longer
    recognised, and the Nager original returns at its original date.
    """
    result = await db.execute(
        select(BankHoliday)
        .where(BankHoliday.id == holiday_id)
        .where(BankHoliday.site_id == site_id)
    )
    holiday = result.scalar_one_or_none()

    if not holiday:
        raise HTTPException(status_code=404, detail="Holiday not found")

    ensure_site_access(user, [site_id], "You can only manage holidays for sites you're assigned to")

    if data.date is not None:
        # A single-day holiday moves as a whole when only its date changes.
        if "end_date" not in data.model_fields_set and (
            holiday.end_date is None or holiday.end_date == holiday.date
        ):
            holiday.end_date = data.date
        holiday.date = data.date
        holiday.year = data.date.year
    if "end_date" in data.model_fields_set:
        holiday.end_date = data.end_date or holiday.date
    if data.name is not None:
        holiday.name = data.name.strip() or data.name

    _validate_range(holiday.date, holiday.end_date)
    holiday.is_custom = 1

    try:
        await db.commit()
        await db.refresh(holiday)
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=HOLIDAY_DUPLICATE_DETAIL) from e

    return _holiday_response(holiday)


@router.delete("/sites/{site_id}/holidays/{holiday_id}")
async def delete_holiday(
    site_id: int,
    holiday_id: int,
    db: AsyncSession = Depends(get_db),
    superuser: User = Depends(require_superuser),
):
    """
    Delete a bank holiday.

    Works for custom and Nager holidays alike; a deleted Nager holiday comes
    back on the next refresh.
    Requires superuser authentication; superusers only for their own sites.
    Matches: DELETE /api/sites/:siteId/holidays/:id
    """
    result = await db.execute(
        select(BankHoliday)
        .where(BankHoliday.id == holiday_id)
        .where(BankHoliday.site_id == site_id)
    )
    holiday = result.scalar_one_or_none()

    if not holiday:
        raise HTTPException(status_code=404, detail="Holiday not found")

    ensure_site_access(
        superuser, [site_id], "You can only manage holidays for sites you're assigned to"
    )

    await db.delete(holiday)
    await db.commit()

    return {"success": True}


@router.post("/sites/{site_id}/holidays/refresh", response_model=list[BankHolidayResponse])
async def refresh_bank_holidays(
    site_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Refresh bank holidays from external API.

    Re-fetches and replaces existing non-custom holidays. If the holiday API is
    unreachable, the currently stored holidays are kept.
    Requires admin or superuser authentication.
    Superusers can only refresh holidays for sites they're assigned to.
    Matches: POST /api/sites/:id/holidays/refresh
    """
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    # Check site access for non-admin users
    ensure_site_access(
        user, [site_id], "You can only refresh holidays for sites you're assigned to"
    )

    if not site.country_code:
        raise HTTPException(status_code=400, detail="Site has no country code configured")

    # Fetch fresh holidays; existing non-custom holidays are replaced only if
    # the API actually returned data (see fetch_and_store_bank_holidays)
    await fetch_and_store_bank_holidays(db, site, replace_existing=True)

    # Return updated list - build response manually to avoid lazy loading
    result = await db.execute(
        select(BankHoliday).where(BankHoliday.site_id == site_id).order_by(BankHoliday.date)
    )
    holidays = result.scalars().all()

    return [_holiday_response(h) for h in holidays]


@router.get("/holidays", response_model=list[BankHolidayResponse])
async def get_holidays_in_range(
    siteId: int = Query(...),
    startDate: str | None = Query(None),
    endDate: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get holidays for a site within a date range.

    Used by Gantt visualization.
    Matches: GET /api/holidays
    """
    query = select(BankHoliday).where(BankHoliday.site_id == siteId)

    if startDate and endDate:
        # Parse date strings to date objects for proper comparison (400 on junk)
        start = parse_day(startDate, "startDate")
        end = parse_day(endDate, "endDate")
        # Overlap, not start-in-range: a multi-day holiday that began before
        # the window still shows in it.
        query = query.where(BankHoliday.date <= end)
        query = query.where(func.coalesce(BankHoliday.end_date, BankHoliday.date) >= start)

    query = query.order_by(BankHoliday.date)

    result = await db.execute(query)
    holidays = result.scalars().all()

    return holidays


# ---------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------


async def fetch_and_store_bank_holidays(
    db: AsyncSession,
    site: Site,
    replace_existing: bool = False,
) -> int:
    """
    Fetch bank holidays from the Nager holiday API and store them.

    Fetches for the current and next year. Returns the number of holidays
    stored; failures are logged rather than raised, so creating or editing a
    site still succeeds when the API is unreachable.

    Imported (non-custom) holidays of each fetched year are replaced, so
    changing a site's country does not leave stale entries behind. With
    ``replace_existing`` the site's imported holidays of years outside the
    fetched ones are cleared too. A year is only replaced when the API
    actually returned data for it, so an unreachable API (or one failed year)
    leaves the stored holidays of that year in place. Custom holidays are never
    touched, and a Nager holiday falling on a day already covered by a custom
    holiday, or sharing its name (trimmed, case-insensitive) with a custom
    holiday of the same year, is not stored.
    """
    # Extract values FIRST to avoid lazy loading issues after async operations
    site_id = site.id
    country_code = site.country_code
    region_code = site.region_code

    logger.info(
        "Fetching holidays for site %s, country=%s, region=%s", site_id, country_code, region_code
    )

    current_year = datetime.now().year
    years = [current_year, current_year + 1]

    # Fetch everything before touching the database, so a failed request cannot
    # leave the site with fewer holidays than it started with.
    fetched = [(year, await fetch_holidays(country_code, year)) for year in years]

    total_added = 0

    # A failed request looks like an empty year (fetch_holidays returns []), so
    # only the years that returned data are replaced; the others keep what
    # they have.
    ok_years = [year for year, holidays in fetched if holidays]
    if not ok_years:
        logger.warning(
            "Holiday API returned nothing for site %s - keeping existing holidays", site_id
        )
    else:
        # Replace the imported holidays. Custom holidays are always preserved.
        replaced = BankHoliday.year.in_(ok_years)
        if replace_existing:
            # Also drop imported holidays of years no longer fetched (stale).
            replaced = or_(replaced, BankHoliday.year.notin_(years))
        stmt = (
            delete(BankHoliday)
            .where(BankHoliday.site_id == site_id)
            .where(BankHoliday.is_custom == 0)
            .where(replaced)
        )
        await db.execute(stmt)
        await db.flush()

        # The unique constraint is (site_id, date, name). Custom holidays
        # survive the delete above and can collide, so check up front rather
        # than relying on a failed INSERT. Custom holidays also win over Nager
        # for every day they cover, and over a same-name Nager holiday in the
        # same year (a moved holiday; see should_skip_nager_holiday).
        existing = (
            await db.execute(
                select(
                    BankHoliday.date,
                    BankHoliday.end_date,
                    BankHoliday.name,
                    BankHoliday.is_custom,
                ).where(BankHoliday.site_id == site_id)
            )
        ).all()
        taken = {(row.date, row.name) for row in existing}
        custom_rows = [row for row in existing if row.is_custom]
        custom_dates = custom_holiday_dates((row.date, row.end_date) for row in custom_rows)
        custom_names = custom_holiday_names((row.date, row.name) for row in custom_rows)

        for year, holidays in fetched:
            for holiday in holidays:
                if not is_relevant_holiday(holiday, region_code):
                    continue

                if should_skip_nager_holiday(
                    holiday.date, holiday.name, taken, custom_dates, custom_names
                ):
                    logger.debug("Skipped duplicate holiday %s %s", holiday.date, holiday.name)
                    continue
                taken.add((holiday.date, holiday.name))

                db.add(
                    BankHoliday(
                        site_id=site_id,
                        date=holiday.date,
                        end_date=holiday.date,
                        name=holiday.name,
                        is_custom=0,
                        year=year,
                    )
                )
                total_added += 1

    logger.info("Added %d holidays for site %s", total_added, site_id)

    # Update last fetch timestamp
    site.last_holiday_fetch = utcnow_naive()
    await db.commit()

    return total_added


# ---------------------------------------------------------
# Company Events CRUD
# ---------------------------------------------------------
#
# An event can apply to several sites; the links live in company_event_sites.
# company_events.site_id is a legacy column, set to the first linked site so
# clients that predate multi-site events keep working.

EVENT_SITE_ACCESS_DETAIL = "You can only manage events for sites you're assigned to"


async def _event_site_ids(db: AsyncSession, event_ids: list[int]) -> dict[int, list[int]]:
    """Map each event id to its sorted linked site ids (one query)."""
    if not event_ids:
        return {}
    result = await db.execute(
        select(CompanyEventSite.event_id, CompanyEventSite.site_id).where(
            CompanyEventSite.event_id.in_(event_ids)
        )
    )
    links: dict[int, list[int]] = defaultdict(list)
    for row in result:
        links[row.event_id].append(row.site_id)
    return {event_id: sorted(site_ids) for event_id, site_ids in links.items()}


def _event_response(event: CompanyEvent, site_ids: Iterable[int]) -> CompanyEventResponse:
    ids = sorted(set(site_ids))
    return CompanyEventResponse(
        id=event.id,
        site_id=ids[0] if ids else event.site_id,
        site_ids=ids,
        date=event.date,
        end_date=event.end_date,
        name=event.name,
        color=event.color,
        counts_as_unavailable=bool(event.counts_as_unavailable),
        team_ids=sorted(t.id for t in event.teams),
        created_at=event.created_at,
    )


async def _ensure_sites_exist(db: AsyncSession, site_ids: Iterable[int]) -> list[int]:
    """Return the de-duplicated, sorted site ids; 404 if any does not exist."""
    wanted = sorted(set(site_ids))
    result = await db.execute(select(Site.id).where(Site.id.in_(wanted)))
    if set(result.scalars().all()) != set(wanted):
        raise HTTPException(status_code=404, detail="Site not found")
    return wanted


async def _events_for_site(db: AsyncSession, query) -> list[CompanyEventResponse]:
    """Run an events query and attach every event's site links."""
    result = await db.execute(query.order_by(CompanyEvent.date, CompanyEvent.id))
    events = list(result.scalars().all())
    links = await _event_site_ids(db, [e.id for e in events])
    return [_event_response(e, links.get(e.id, [])) for e in events]


async def _create_event(
    db: AsyncSession,
    site_ids: list[int],
    event_date: date,
    end_date: date | None,
    name: str,
    color: str | None,
    counts_as_unavailable: bool = False,
    teams: list[Team] | None = None,
) -> CompanyEvent:
    """Create an event linked to the given (validated, sorted) sites and teams and commit."""
    event = CompanyEvent(
        site_id=site_ids[0],
        date=event_date,
        end_date=end_date,
        name=name,
        color=color,
        counts_as_unavailable=counts_as_unavailable,
        teams=teams or [],
    )
    db.add(event)
    await db.flush()
    db.add_all([CompanyEventSite(event_id=event.id, site_id=sid) for sid in site_ids])
    await db.commit()
    await db.refresh(event)
    return event


def _site_events_query(site_id: int):
    return (
        select(CompanyEvent)
        .join(CompanyEventSite, CompanyEventSite.event_id == CompanyEvent.id)
        .where(CompanyEventSite.site_id == site_id)
    )


@router.get("/sites/{site_id}/events", response_model=list[CompanyEventResponse])
async def get_company_events(
    site_id: int,
    year: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get company events linked to a site.

    Optionally filter by year.
    """
    query = _site_events_query(site_id)

    if year:
        from sqlalchemy import extract

        query = query.where(extract("year", CompanyEvent.date) == year)

    return await _events_for_site(db, query)


@router.get("/events", response_model=list[CompanyEventResponse])
async def get_events_in_range(
    siteId: int = Query(...),
    startDate: str | None = Query(None),
    endDate: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get company events linked to a site within a date range.

    Used by Gantt visualization.
    """
    query = _site_events_query(siteId)

    # Overlap, not start-in-range: a multi-day event that began before the
    # window still shows in it.
    if startDate:
        start = parse_day(startDate, "startDate")
        query = query.where(func.coalesce(CompanyEvent.end_date, CompanyEvent.date) >= start)

    if endDate:
        query = query.where(CompanyEvent.date <= parse_day(endDate, "endDate"))

    return await _events_for_site(db, query)


@router.post("/events", response_model=CompanyEventResponse, status_code=201)
async def create_multi_site_event(
    data: CompanyEventMultiSiteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create a company event on one or more sites, optionally limited to teams
    at those sites.

    Requires superuser or admin role; superusers only for their own sites.
    """
    site_ids = await _ensure_sites_exist(db, data.site_ids)
    ensure_site_access(user, site_ids, EVENT_SITE_ACCESS_DETAIL)
    teams = await load_teams(db, data.team_ids or [])
    ensure_teams_within_sites(teams, site_ids, team_outside_sites_detail)
    _validate_range(data.date, data.end_date)

    event = await _create_event(
        db,
        site_ids,
        data.date,
        data.end_date,
        data.name,
        data.color,
        data.counts_as_unavailable,
        teams=teams,
    )
    return _event_response(event, site_ids)


# Declared before /events/{event_id} for readability; the methods differ anyway.
@router.post("/events/import", response_model=CompanyEventImportResult)
async def import_company_events(
    data: CompanyEventImportRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Import company events into one or more sites (e.g. parsed from an .ics file).

    An existing event with the same (date, end_date, name) is reused: it gains
    any missing site links (counted in ``linked``) instead of being duplicated.
    Only events the user may manage on every site they are already linked to
    are reused -- linking a superuser's site to an event that also lives on a
    foreign site would let them hijack (edit/delete) it there. Otherwise a new
    event is created for the target sites no same-name event covers yet.
    Items whose target sites already all show such an event, and repeats
    within the batch, are skipped. All rows are written in one transaction.
    """
    site_ids = await _ensure_sites_exist(db, data.site_ids)
    ensure_site_access(user, site_ids, EVENT_SITE_ACCESS_DETAIL)

    for index, item in enumerate(data.items):
        _validate_range(item.date, item.end_date, label=f"Item {index + 1}: end date")

    def key_of(event_date: date, end_date: date | None, name: str) -> tuple[date, date, str]:
        # A missing end date means a single-day event, same as end == start.
        return (event_date, end_date or event_date, name)

    # Existing candidates: same dates and names as the batch (oldest first).
    existing_by_key: dict[tuple[date, date, str], list[CompanyEvent]] = defaultdict(list)
    if data.items:
        result = await db.execute(
            select(CompanyEvent)
            .where(CompanyEvent.date.in_(sorted({item.date for item in data.items})))
            .where(
                CompanyEvent.name.in_(
                    sorted({item.name.strip() or item.name for item in data.items})
                )
            )
            .order_by(CompanyEvent.id)
        )
        for event in result.scalars().all():
            existing_by_key[key_of(event.date, event.end_date, event.name)].append(event)
    links = await _event_site_ids(db, [e.id for events in existing_by_key.values() for e in events])

    target = set(site_ids)
    created_events: list[tuple[CompanyEvent, list[int]]] = []
    seen: set[tuple[date, date, str]] = set()
    linked = skipped = 0

    for item in data.items:
        name = item.name.strip() or item.name
        key = key_of(item.date, item.end_date, name)
        if key in seen:
            skipped += 1
            continue
        seen.add(key)

        candidates = existing_by_key.get(key, [])
        covered = {sid for event in candidates for sid in links.get(event.id, [])}
        missing = sorted(target - covered)
        if not missing:
            skipped += 1
            continue

        reusable = next(
            (e for e in candidates if can_access_sites(user, links.get(e.id, []))), None
        )
        if reusable is not None:
            db.add_all([CompanyEventSite(event_id=reusable.id, site_id=sid) for sid in missing])
            linked += 1
            continue

        event = CompanyEvent(
            site_id=missing[0],
            date=item.date,
            end_date=item.end_date or item.date,
            name=name,
            color=data.color,
            counts_as_unavailable=data.counts_as_unavailable,
        )
        db.add(event)
        created_events.append((event, missing))

    if created_events:
        await db.flush()
        db.add_all(
            [
                CompanyEventSite(event_id=event.id, site_id=sid)
                for event, event_site_ids in created_events
                for sid in event_site_ids
            ]
        )

    if created_events or linked:
        await db.commit()

    return {"created": len(created_events), "linked": linked, "skipped": skipped}


@router.put("/events/{event_id}", response_model=CompanyEventResponse)
async def update_company_event(
    event_id: int,
    data: CompanyEventUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Edit a company event. ``site_ids``, when given, replaces its site links;
    ``team_ids``, when given, replaces its teams (each at one of the new
    sites). A site change alone drops the teams of the removed sites.

    Superusers must belong to every site the event is linked to, before and
    after the change.
    """
    event = await db.get(CompanyEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    current = (await _event_site_ids(db, [event_id])).get(event_id, [])
    ensure_site_access(user, current, EVENT_SITE_ACCESS_DETAIL)

    new_site_ids = current
    if data.site_ids is not None:
        new_site_ids = await _ensure_sites_exist(db, data.site_ids)
        ensure_site_access(user, new_site_ids, EVENT_SITE_ACCESS_DETAIL)

    # Validated before anything is written; applied after the site links.
    new_teams: list[Team] | None = None
    if data.team_ids is not None:
        new_teams = await load_teams(db, data.team_ids)
        ensure_teams_within_sites(new_teams, new_site_ids, team_outside_sites_detail)

    if data.date is not None:
        event.date = data.date
    if "end_date" in data.model_fields_set:
        event.end_date = data.end_date
    if data.name is not None:
        event.name = data.name.strip() or data.name
    if "color" in data.model_fields_set:
        event.color = data.color
    if data.counts_as_unavailable is not None:
        event.counts_as_unavailable = data.counts_as_unavailable
    _validate_range(event.date, event.end_date)

    if data.site_ids is not None:
        removed = set(current) - set(new_site_ids)
        added = set(new_site_ids) - set(current)
        if removed:
            await db.execute(
                delete(CompanyEventSite)
                .where(CompanyEventSite.event_id == event_id)
                .where(CompanyEventSite.site_id.in_(sorted(removed)))
            )
        if added:
            db.add_all([CompanyEventSite(event_id=event_id, site_id=sid) for sid in sorted(added)])
        event.site_id = new_site_ids[0]

    if new_teams is not None:
        event.teams = new_teams
    elif data.site_ids is not None:
        event.teams = prune_teams_to_sites(event.teams, new_site_ids)

    await db.commit()
    await db.refresh(event)

    return _event_response(event, new_site_ids)


@router.delete("/events/{event_id}")
async def delete_event(
    event_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a company event from every site it is linked to.

    Superusers must belong to all of those sites.
    """
    event = await db.get(CompanyEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    current = (await _event_site_ids(db, [event_id])).get(event_id, [])
    ensure_site_access(user, current, EVENT_SITE_ACCESS_DETAIL)

    await db.delete(event)
    await db.commit()

    return {"success": True}


@router.post("/sites/{site_id}/events", response_model=CompanyEventResponse)
async def create_company_event(
    site_id: int,
    event_data: CompanyEventCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create a company event on a single site (legacy route; see POST /events).

    Requires superuser or admin role; superusers only for their own sites.
    """
    # Verify site exists
    site = await db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    ensure_site_access(user, [site_id], EVENT_SITE_ACCESS_DETAIL)
    _validate_range(event_data.date, event_data.end_date)

    event = await _create_event(
        db,
        [site_id],
        event_data.date,
        event_data.end_date,
        event_data.name,
        event_data.color,
        event_data.counts_as_unavailable,
    )
    return _event_response(event, [site_id])


@router.delete("/sites/{site_id}/events/{event_id}")
async def delete_company_event(
    site_id: int,
    event_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Remove a company event from one site (legacy route).

    The event itself is deleted only when no other site remains linked to it.
    Requires superuser or admin role; superusers only for their own sites.
    """
    event = await db.get(CompanyEvent, event_id)

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    current = (await _event_site_ids(db, [event_id])).get(event_id, [])
    if site_id not in current:
        raise HTTPException(status_code=404, detail="Event not found for this site")

    ensure_site_access(user, [site_id], EVENT_SITE_ACCESS_DETAIL)

    remaining = [sid for sid in current if sid != site_id]
    if remaining:
        await db.execute(
            delete(CompanyEventSite)
            .where(CompanyEventSite.event_id == event_id)
            .where(CompanyEventSite.site_id == site_id)
        )
        if event.site_id == site_id:
            event.site_id = remaining[0]
    else:
        await db.delete(event)

    await db.commit()

    return {"success": True}
