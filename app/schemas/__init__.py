"""
Pydantic schemas for request/response validation.
"""

from app.schemas.settings import SettingsResponse, SettingUpdate
from app.schemas.predefined_phases import (
    PredefinedPhaseResponse,
    PredefinedPhaseCreate,
    PredefinedPhaseUpdate,
    PhaseReorderRequest,
)
from app.schemas.site import (
    SiteResponse,
    SiteCreate,
    SiteUpdate,
    BankHolidayResponse,
    BankHolidayCreate,
)
from app.schemas.user import (
    StaffResponse,
    StaffDetailResponse,
    UserResponse,
    UserDetailResponse,
    UserSiteResponse,
)
from app.schemas.equipment import (
    EquipmentResponse,
    EquipmentCreate,
    EquipmentUpdate,
    EquipmentAssignmentResponse,
    EquipmentAssignmentCreate,
    EquipmentAssignmentUpdate,
)
from app.schemas.vacation import (
    VacationResponse,
    VacationCreate,
    VacationUpdate,
)
from app.schemas.note import (
    NoteResponse,
    NoteCreate,
)
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    UserSessionInfo,
    AuthMeResponse,
    ChangePasswordRequest,
    SSOConfigResponse,
    SSOConfigUpdate,
)
from app.schemas.project import (
    ProjectListResponse,
    ProjectDetailResponse,
    ProjectCreate,
    ProjectUpdate,
    PhaseResponse,
    PhaseCreate,
    PhaseUpdate,
    SubphaseResponse,
    SubphaseCreate,
    SubphaseUpdate,
)
from app.schemas.tenant import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminUserInfo,
    AdminMeResponse,
    TenantCreate,
    TenantUpdate,
    TenantResponse,
    TenantCreateResponse,
    SystemStatsResponse,
)
from app.schemas.custom_column import (
    CustomColumnCreate,
    CustomColumnUpdate,
    CustomColumnResponse,
    CustomColumnReorderRequest,
    CustomColumnValueCreate,
    CustomColumnValueResponse,
    CustomColumnValueBulkUpdate,
    CustomColumnsWithValuesResponse,
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
