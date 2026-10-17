/**
 * Settings hub types shared by the hub shell, the section registry and panels.
 */

import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { SettingsSectionId } from '@/stores/uiStore';
import type { UserRole } from '@/types';

export type { SettingsSectionId };

export interface SettingsPanelProps {
  /** Report unsaved changes; the hub asks before switching section or closing. */
  onDirtyChange: (dirty: boolean) => void;
}

export type SettingsPanelComponent =
  | ComponentType<SettingsPanelProps>
  | LazyExoticComponent<ComponentType<SettingsPanelProps>>;

export interface SettingsSection {
  group: string;
  id: SettingsSectionId;
  label: string;
  icon: ReactNode;
  /** Lowest tenant role that may open the section (admin > superuser) */
  minRole: Exclude<UserRole, 'user'>;
  /** One line shown under the section title */
  description?: string;
  Panel: SettingsPanelComponent;
}
