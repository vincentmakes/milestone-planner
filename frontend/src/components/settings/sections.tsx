/**
 * Settings hub section registry
 *
 * One entry per section, grouped in the hub's left-hand list. `minRole` mirrors
 * what the backend allows, so a section is only listed for users whose writes
 * it would accept. Panels are lazy-loaded with the section.
 */

import { lazy } from 'react';
import type { UserRole } from '@/types';
import type { SettingsSection, SettingsSectionId } from './types';

const GeneralPanel = lazy(() =>
  import('./panels/GeneralPanel').then((m) => ({ default: m.GeneralPanel }))
);
const SitesPanel = lazy(() =>
  import('./panels/SitesPanel').then((m) => ({ default: m.SitesPanel }))
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
const SSOPanel = lazy(() =>
  import('./panels/SSOPanel').then((m) => ({ default: m.SSOPanel }))
);

const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  'aria-hidden': true,
} as const;

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    group: 'General',
    id: 'general',
    label: 'General',
    // Superusers get the per-browser appearance only; the panel renders the
    // instance-wide settings (PUT /settings is admin-only) for admins.
    minRole: 'superuser',
    description: 'Appearance in this browser; admins also set the instance title, branding and display defaults.',
    Panel: GeneralPanel,
    icon: (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
  {
    group: 'Sites & calendar',
    id: 'sites',
    label: 'Sites',
    minRole: 'admin',
    description: 'Locations, their country and region, and data export.',
    Panel: SitesPanel,
    icon: (
      <svg {...svgProps}>
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
  {
    group: 'Sites & calendar',
    id: 'bank-holidays',
    label: 'Bank holidays',
    minRole: 'superuser',
    description: 'Public holidays per site. They are non-working days in every plan.',
    Panel: BankHolidaysPanel,
    icon: (
      <svg {...svgProps}>
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    group: 'Sites & calendar',
    id: 'company-events',
    label: 'Company events',
    minRole: 'superuser',
    description: 'Audits, shutdowns and meetings shown on the timeline of one or more sites.',
    Panel: CompanyEventsPanel,
    icon: (
      <svg {...svgProps}>
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    ),
  },
  {
    group: 'People',
    id: 'users',
    label: 'Users',
    minRole: 'superuser',
    description: 'Accounts, roles, sites and skills of everyone in this workspace.',
    Panel: UsersPanel,
    icon: (
      <svg {...svgProps}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
    ),
  },
  {
    group: 'People',
    id: 'skills',
    label: 'Skills',
    minRole: 'superuser',
    description: 'Skills that can be assigned to staff and used to filter them.',
    Panel: SkillsPanel,
    icon: (
      <svg {...svgProps}>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    group: 'People',
    id: 'absence-types',
    label: 'Absence types',
    minRole: 'admin',
    description: 'Categories of time off, shared by all sites.',
    Panel: AbsenceTypesPanel,
    icon: (
      <svg {...svgProps}>
        <path d="M23 12a11.05 11.05 0 0 0-22 0zm-5 7a3 3 0 0 1-6 0v-7" />
      </svg>
    ),
  },
  {
    group: 'Resources',
    id: 'equipment',
    label: 'Equipment',
    minRole: 'superuser',
    description: 'Lab equipment per site.',
    Panel: EquipmentPanel,
    icon: (
      <svg {...svgProps}>
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </svg>
    ),
  },
  {
    group: 'Resources',
    id: 'equipment-types',
    label: 'Equipment types',
    minRole: 'superuser',
    description: 'Equipment types, shared across all sites.',
    Panel: EquipmentTypesPanel,
    icon: (
      <svg {...svgProps}>
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" />
      </svg>
    ),
  },
  {
    group: 'Projects',
    id: 'predefined-phases',
    label: 'Predefined phases',
    minRole: 'superuser',
    description: 'Phase names offered as quick-add options when creating projects.',
    Panel: PredefinedPhasesPanel,
    icon: (
      <svg {...svgProps}>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    ),
  },
  {
    group: 'Projects',
    id: 'tags',
    label: 'Tags',
    minRole: 'admin',
    description: 'Project tags and their groups, for all sites or only some.',
    Panel: TagsPanel,
    icon: (
      <svg {...svgProps}>
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
      </svg>
    ),
  },
  {
    group: 'Integrations',
    id: 'sso',
    label: 'SSO',
    minRole: 'admin',
    description: 'Microsoft Entra single sign-on for this workspace.',
    Panel: SSOPanel,
    icon: (
      <svg {...svgProps}>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
];

const ROLE_RANK: Record<UserRole, number> = { user: 0, superuser: 1, admin: 2 };

/** Whether a user with `role` may open a section that requires `minRole`. */
export function roleMeets(role: UserRole | undefined | null, minRole: UserRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** Sections the given role may open, in registry order. */
export function getVisibleSections(role: UserRole | undefined | null): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => roleMeets(role, section.minRole));
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
