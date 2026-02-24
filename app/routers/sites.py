"""
Sites API router.
Handles CRUD operations for sites and bank holidays.

Matches the Node.js API at /api/sites exactly.
"""

from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
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

    Clears existing non-custom holidays and re-fetches.
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

    # Delete existing non-custom holidays
    await db.execute(
        delete(BankHoliday).where(BankHoliday.site_id == site_id).where(BankHoliday.is_custom == 0)
    )

    # Fetch fresh holidays
    await fetch_and_store_bank_holidays(db, site)

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
) -> None:
    """
    Fetch bank holidays from Nager.Date API and store them.

    Fetches for current year and next year.
    """
    # Extract values FIRST to avoid lazy loading issues after async operations
    site_id = site.id
    country_code = site.country_code
    region_code = site.region_code

    print(f"Fetching holidays for site {site_id}, country={country_code}, region={region_code}")

    settings = get_settings()
    current_year = datetime.now().year
    years = [current_year, current_year + 1]

    total_added = 0

    # Get proxy configuration (supports PAC files and direct proxy)
    from app.services.proxy import get_proxy_for_url

    proxy_url = await get_proxy_for_url(settings.nager_api_url)
    if proxy_url:
        print(f"Using proxy: {proxy_url}")
        # Add authentication to proxy URL if credentials provided
        if settings.proxy_username and settings.proxy_password:
            from urllib.parse import urlparse, urlunparse

            parsed = urlparse(proxy_url)
            auth_proxy = urlunparse(
                (
                    parsed.scheme,
                    f"{settings.proxy_username}:{settings.proxy_password}@{parsed.netloc}",
                    parsed.path,
                    parsed.params,
                    parsed.query,
                    parsed.fragment,
                )
            )
            proxy_url = auth_proxy
            print(f"Proxy authentication enabled for user: {settings.proxy_username}")

    # SSL verification - can use custom CA cert for corporate proxies
    ssl_verify: bool | str = settings.proxy_verify_ssl
    if settings.proxy_ca_cert:
        print(f"Using custom CA certificate: {settings.proxy_ca_cert}")
        ssl_verify = settings.proxy_ca_cert
    elif not settings.proxy_verify_ssl:
        print("SSL verification disabled for proxy")

    async with httpx.AsyncClient(timeout=10.0, proxy=proxy_url, verify=ssl_verify) as client:
        for year in years:
            try:
                url = f"{settings.nager_api_url}/PublicHolidays/{year}/{country_code}"
                print(f"Fetching: {url}")
                response = await client.get(url)

                if response.status_code != 200:
                    print(
                        f"Failed to fetch holidays for {country_code}/{year}: HTTP {response.status_code}"
                    )
                    # Debug: show response headers and body for non-200 responses
                    print(f"  Response headers: {dict(response.headers)}")
                    try:
                        body = response.text[:500]  # First 500 chars
                        print(f"  Response body: {body}")
                    except Exception:
                        pass
                    continue

                holidays_data = response.json()
                print(f"Received {len(holidays_data)} holidays for {country_code}/{year}")

                for h in holidays_data:
                    # Filter by region if specified
                    if region_code and h.get("counties"):
                        # Check if region matches
                        region_match = any(
                            region_code in county for county in h.get("counties", [])
                        )
                        if not region_match:
                            continue

                    # Parse date string to date object
                    from datetime import date as date_type

                    holiday_date = date_type.fromisoformat(h["date"])

                    holiday = BankHoliday(
                        site_id=site_id,
                        date=holiday_date,
                        end_date=holiday_date,
                        name=h.get("localName") or h["name"],
                        is_custom=0,
                        year=year,
                    )

                    try:
                        db.add(holiday)
                        await db.flush()
                        total_added += 1
                    except Exception as e:
                        # Don't rollback the whole transaction, just skip this one
                        # It might be a duplicate
                        await db.rollback()
                        print(f"Skipped holiday {h['date']} {h.get('localName', h['name'])}: {e}")
                        continue

            except httpx.RequestError as e:
                print(f"Request error fetching holidays for {country_code}/{year}: {e}")
                continue
            except Exception as e:
                print(f"Error fetching holidays for {country_code}/{year}: {e}")
                import traceback

                traceback.print_exc()
                continue

    print(f"Added {total_added} holidays for site {site_id}")

    # Update last fetch timestamp
    site.last_holiday_fetch = datetime.utcnow()
    await db.commit()


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
