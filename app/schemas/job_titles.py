"""
Pydantic schemas for Job Titles.
"""

from pydantic import BaseModel, Field

from app.schemas.base import DateTimeJS


class JobTitleResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    is_active: int
    created_at: DateTimeJS

    class Config:
        from_attributes = True


class JobTitleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class JobTitleUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None


class JobTitleReorderRequest(BaseModel):
    job_title_order: list[int] = Field(..., description="List of job title IDs in desired order")
