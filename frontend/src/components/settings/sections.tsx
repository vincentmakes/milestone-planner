/**
 * Settings hub section registry
 *
 * One entry per section, grouped in the hub's left-hand list. `permission`
 * names the key(s) the backend checks on the section's writes, so a section
 * is only listed for users whose writes it would accept. Panels are
 * lazy-loaded with the section.
 */

import { lazy } from 'react';
import { can } from '@/utils/permissions';
import type { UserLike } from '@/utils/permissions';
import type { PermissionKey } from '@/types/permissions';
import type { SettingsSection, SettingsSectionId } from './types';
import { Icon, LockIcon, HashIcon, ProjectFieldsIcon, ListIcon, LabelIcon, BriefcaseIcon, UmbrellaIcon, StarIcon, UserPlusIcon, FlagIcon, CalendarIcon, UsersIcon, MapPinIcon, ShieldIcon, TuneIcon, GearIcon } from '@/components/common/Icon';

const GeneralPanel = lazy(() =>
  import('./panels/GeneralPanel').then((m) => ({ default: m.GeneralPanel }))
);
const DefaultsPanel = lazy(() =>
  import('./panels/DefaultsPanel').then((m) => ({ default: m.DefaultsPanel }))
);
const RolesPanel = lazy(() =>
  import('./panels/RolesPanel').then((m) => ({ default: m.RolesPanel }))
);
const SitesPanel = lazy(() =>
  import('./panels/SitesPanel').then((m) => ({ default: m.SitesPanel }))
);
const TeamsPanel = lazy(() =>
  import('./panels/TeamsPanel').then((m) => ({ default: m.TeamsPanel }))
);
const BankHolidaysPanel = lazy(() =>
  import('./panels/BankHolidaysPanel').then((m) => ({ default: m.BankHolidaysPanel }))
);
const CompanyEventsPanel = lazy(() =>
  import('./panels/CompanyEventsPanel').then((m) => ({ default: m.CompanyEventsPanel }))
);
const UsersPanel = lazy(() =>
  import('./panels/UsersPanel').then((m) => ({ default: m.UsersPanel }))
);
const SkillsPanel = lazy(() =>
  import('./panels/SkillsPanel').then((m) => ({ default: m.SkillsPanel }))
);
const AbsenceTypesPanel = lazy(() =>
  import('./panels/AbsenceTypesPanel').then((m) => ({ default: m.AbsenceTypesPanel }))
);
const EquipmentPanel = lazy(() =>
  import('./panels/EquipmentPanel').then((m) => ({ default: m.EquipmentPanel }))
);
const EquipmentTypesPanel = lazy(() =>
  import('./panels/EquipmentTypesPanel').then((m) => ({ default: m.EquipmentTypesPanel }))
);
const PredefinedPhasesPanel = lazy(() =>
  import('./panels/PredefinedPhasesPanel').then((m) => ({ default: m.PredefinedPhasesPanel }))
);
const TagsPanel = lazy(() =>
  import('./panels/TagsPanel').then((m) => ({ default: m.TagsPanel }))
);
const ProjectFieldsPanel = lazy(() =>
  import('./panels/ProjectFieldsPanel').then((m) => ({ default: m.ProjectFieldsPanel }))
);
const SSOPanel = lazy(() =>
  import('./panels/SSOPanel').then((m) => ({ default: m.SSOPanel }))
);

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    group: 'General',
    id: 'general',
    label: 'General',
    // Listed for everyone who opens the hub: the per-browser appearance; the
    // panel adds the instance-wide settings with settings.general.
    permission: null,
    description: 'Appearance in this browser; admins also set the instance title, branding and display defaults.',
    Panel: GeneralPanel,
    icon: <Icon icon={GearIcon} size={16} />,
  },
  {
    group: 'General',
    id: 'defaults',
    label: 'Features & defaults',
    // PUT /settings/{key} needs settings.general.
    permission: 'settings.general',
    description: "What the Gantt opens with, the panels' default filters, and the Kanban, holiday-import and phase switches.",
    Panel: DefaultsPanel,
    icon: <Icon icon={TuneIcon} size={16} />,
  },
  {
    group: 'General',
    id: 'roles',
    label: 'Roles',
    // The admin role alone: role and approval-policy writes are admin-only.
    permission: 'roles.manage',
    description: 'What each role may do, custom roles, and who approves own-booking changes.',
    Panel: RolesPanel,
    icon: <Icon icon={ShieldIcon} size={16} />,
  },
  {
    group: 'Sites & calendar',
    id: 'sites',
    label: 'Sites',
    // Export-only holders get the list with the export control alone.
    permission: ['sites.manage', 'sites.export'],
    description: 'Locations, their country and region, and data export.',
    Panel: SitesPanel,
    icon: <Icon icon={MapPinIcon} size={16} />,
  },
  {
    group: 'Sites & calendar',
    id: 'teams',
    label: 'Teams',
    // Teams of the visible sites (the panel's site list).
    permission: 'teams.manage',
    description: 'Groups of people within a site: filter the views and scope tags, events and equipment to them.',
    Panel: TeamsPanel,
    icon: <Icon icon={UsersIcon} size={16} />,
  },
  {
    group: 'Sites & calendar',
    id: 'bank-holidays',
    label: 'Bank holidays',
    permission: 'bank_holidays.manage',
    description: 'Public holidays per site. They are non-working days in every plan.',
    Panel: BankHolidaysPanel,
    icon: <Icon icon={CalendarIcon} size={16} />,
  },
  {
    group: 'Sites & calendar',
    id: 'company-events',
    label: 'Company events',
    permission: 'company_events.manage',
    description: 'Audits, shutdowns and meetings shown on the timeline of one or more sites.',
    Panel: CompanyEventsPanel,
    icon: <Icon icon={FlagIcon} size={16} />,
  },
  {
    group: 'People',
    id: 'users',
    label: 'Users',
    permission: 'users.view',
    description: 'Accounts, roles, sites and skills of everyone in this workspace.',
    Panel: UsersPanel,
    icon: <Icon icon={UserPlusIcon} size={16} />,
  },
  {
    group: 'People',
    id: 'skills',
    label: 'Skills',
    permission: 'skills.manage',
    description: 'Skills that can be assigned to staff and used to filter them.',
    Panel: SkillsPanel,
    icon: <Icon icon={StarIcon} size={16} />,
  },
  {
    group: 'People',
    id: 'absence-types',
    label: 'Absence types',
    permission: 'absence_types.manage',
    description: 'Categories of time off, shared by all sites.',
    Panel: AbsenceTypesPanel,
    icon: <Icon icon={UmbrellaIcon} size={16} />,
  },
  {
    group: 'Resources',
    id: 'equipment',
    label: 'Equipment',
    permission: 'equipment.manage',
    description: 'Lab equipment per site.',
    Panel: EquipmentPanel,
    icon: <Icon icon={BriefcaseIcon} size={16} />,
  },
  {
    group: 'Resources',
    id: 'equipment-types',
    label: 'Equipment types',
    permission: 'equipment_types.manage',
    description: 'Equipment types, shared across all sites.',
    Panel: EquipmentTypesPanel,
    icon: <Icon icon={LabelIcon} size={16} />,
  },
  {
    group: 'Projects',
    id: 'predefined-phases',
    label: 'Predefined phases',
    permission: 'predefined_phases.manage',
    description: 'Phase names offered as quick-add options when creating projects.',
    Panel: PredefinedPhasesPanel,
    icon: <Icon icon={ListIcon} size={16} />,
  },
  {
    group: 'Projects',
    id: 'project-fields',
    label: 'Project fields',
    permission: 'project_fields.manage',
    description: 'Fields on every project: the built-in ones, and your own dropdowns, texts, numbers and switches.',
    Panel: ProjectFieldsPanel,
    icon: <Icon icon={ProjectFieldsIcon} size={16} />,
  },
  {
    group: 'Projects',
    id: 'tags',
    label: 'Tags',
    permission: 'tags.manage',
    description: 'Project tags, for all sites or only some.',
    Panel: TagsPanel,
    icon: <Icon icon={HashIcon} size={16} />,
  },
  {
    group: 'Integrations',
    id: 'sso',
    label: 'SSO',
    permission: 'settings.sso',
    description: 'Microsoft Entra single sign-on for this workspace.',
    Panel: SSOPanel,
    icon: <Icon icon={LockIcon} size={16} />,
  },
];

