"""
SQLAlchemy models package.
All models inherit from the Base class defined in database.py.
"""

from app.models.absence_type import AbsenceType
from app.models.assignment import PhaseStaffAssignment, ProjectAssignment, SubphaseStaffAssignment
from app.models.card_comment import CardComment
from app.models.custom_column import CustomColumn, CustomColumnValue
from app.models.equipment import Equipment, EquipmentAssignment, EquipmentBlock, EquipmentSite
from app.models.note import Note
from app.models.notification import Notification
from app.models.organization import Organization, OrganizationSSOConfig
from app.models.presence import ProjectPresence
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.session import Session
from app.models.settings import PredefinedPhase, Settings, SSOConfig
from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite, Site
from app.models.skill import Skill, UserSkill
from app.models.tag import ProjectTag, Tag, TagGroup, TagSite
from app.models.team import (
    CompanyEventTeam,
    EquipmentTeam,
    ProjectTeam,
    TagTeam,
    Team,
    TeamMember,
)
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
    "CompanyEventSite",
    "Project",
    "ProjectPhase",
    "ProjectSubphase",
    "Equipment",
    "EquipmentSite",
    "EquipmentAssignment",
    "EquipmentBlock",
    "ProjectAssignment",
    "PhaseStaffAssignment",
    "SubphaseStaffAssignment",
    "Vacation",
    "AbsenceType",
    "Note",
    "Settings",
    "PredefinedPhase",
    "SSOConfig",
    "Session",
    "CustomColumn",
    "CustomColumnValue",
    "Skill",
    "UserSkill",
    "Tag",
    "TagGroup",
    "TagSite",
    "ProjectTag",
    "Team",
    "TeamMember",
    "ProjectTeam",
    "TagTeam",
    "CompanyEventTeam",
    "EquipmentTeam",
    "ProjectPresence",
    "CardComment",
    "Notification",
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
