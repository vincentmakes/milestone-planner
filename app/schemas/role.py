"""
Pydantic schemas for roles, the permission catalogue and approval policies.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.services.permissions import ROLE_KEY_PATTERN

PermissionMode = Literal["allow", "approval"]
# ``{permission key: mode}``; a key left out is denied. Keys and the
# approval mode are checked against the catalogue in the router (422).
PermissionMatrix = Annotated[dict[str, PermissionMode], Field(max_length=200)]
RoleIds = Annotated[list[int], Field(max_length=100)]


class RoleCreate(BaseModel):
    """Request model for creating a custom role."""

    key: str = Field(..., pattern=ROLE_KEY_PATTERN)
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    sort_order: int | None = None  # default: after every existing role
    permissions: PermissionMatrix = {}


class RoleUpdate(BaseModel):
    """
    Request model for updating a role (partial).

    ``key`` is immutable: it may be sent back unchanged, any other value is a
    422. ``permissions`` replaces the whole matrix; an explicit null clears
    ``description``.
    """

    key: str | None = None
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    sort_order: int | None = None
    permissions: PermissionMatrix | None = None


class RoleResponse(BaseModel):
    """A role with its effective matrix and the number of users holding it."""

    id: int
    key: str
    name: str
    description: str | None = None
    is_system: bool
    sort_order: int
    # Effective modes: the admin role lists every key as allow, and the
    # locked ``projects.view`` is always allow.
    permissions: dict[str, PermissionMode]
    user_count: int


class PermissionInfo(BaseModel):
    """One catalogue entry, as the role matrix shows it."""

    key: str
    label: str
    description: str
    approvable: bool
    locked: bool
    # Shipped mode per editable system role (None = deny).
    defaults: dict[str, PermissionMode | None]


class PermissionGroup(BaseModel):
    """A matrix section: the catalogue's permissions of one group, in order."""

    name: str
    permissions: list[PermissionInfo]


class PermissionCatalogueResponse(BaseModel):
    """``GET /api/permissions``: the catalogue grouped, plus the PM bundle."""

    groups: list[PermissionGroup]
    pm_bundle: list[str]


class ApprovalPolicyUpdate(BaseModel):
    """Request model for an approval policy (both fields replace the stored ones)."""

    pm_approves: bool
    role_ids: RoleIds


class ApprovalPolicyResponse(BaseModel):
    """Who approves one approvable action (admins always may)."""

    action: str
    label: str
    pm_approves: bool
    role_ids: list[int]
