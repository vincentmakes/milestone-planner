"""
Pydantic schemas for request/response validation.
"""

from app.schemas.auth import (
    AuthMeResponse,
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    SSOConfigResponse,
    SSOConfigUpdate,
    UserSessionInfo,
)
from app.schemas.custom_column import (
    CustomColumnCreate,
    CustomColumnReorderRequest,
    CustomColumnResponse,
    CustomColumnsWithValuesResponse,
    CustomColumnUpdate,
    CustomColumnValueBulkUpdate,
    CustomColumnValueCreate,
    CustomColumnValueResponse,
)
from app.schemas.equipment import (
    EquipmentAssignmentCreate,
    EquipmentAssignmentResponse,
    EquipmentAssignmentUpdate,
    EquipmentCreate,
    EquipmentResponse,
    EquipmentUpdate,
)
from app.schemas.note import (
    NoteCreate,
    NoteResponse,
)
from app.schemas.predefined_phases import (
    PhaseReorderRequest,
    PredefinedPhaseCreate,
    PredefinedPhaseResponse,
    PredefinedPhaseUpdate,
)
from app.schemas.project import (
    PhaseCreate,
    PhaseResponse,
    PhaseUpdate,
    ProjectCreate,
    ProjectDetailResponse,
    ProjectListResponse,
    ProjectUpdate,
    SubphaseCreate,
    SubphaseResponse,
    SubphaseUpdate,
)
from app.schemas.settings import SettingsResponse, SettingUpdate
from app.schemas.site import (
    BankHolidayCreate,
    BankHolidayResponse,
    SiteCreate,
    SiteResponse,
    SiteUpdate,
)
from app.schemas.tenant import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminMeResponse,
    AdminUserInfo,
    SystemStatsResponse,
    TenantCreate,
    TenantCreateResponse,
    TenantResponse,
    TenantUpdate,
)
from app.schemas.user import (
    StaffDetailResponse,
    StaffResponse,
    UserDetailResponse,
    UserResponse,
    UserSiteResponse,
)
from app.schemas.vacation import (
    VacationCreate,
    VacationResponse,
    VacationUpdate,
)

__all__ = [
    # Settings
    "SettingsResponse",
    "SettingUpdate",
    # Predefined Phases
    "PredefinedPhaseResponse",
    "PredefinedPhaseCreate",
    "PredefinedPhaseUpdate",
    "PhaseReorderRequest",
    # Sites
    "SiteResponse",
    "SiteCreate",
    "SiteUpdate",
    "BankHolidayResponse",
    "BankHolidayCreate",
    # Users/Staff
    "StaffResponse",
    "StaffDetailResponse",
    "UserResponse",
    "UserDetailResponse",
    "UserSiteResponse",
    # Equipment
    "EquipmentResponse",
    "EquipmentCreate",
    "EquipmentUpdate",
    "EquipmentAssignmentResponse",
    "EquipmentAssignmentCreate",
    "EquipmentAssignmentUpdate",
    # Vacations
    "VacationResponse",
    "VacationCreate",
    "VacationUpdate",
    # Notes
    "NoteResponse",
    "NoteCreate",
    # Auth
    "LoginRequest",
    "LoginResponse",
    "UserSessionInfo",
    "AuthMeResponse",
    "ChangePasswordRequest",
    "SSOConfigResponse",
    "SSOConfigUpdate",
    # Projects
    "ProjectListResponse",
    "ProjectDetailResponse",
    "ProjectCreate",
    "ProjectUpdate",
    "PhaseResponse",
    "PhaseCreate",
    "PhaseUpdate",
    "SubphaseResponse",
    "SubphaseCreate",
    "SubphaseUpdate",
    # Multi-tenant Admin
    "AdminLoginRequest",
    "AdminLoginResponse",
    "AdminUserInfo",
    "AdminMeResponse",
    "TenantCreate",
    "TenantUpdate",
    "TenantResponse",
    "TenantCreateResponse",
    "SystemStatsResponse",
    # Custom Columns
    "CustomColumnCreate",
    "CustomColumnUpdate",
    "CustomColumnResponse",
    "CustomColumnReorderRequest",
    "CustomColumnValueCreate",
    "CustomColumnValueResponse",
    "CustomColumnValueBulkUpdate",
    "CustomColumnsWithValuesResponse",
]