/** Whether `user` holds one of the keys that list `section` (null = always). */
function sectionListed(section: SettingsSection, user: UserLike | null | undefined): boolean {
  if (section.permission === null) return true;
  const keys: readonly PermissionKey[] =
    typeof section.permission === 'string' ? [section.permission] : section.permission;
  return keys.some((key) => can(user, key));
}

/**
 * Whether the user has anything to configure: at least one section gated by a
 * key they hold. General alone (appearance) does not open the hub.
 */
export function canOpenSettings(user: UserLike | null | undefined): boolean {
  return SETTINGS_SECTIONS.some((section) => section.permission !== null && sectionListed(section, user));
}

/** Sections the user may open, in registry order; none without a gated one. */
export function getVisibleSections(user: UserLike | null | undefined): SettingsSection[] {
  if (!canOpenSettings(user)) return [];
  return SETTINGS_SECTIONS.filter((section) => sectionListed(section, user));
}

/** Visible sections grouped by `group`, keeping registry order. */
export function groupSections(
  sections: SettingsSection[]
): { group: string; sections: SettingsSection[] }[] {
  const groups: { group: string; sections: SettingsSection[] }[] = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last && last.group === section.group) {
      last.sections.push(section);
    } else {
      groups.push({ group: section.group, sections: [section] });
    }
  }
  return groups;
}

export function findSection(id: SettingsSectionId | null | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}
