"""
Pydantic schemas for Settings.
"""

from typing import Optional

from pydantic import BaseModel


class SettingsResponse(BaseModel):
    """Response model for a single setting."""
    key: str
    value: Optional[str] = None

    class Config:
        from_attributes = True


class SettingUpdate(BaseModel):
    """Request model for updating a setting."""
    value: Optional[str] = None
