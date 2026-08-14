"""
Sites API router.
Handles CRUD operations for sites and bank holidays.

Matches the Node.js API at /api/sites exactly.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin, require_superuser
from app.models.site import BankHoliday, CompanyEvent, Site
from app.models.user import User
from app.schemas.site import (
    BankHolidayCreate,
    BankHolidayResponse,
    CompanyEventCreate,
    CompanyEventResponse,
    SiteCreate,
    SiteResponse,
    SiteUpdate,
)
from app.services.holidays import fetch_holidays, is_relevant_holiday
from app.utils import utcnow_naive

logger = logging.getLogger(__name__)

router = APIRouter()


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
        raise HTTPException(status_code=500, detail=str(e)) from e

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

    # Update fields if provided
    if data.name is not None:
        site.name = data.name
    if data.location is not None:
        site.location = data.location
    if data.city is not None:
        site.city = data.city
    if data.country_code is not None:
        site.country_code = data.country_code
    if data.region_code is not None:
        site.region_code = data.region_code
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
        raise HTTPException(status_code=500, detail=str(e)) from e

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

    await db.delete(site)
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

    Requires superuser authentication.
    Matches: POST /api/sites/:id/holidays
    """
    # Verify site exists
    result = await db.execute(select(Site).where(Site.id == site_id))
    site = result.scalar_one_or_none()

    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

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
            raise HTTPException(
                status_code=400, detail="A holiday with this name already exists on this date"
            ) from e
        raise HTTPException(status_code=500, detail=str(e)) from e

    return holiday


@router.delete("/sites/{site_id}/holidays/{holiday_id}")
async def delete_custom_holiday(
    site_id: int,
    holiday_id: int,
    db: AsyncSession = Depends(get_db),
    superuser: User = Depends(require_superuser),
):
    """
    Delete a custom bank holiday.

    Cannot delete base (non-custom) holidays.
    Requires superuser authentication.
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

    if not holiday.is_custom:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete base bank holidays. Only custom holidays can be deleted.",
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
    if user.role != "admin":
        user_site_ids = [s.id for s in user.sites] if user.sites else []
        if site_id not in user_site_ids:
            raise HTTPException(
                status_code=403, detail="You can only refresh holidays for sites you're assigned to"
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

    return [
        BankHolidayResponse(
            id=h.id,
            site_id=h.site_id,
            date=h.date,
            end_date=h.end_date,
            name=h.name,
            is_custom=h.is_custom,
            year=h.year,
            created_at=h.created_at,
        )
        for h in holidays
    ]


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
    from datetime import datetime as dt

    query = select(BankHoliday).where(BankHoliday.site_id == siteId)

    if startDate and endDate:
        # Parse date strings to date objects for proper comparison
        start = dt.strptime(startDate, "%Y-%m-%d").date()
        end = dt.strptime(endDate, "%Y-%m-%d").date()
        query = query.where(BankHoliday.date >= start)
        query = query.where(BankHoliday.date <= end)

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

    Imported (non-custom) holidays for the fetched years are replaced, so
    changing a site's country does not leave stale entries behind. With
    ``replace_existing`` the site's imported holidays are cleared for *all*
    years instead. Either way the deletion only happens once the API has
    actually returned data, so an unreachable API leaves the stored holidays in
    place. Custom holidays are never touched.
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

    if not any(holidays for _, holidays in fetched):
        logger.warning(
            "Holiday API returned nothing for site %s - keeping existing holidays", site_id
        )
    else:
        # Replace the imported holidays. Custom holidays are always preserved.
        stmt = (
            delete(BankHoliday)
            .where(BankHoliday.site_id == site_id)
            .where(BankHoliday.is_custom == 0)
        )
        if not replace_existing:
            stmt = stmt.where(BankHoliday.year.in_(years))
        await db.execute(stmt)
        await db.flush()

        # The unique constraint is (site_id, date, name). Custom holidays
        # survive the delete above and can collide, so check up front rather
        # than relying on a failed INSERT.
        existing = await db.execute(
            select(BankHoliday.date, BankHoliday.name).where(BankHoliday.site_id == site_id)
        )
        taken = {(row.date, row.name) for row in existing}

        for year, holidays in fetched:
            for holiday in holidays:
                if not is_relevant_holiday(holiday, region_code):
                    continue

                key = (holiday.date, holiday.name)
                if key in taken:
                    logger.debug("Skipped duplicate holiday %s %s", holiday.date, holiday.name)
                    continue
                taken.add(key)

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


@router.get("/sites/{site_id}/events", response_model=list[CompanyEventResponse])
async def get_company_events(
    site_id: int,
    year: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get company events for a site.

    Optionally filter by year.
    """
    query = select(CompanyEvent).where(CompanyEvent.site_id == site_id)

    if year:
        from sqlalchemy import extract

        query = query.where(extract("year", CompanyEvent.date) == year)

    query = query.order_by(CompanyEvent.date)
    result = await db.execute(query)
    events = result.scalars().all()

    return [
        CompanyEventResponse(
            id=e.id,
            site_id=e.site_id,
            date=e.date,
            end_date=e.end_date,
            name=e.name,
            color=e.color,
            created_at=e.created_at,
        )
        for e in events
    ]


@router.get("/events", response_model=list[CompanyEventResponse])
async def get_events_in_range(
    siteId: int = Query(...),
    startDate: str | None = Query(None),
    endDate: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get company events for a site within a date range.

    Used by Gantt visualization.
    """
    from datetime import datetime as dt

    query = select(CompanyEvent).where(CompanyEvent.site_id == siteId)

    if startDate:
        try:
            start = dt.strptime(startDate, "%Y-%m-%d").date()
            query = query.where(CompanyEvent.date >= start)
        except ValueError:
            pass

    if endDate:
        try:
            end = dt.strptime(endDate, "%Y-%m-%d").date()
            query = query.where(CompanyEvent.date <= end)
        except ValueError:
            pass

    query = query.order_by(CompanyEvent.date)
    result = await db.execute(query)
    events = result.scalars().all()

    return [
        CompanyEventResponse(
            id=e.id,
            site_id=e.site_id,
            date=e.date,
            end_date=e.end_date,
            name=e.name,
            color=e.color,
            created_at=e.created_at,
        )
        for e in events
    ]


@router.post("/sites/{site_id}/events", response_model=CompanyEventResponse)
async def create_company_event(
    site_id: int,
    event_data: CompanyEventCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create a company event.

    Requires superuser or admin role.
    """
    # Verify site exists
    site = await db.get(Site, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    event = CompanyEvent(
        site_id=site_id,
        date=event_data.date,
        end_date=event_data.end_date,
        name=event_data.name,
        color=event_data.color,
    )

    db.add(event)
    await db.commit()
    await db.refresh(event)

    return CompanyEventResponse(
        id=event.id,
        site_id=event.site_id,
        date=event.date,
        end_date=event.end_date,
        name=event.name,
        color=event.color,
        created_at=event.created_at,
    )


@router.delete("/sites/{site_id}/events/{event_id}")
async def delete_company_event(
    site_id: int,
    event_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a company event.

    Requires superuser or admin role.
    """
    event = await db.get(CompanyEvent, event_id)

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if event.site_id != site_id:
        raise HTTPException(status_code=404, detail="Event not found for this site")

    await db.delete(event)
    await db.commit()

    return {"success": True}
