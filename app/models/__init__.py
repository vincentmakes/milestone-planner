"""
SQLAlchemy models package.
All models inherit from the Base class defined in database.py.
"""

from app.models.assignment import PhaseStaffAssignment, ProjectAssignment, SubphaseStaffAssignment
from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.note import Note
from app.models.organization import Organization, OrganizationSSOConfig
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.session import Session
from app.models.settings import PredefinedPhase, Settings, SSOConfig
from app.models.site import BankHoliday, CompanyEvent, Site
from app.models.skill import Skill, UserSkill
from app.models.tenant import (
    AdminSession,
    AdminUser,
    MasterBase,
    Tenant,
    TenantAuditLog,
    TenantCredentials,
)
from app.models.user import User, UserSite
from app.models.vacation import Vacation

__all__ = [
    # Tenant models
    "User",
    "UserSite",
    "Site",
    "BankHoliday",
    "CompanyEvent",
    "Project",
    "ProjectPhase",
    "ProjectSubphase",
    "Equipment",
    "EquipmentAssignment",
    "ProjectAssignment",
    "PhaseStaffAssignment",
    "SubphaseStaffAssignment",
    "Vacation",
    "Note",
    "Settings",
    "PredefinedPhase",
    "SSOConfig",
    "Session",
    "CustomColumn",
    "CustomColumnValue",
    "Skill",
    "UserSkill",
    # Multi-tenant admin models (use separate MasterBase)
    "MasterBase",
    "Tenant",
    "TenantCredentials",
    "TenantAuditLog",
    "AdminUser",
    "AdminSession",
    # Organization models (also use MasterBase)
    "Organization",
    "OrganizationSSOConfig",
]
