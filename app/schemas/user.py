"""
Pydantic schemas for Users and Staff.
"""

from pydantic import BaseModel, EmailStr, Field

from app.schemas.base import DateTimeJS
from app.schemas.team import TeamIds
from app.services.permissions import ROLE_KEY_PATTERN

# Minimum length of a new or changed tenant password (B1-22). Login never
# checks it, so accounts with an older, shorter password keep working.
MIN_PASSWORD_LENGTH = 8


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
    team_ids: list[int] = []  # The user's teams at this row's site

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
    team_ids: list[int] = []  # All of the user's teams

    class Config:
        from_attributes = True


class StaffCreate(BaseModel):
    """Request model for creating a staff member."""

    email: EmailStr
    # New and changed passwords only; existing logins are unaffected.
    password: str = Field(..., min_length=MIN_PASSWORD_LENGTH)
    first_name: str = Field(..., min_length=1, max_length=100)
    last_name: str = Field(..., min_length=1, max_length=100)
    job_title: str | None = Field(None, max_length=100)
    # A role key; the router checks it exists in ``roles`` (404 otherwise).
    role: str = Field(default="user", pattern=ROLE_KEY_PATTERN)
    max_capacity: int = Field(default=100, ge=1, le=100)  # Max work capacity %
    # Bookable as a resource; omitted = bookable unless the role is admin.
    is_resource: bool | None = None
    site_ids: list[int] = []
    skill_ids: list[int] = []
    team_ids: TeamIds = []


class StaffUpdate(BaseModel):
    """Request model for updating a staff member."""

    email: EmailStr | None = None
    password: str | None = Field(None, min_length=MIN_PASSWORD_LENGTH)
    first_name: str | None = Field(None, min_length=1, max_length=100)
    last_name: str | None = Field(None, min_length=1, max_length=100)
    job_title: str | None = Field(None, max_length=100)
    # A role key; the router checks it exists in ``roles`` (404 otherwise).
    role: str | None = Field(None, pattern=ROLE_KEY_PATTERN)
    max_capacity: int | None = Field(None, ge=1, le=100)  # Max work capacity %
    active: int | None = None
    is_resource: bool | None = None  # Bookable as a resource
    site_ids: list[int] | None = None
    skill_ids: list[int] | None = None
    team_ids: TeamIds | None = None


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
    role_name: str | None = None  # the role's display name
    max_capacity: int = 100  # Max work capacity %
    active: int
    is_resource: bool = True  # Bookable as a resource
    created_at: DateTimeJS
    site_ids: list[int] = []
    site_names: list[str] = []
    skills: list[SkillInfo] = []
    team_ids: list[int] = []
    team_names: list[str] = []

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
    role_name: str | None = None  # the role's display name
    max_capacity: int = 100  # Max work capacity %
    active: int
    is_resource: bool = True  # Bookable as a resource
    created_at: DateTimeJS
    site_ids: list[int] = []
    sites: list[UserSiteResponse] = []
    skills: list[SkillInfo] = []
    team_ids: list[int] = []
    team_names: list[str] = []

    class Config:
        from_attributes = True
