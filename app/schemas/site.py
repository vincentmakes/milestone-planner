"""
Pydantic schemas for Sites and Bank Holidays.
"""

from datetime import date
from datetime import date as date_type

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateTimeJS

# Upper bound on a single .ics import, so one request cannot insert unbounded rows.
MAX_IMPORT_ITEMS = 1000


class SiteResponse(BaseModel):
    """Response model for sites."""

    id: int
    name: str
    location: str | None = None
    city: str | None = None
    country_code: str | None = None
    region_code: str | None = None
    timezone: str = "Europe/Zurich"
    last_holiday_fetch: DateTimeJS | None = None
    active: int = 1
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class SiteCreate(BaseModel):
    """Request model for creating a site."""

    name: str = Field(..., min_length=1, max_length=100)
    location: str | None = Field(None, max_length=100)
    city: str | None = Field(None, max_length=100)
    country_code: str | None = Field(None, min_length=2, max_length=2)
    region_code: str | None = Field(None, max_length=10)
    timezone: str = Field(default="Europe/Zurich", max_length=50)


class SiteUpdate(BaseModel):
    """Request model for updating a site."""

    name: str | None = Field(None, min_length=1, max_length=100)
    location: str | None = Field(None, max_length=100)
    city: str | None = Field(None, max_length=100)
    country_code: str | None = Field(None, min_length=2, max_length=2)
    region_code: str | None = Field(None, max_length=10)
    timezone: str | None = Field(None, max_length=50)
    active: int | None = None


class BankHolidayResponse(BaseModel):
    """Response model for bank holidays."""

    id: int
    site_id: int
    date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS | None = None
    name: str
    is_custom: int = 0
    year: int
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class BankHolidayCreate(BaseModel):
    """Request model for creating a custom bank holiday."""

    date: date
    end_date: date | None = None
    name: str = Field(..., min_length=1, max_length=200)


class BankHolidayUpdate(BaseModel):
    """Request model for editing a bank holiday (all fields optional)."""

    # date_type alias: a field named `date` would shadow the `date` type here.
    date: date_type | None = None
    end_date: date_type | None = None
    name: str | None = Field(None, min_length=1, max_length=200)


class BankHolidayImportItem(BaseModel):
    """One holiday in a bulk import."""

    date: date
    end_date: date | None = None
    name: str = Field(..., min_length=1, max_length=200)


class BankHolidayImportRequest(BaseModel):
    """Request model for importing holidays (e.g. from an .ics file) into a site."""

    items: list[BankHolidayImportItem] = Field(..., max_length=MAX_IMPORT_ITEMS)


class ImportResult(BaseModel):
    """Outcome of a bulk import."""

    created: int
    skipped: int


class CompanyEventResponse(BaseModel):
    """Response model for company events."""

    id: int
    # First linked site, kept for clients that predate multi-site events.
    site_id: int | None = None
    site_ids: list[int] = []
    date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS | None = None
    name: str
    color: str | None = None
    # Site closure: staff of the linked sites are unavailable on these dates.
    counts_as_unavailable: bool = False
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class CompanyEventCreate(BaseModel):
    """Request model for creating a company event."""

    date: date
    end_date: date | None = None
    name: str = Field(..., min_length=1, max_length=200)
    color: str | None = Field(None, max_length=20)
    counts_as_unavailable: bool = False


class CompanyEventMultiSiteCreate(CompanyEventCreate):
    """Request model for creating a company event on one or more sites."""

    site_ids: list[int] = Field(..., min_length=1)


class CompanyEventUpdate(BaseModel):
    """Request model for editing a company event (all fields optional)."""

    # date_type alias: a field named `date` would shadow the `date` type here.
    date: date_type | None = None
    end_date: date_type | None = None
    name: str | None = Field(None, min_length=1, max_length=200)
    color: str | None = Field(None, max_length=20)
    counts_as_unavailable: bool | None = None
    # When given, replaces the event's site links.
    site_ids: list[int] | None = Field(None, min_length=1)


class CompanyEventImportItem(BaseModel):
    """One event in a bulk import."""

    date: date
    end_date: date | None = None
    name: str = Field(..., min_length=1, max_length=200)


class CompanyEventImportRequest(BaseModel):
    """Request model for importing company events into one or more sites."""

    site_ids: list[int] = Field(..., min_length=1)
    color: str | None = Field(None, max_length=20)
    # Applies to the events the import creates; reused existing events keep theirs.
    counts_as_unavailable: bool = False
    items: list[CompanyEventImportItem] = Field(..., max_length=MAX_IMPORT_ITEMS)


class CompanyEventImportResult(BaseModel):
    """Outcome of a company-event import."""

    created: int
    # Existing identical events that gained at least one missing site link.
    linked: int
    skipped: int
