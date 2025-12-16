"""
Pydantic schemas for Users and Staff.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field

from app.schemas.base import DateTimeJS


class UserSiteResponse(BaseModel):
    """Site info for user response."""
    id: int
    name: str

    class Config:
        from_attributes = True


class SkillInfo(BaseModel):
    """Skill info for staff response."""
    id: int
    name: str
    color: str

    class Config:
        from_attributes = True


class StaffResponse(BaseModel):
    """
    Response model for staff members (users as resources).
    
    Note: This matches the Node.js API which returns one row per user-site 
    combination (users with multiple sites appear multiple times).
    """
    id: int
    first_name: str
    last_name: str
    name: str  # Computed: first_name + ' ' + last_name
    role: Optional[str] = None  # This is job_title, not auth role
    email: str
    active: int = 1
    site_id: Optional[int] = None  # Singular site ID
    site_name: Optional[str] = None  # Singular site name
    skills: List[SkillInfo] = []  # User's skills

    class Config:
        from_attributes = True


class StaffDetailResponse(BaseModel):
    """Detailed staff response with sites."""
    id: int
    email: str
    first_name: str
    last_name: str
    job_title: Optional[str] = None
    role: str = "user"
    active: int = 1
    created_at: DateTimeJS
    sites: List[UserSiteResponse] = []

    class Config:
        from_attributes = True


class StaffCreate(BaseModel):
    """Request model for creating a staff member."""
    email: EmailStr
    password: str = Field(..., min_length=6)
    first_name: str = Field(..., min_length=1, max_length=100)
    last_name: str = Field(..., min_length=1, max_length=100)
    job_title: Optional[str] = Field(None, max_length=100)
    role: str = Field(default="user", pattern="^(admin|superuser|user)$")
    site_ids: List[int] = []
    skill_ids: List[int] = []


class StaffUpdate(BaseModel):
    """Request model for updating a staff member."""
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(None, min_length=6)
    first_name: Optional[str] = Field(None, min_length=1, max_length=100)
    last_name: Optional[str] = Field(None, min_length=1, max_length=100)
    job_title: Optional[str] = Field(None, max_length=100)
    role: Optional[str] = Field(None, pattern="^(admin|superuser|user)$")
    active: Optional[int] = None
    site_ids: Optional[List[int]] = None
    skill_ids: Optional[List[int]] = None


class UserResponse(BaseModel):
    """
    Response model for user list (admin view).
    Includes job_title, skills, site_ids, and site_names.
    """
    id: int
    email: str
    first_name: str
    last_name: str
    job_title: Optional[str] = None
    role: str
    active: int
    created_at: DateTimeJS
    site_ids: List[int] = []
    site_names: List[str] = []
    skills: List[SkillInfo] = []

    class Config:
        from_attributes = True


class UserDetailResponse(BaseModel):
    """
    Response model for single user (admin view).
    Includes job_title, skills, site_ids, and sites array.
    """
    id: int
    email: str
    first_name: str
    last_name: str
    job_title: Optional[str] = None
    role: str
    active: int
    created_at: DateTimeJS
    site_ids: List[int] = []
    sites: List[UserSiteResponse] = []
    skills: List[SkillInfo] = []

    class Config:
        from_attributes = True
