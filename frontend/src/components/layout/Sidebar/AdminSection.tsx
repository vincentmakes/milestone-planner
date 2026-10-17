import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import styles from './AdminSection.module.css';

interface AdminSectionProps {
  collapsed?: boolean;
}

/**
 * Sidebar admin entry: one "Settings" item opening the Settings hub, where
 * users, sites, calendars, equipment, phases and SSO are managed. The hub
 * lists only the sections the user's role may open.
 */
export function AdminSection({ collapsed = false }: AdminSectionProps) {
  const openSettings = useUIStore((s) => s.openSettings);
  const currentUser = useAppStore((s) => s.currentUser);
  // The hub is unreachable during What-If (uiStore.openSettings refuses too):
  // configuration deletes cascade on the server while the sandbox keeps
  // showing the orphaned plan data.
  const { blocked, reason } = useWhatIfBlocked();

  const canOpenSettings = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  if (!canOpenSettings) return null;

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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </span>
        {!collapsed && <span className={styles.label}>Settings</span>}
      </button>
    </div>
  );
}
