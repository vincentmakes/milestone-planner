import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { canOpenSettings } from '@/components/settings/sections';
import styles from './AdminSection.module.css';
import { Icon, GearIcon } from '@/components/common/Icon';

interface AdminSectionProps {
  collapsed?: boolean;
}

/**
 * Sidebar admin entry: one "Settings" item opening the Settings hub, where
 * users, sites, calendars, equipment, phases and SSO are managed. The hub
 * lists only the sections the user's permissions open.
 */
export function AdminSection({ collapsed = false }: AdminSectionProps) {
  const openSettings = useUIStore((s) => s.openSettings);
  const currentUser = useAppStore((s) => s.currentUser);
  // The hub is unreachable during What-If (uiStore.openSettings refuses too):
  // configuration deletes cascade on the server while the sandbox keeps
  // showing the orphaned plan data.
  const { blocked, reason } = useWhatIfBlocked();

  if (!canOpenSettings(currentUser)) return null;

  return (
    <div className={`${styles.section} ${collapsed ? styles.collapsed : ''}`}>
      <button
        type="button"
        className={styles.item}
        onClick={() => openSettings()}
        disabled={blocked}
        title={blocked ? reason('Opening Settings') : collapsed ? 'Settings' : undefined}
        aria-label="Settings"
      >
        <span className={styles.icon}>
          <Icon icon={GearIcon} size={16} />
        </span>
        {!collapsed && <span className={styles.label}>Settings</span>}
      </button>
    </div>
  );
}
