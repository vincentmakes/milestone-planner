"""
Roles API: the permission catalogue and the roles holding it.

``GET /permissions`` and ``GET /roles`` are open to every signed-in user (the
Settings role matrix and the frontend read them); creating, editing and
deleting roles is the admin's alone (``require_admin``: ``roles.manage`` is
locked to the admin role, so the role surface cannot lock itself out).

Rules: the admin role's matrix is code (403 on any edit); system roles cannot
be deleted (403), nor can a role still held by users (409, ``users.role`` is
a ``RESTRICT`` FK); keys are immutable after creation; names are unique
(400); a matrix takes catalogue keys only, ``approval`` only on the approvable
own-booking keys, and no change to a locked key (422). Writes are
coarse-broadcast as ``change:role`` by BroadcastMiddleware.
"""

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin
from app.models.rbac import Role, RolePermission
from app.models.user import User
from app.schemas.role import (
    PermissionCatalogueResponse,
    PermissionGroup,
    PermissionInfo,
    RoleCreate,
    RoleResponse,
    RoleUpdate,
)
from app.services.permissions import (
    ADMIN_ROLE_KEY,
    APPROVABLE_KEYS,
    LOCKED_KEYS,
    PERMISSION_KEYS,
    PERMISSIONS,
    PM_BUNDLE,
    Mode,
    PermissionSet,
)

router = APIRouter(tags=["roles"])

ROLE_NOT_FOUND_DETAIL = "Role not found"
EMPTY_NAME_DETAIL = "Role name cannot be empty"
ADMIN_ROLE_READ_ONLY_DETAIL = "Administrator permissions cannot be edited"
SYSTEM_ROLE_DELETE_DETAIL = "System roles cannot be deleted"
KEY_IMMUTABLE_DETAIL = "A role key cannot be changed"

# The editable system roles whose shipped defaults the matrix shows.
_DEFAULT_COLUMNS = ("superuser", "user")
# Stored on every role, like the system roles' seed (the key is locked to allow).
_ALWAYS_STORED: dict[str, Mode] = {"projects.view": "allow"}


def _duplicate_name_detail(name: str) -> str:
    return f'A role named "{name}" already exists'


def _duplicate_key_detail(key: str) -> str:
    return f'A role with the key "{key}" already exists'


def _role_in_use_detail(count: int) -> str:
    holders = "1 user holds" if count == 1 else f"{count} users hold"
    return f"{holders} this role. Give them another role first."


