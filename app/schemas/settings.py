"""
Pydantic schemas for Settings.
"""

from pydantic import BaseModel


class SettingsResponse(BaseModel):
    """Response model for a single setting."""

    key: str
    value: str | None = None

    class Config:
        from_attributes = True


class SettingUpdate(BaseModel):
    """Request model for updating a setting."""

    value: str | None = None
