/**
 * Settings hub types shared by the hub shell, the section registry and panels.
 */

import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { SettingsSectionId } from '@/stores/uiStore';
import type { PermissionKey } from '@/types/permissions';

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
  /**
   * Key(s) that list the section, any one suffices; null = listed whenever
   * the hub opens (General: per-browser appearance for everyone who has
   * another section; its instance form needs `settings.general`).
   */
  permission: PermissionKey | readonly PermissionKey[] | null;
  /** One line shown under the section title */
  description?: string;
  Panel: SettingsPanelComponent;
}
