"""
Pydantic schemas for Sites and Bank Holidays.
"""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas.base import DateAsDateTimeJS, DateTimeJS


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


class CompanyEventResponse(BaseModel):
    """Response model for company events."""

    id: int
    site_id: int
    date: DateAsDateTimeJS
    end_date: DateAsDateTimeJS | None = None
    name: str
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class CompanyEventCreate(BaseModel):
    """Request model for creating a company event."""

    date: date
    end_date: date | None = None
    name: str = Field(..., min_length=1, max_length=200)
