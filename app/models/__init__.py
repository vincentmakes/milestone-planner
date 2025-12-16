"""
SQLAlchemy models package.
All models inherit from the Base class defined in database.py.
"""

from app.models.user import User, UserSite
from app.models.site import Site, BankHoliday
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.assignment import ProjectAssignment, PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.vacation import Vacation
from app.models.note import Note
from app.models.settings import Settings, PredefinedPhase, SSOConfig
from app.models.session import Session
from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.skill import Skill, UserSkill
from app.models.tenant import MasterBase, Tenant, TenantCredentials, TenantAuditLog, AdminUser, AdminSession

__all__ = [
    # Tenant models
    "User",
    "UserSite",
    "Site",
    "BankHoliday",
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
]
