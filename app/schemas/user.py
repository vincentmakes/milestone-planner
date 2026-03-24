"""
Pydantic schemas for Users and Staff.
"""

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
    role: str | None = None  # This is job_title, not auth role
    email: str
    active: int = 1
    max_capacity: int = 100  # Max work capacity % (e.g., 80 for part-time)
    site_id: int | None = None  # Singular site ID
    site_name: str | None = None  # Singular site name
    skills: list[SkillInfo] = []  # User's skills

    class Config:
        from_attributes = True


class StaffDetailResponse(BaseModel):
    """Detailed staff response with sites."""

    id: int
    email: str
    first_name: str
    last_name: str
    job_title: str | None = None
    role: str = "user"
    active: int = 1
    created_at: DateTimeJS
    sites: list[UserSiteResponse] = []

    class Config:
        from_attributes = True


class StaffCreate(BaseModel):
    """Request model for creating a staff member."""

    email: EmailStr
    password: str = Field(..., min_length=6)
    first_name: str = Field(..., min_length=1, max_length=100)
    last_name: str = Field(..., min_length=1, max_length=100)
    job_title: str | None = Field(None, max_length=100)
    role: str = Field(default="user", pattern="^(admin|superuser|user)$")
    max_capacity: int = Field(default=100, ge=1, le=100)  # Max work capacity %
    site_ids: list[int] = []
    skill_ids: list[int] = []


class StaffUpdate(BaseModel):
    """Request model for updating a staff member."""

    email: EmailStr | None = None
    password: str | None = Field(None, min_length=6)
    first_name: str | None = Field(None, min_length=1, max_length=100)
    last_name: str | None = Field(None, min_length=1, max_length=100)
    job_title: str | None = Field(None, max_length=100)
    role: str | None = Field(None, pattern="^(admin|superuser|user)$")
    max_capacity: int | None = Field(None, ge=1, le=100)  # Max work capacity %
    active: int | None = None
    site_ids: list[int] | None = None
    skill_ids: list[int] | None = None


class UserResponse(BaseModel):
    """
    Response model for user list (admin view).
    Includes job_title, skills, site_ids, and site_names.
    """

    id: int
    email: str
    first_name: str
    last_name: str
    job_title: str | None = None
    role: str
    max_capacity: int = 100  # Max work capacity %
    active: int
    created_at: DateTimeJS
    site_ids: list[int] = []
    site_names: list[str] = []
    skills: list[SkillInfo] = []

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
    job_title: str | None = None
    role: str
    max_capacity: int = 100  # Max work capacity %
    active: int
    created_at: DateTimeJS
    site_ids: list[int] = []
    sites: list[UserSiteResponse] = []
    skills: list[SkillInfo] = []

    class Config:
        from_attributes = True