def _clean_name(name: str) -> str:
    """The stripped name; 400 when nothing is left."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_NAME_DETAIL)
    return name


def _validated_matrix(permissions: dict[str, Mode]) -> dict[str, Mode]:
    """
    The matrix to store: catalogue keys only (422 ``Unknown permission``),
    ``approval`` only on approvable keys (422), no change to a locked key
    (422: ``roles.manage`` is the admin's, ``projects.view`` is always allow).
    ``projects.view`` is always stored as allow.
    """
    for key, mode in permissions.items():
        if key not in PERMISSION_KEYS:
            detail = f"Unknown permission: {key}"
        elif mode == "approval" and key not in APPROVABLE_KEYS:
            detail = f"Only own-booking permissions can require approval: {key}"
        elif key in LOCKED_KEYS and _ALWAYS_STORED.get(key) != mode:
            detail = f"Permission is locked: {key}"
        else:
            continue
        raise HTTPException(status_code=422, detail=detail)
    return {**permissions, **_ALWAYS_STORED}


def _role_response(role: Role, user_count: int) -> RoleResponse:
    return RoleResponse(
        id=role.id,
        key=role.key,
        name=role.name,
        description=role.description,
        is_system=bool(role.is_system),
        sort_order=role.sort_order,
        permissions=PermissionSet(role.key, role.permission_modes).effective_modes(),
        user_count=user_count,
    )


async def _load_role(db: AsyncSession, role_id: int) -> Role:
    """The role (with its matrix rows); 404 if it does not exist."""
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ROLE_NOT_FOUND_DETAIL)
    return role


async def _user_count(db: AsyncSession, role_key: str) -> int:
    """How many users (active or not) hold the role."""
    result = await db.execute(select(func.count(User.id)).where(User.role == role_key))
    return int(result.scalar() or 0)


async def _name_taken(db: AsyncSession, name: str, exclude_id: int | None = None) -> bool:
    """Whether another role has this name (case-insensitive)."""
    query = select(Role.id).where(func.lower(Role.name) == name.lower())
    if exclude_id is not None:
        query = query.where(Role.id != exclude_id)
    return (await db.execute(query)).scalar_one_or_none() is not None


async def _commit(db: AsyncSession, detail: str) -> None:
    """Commit; a unique key/name race lost to a concurrent write is a 400, not a 500."""
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from e


async def _refresh_role(db: AsyncSession, role: Role) -> None:
    """Reload the role after a commit, its matrix rows included."""
    await db.refresh(role)
    await db.refresh(role, attribute_names=["permissions"])


def _apply_matrix(role: Role, matrix: dict[str, Mode]) -> None:
    """
    Make the role's rows equal ``matrix``, in place: changed modes are updated,
    dropped keys removed (delete-orphan) and new keys added -- never a delete
    and re-insert of the same primary key.
    """
    existing = {row.permission: row for row in role.permissions}
    for key, row in existing.items():
        if key not in matrix:
            role.permissions.remove(row)
        elif row.mode != matrix[key]:
            row.mode = matrix[key]
    for key in sorted(matrix):
        if key not in existing:
            role.permissions.append(RolePermission(permission=key, mode=matrix[key]))


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------


@router.get("/permissions", response_model=PermissionCatalogueResponse)
async def get_permissions(current_user: User = Depends(get_current_user)):
    """The permission catalogue, grouped in matrix order (every signed-in user)."""
    groups: dict[str, list[PermissionInfo]] = {}
    for permission in PERMISSIONS:
        groups.setdefault(permission.group, []).append(
            PermissionInfo(
                key=permission.key,
                label=permission.label,
                description=permission.description,
                approvable=permission.approvable,
                locked=permission.key in LOCKED_KEYS,
                defaults={role: permission.defaults.get(role) for role in _DEFAULT_COLUMNS},
            )
        )
    return PermissionCatalogueResponse(
        groups=[PermissionGroup(name=name, permissions=items) for name, items in groups.items()],
        pm_bundle=sorted(PM_BUNDLE),
    )


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


@router.get("/roles", response_model=list[RoleResponse])
async def get_roles(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every role with its matrix and user count (every signed-in user). Two queries."""
    roles = (await db.execute(select(Role).order_by(Role.sort_order, Role.id))).scalars().all()
    counts = {
        key: count
        for key, count in (
            await db.execute(select(User.role, func.count(User.id)).group_by(User.role))
        ).all()
    }
    return [_role_response(role, int(counts.get(role.key, 0))) for role in roles]


@router.get("/roles/{role_id}", response_model=RoleResponse)
async def get_role(
    role_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One role with its matrix and user count (every signed-in user)."""
    role = await _load_role(db, role_id)
    return _role_response(role, await _user_count(db, role.key))


@router.post("/roles", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
async def create_role(
    data: RoleCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Create a custom role (admin).

    Checks before any query: the name (400 when blank) and the matrix (422).
    Then the key (400 when taken, system keys included), the name (400 when
    taken, case-insensitive) and, without ``sort_order``, the current maximum.
    """
    name = _clean_name(data.name)
    matrix = _validated_matrix(data.permissions)

    key_taken = await db.execute(select(Role.id).where(Role.key == data.key))
    if key_taken.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_key_detail(data.key)
        )
    if await _name_taken(db, name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_name_detail(name)
        )

    sort_order = data.sort_order
    if sort_order is None:
        highest = (await db.execute(select(func.max(Role.sort_order)))).scalar()
        sort_order = 0 if highest is None else int(highest) + 1

    role = Role(
        key=data.key,
        name=name,
        description=data.description,
        is_system=False,
        sort_order=sort_order,
        permissions=[
            RolePermission(permission=key, mode=mode) for key, mode in sorted(matrix.items())
        ],
    )
    db.add(role)
    await _commit(db, f'A role with the key "{data.key}" or the name "{name}" already exists')
    await _refresh_role(db, role)

    return _role_response(role, 0)


@router.put("/roles/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: int,
    data: RoleUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update a role's name, description, sort order or matrix (admin; partial).

    The admin role is read-only (403); the key cannot change (422 unless sent
    back unchanged); ``permissions`` replaces the matrix (validated, 422); an
    explicit null clears ``description``. The holders' next request already
    sees the new matrix (permissions are resolved per request).
    """
    role = await _load_role(db, role_id)
    if role.key == ADMIN_ROLE_KEY:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ROLE_READ_ONLY_DETAIL
        )
    if data.key is not None and data.key != role.key:
        raise HTTPException(status_code=422, detail=KEY_IMMUTABLE_DETAIL)

    name: str | None = None
    if data.name is not None:
        name = _clean_name(data.name)
        if name != role.name and await _name_taken(db, name, exclude_id=role_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=_duplicate_name_detail(name)
            )

    matrix = _validated_matrix(data.permissions) if data.permissions is not None else None

    # Every check passed: apply.
    if name is not None:
        role.name = name
    if "description" in data.model_fields_set:
        role.description = data.description
    if data.sort_order is not None:
        role.sort_order = data.sort_order
    if matrix is not None:
        _apply_matrix(role, matrix)

    await _commit(db, _duplicate_name_detail(role.name))
    await _refresh_role(db, role)

    return _role_response(role, await _user_count(db, role.key))


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete a custom role (admin).

    System roles cannot be deleted (403), nor a role any user holds, active
    or not (409). Its matrix rows and approval-policy links go with it
    (ON DELETE CASCADE).
    """
    role = await _load_role(db, role_id)
    if role.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=SYSTEM_ROLE_DELETE_DETAIL)
    holders = await _user_count(db, role.key)
    if holders:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=_role_in_use_detail(holders)
        )

    await db.delete(role)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
