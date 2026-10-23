import { useAppStore } from '@/stores/appStore';
import { canOpenSettings } from '@/components/settings/sections';
import { useViewStore } from '@/stores/viewStore';
import { Navigation } from './Navigation';
import { AdminSection } from './AdminSection';
import { QuickStats } from './QuickStats';
import styles from './Sidebar.module.css';
import { Icon, BackIcon } from '@/components/common/Icon';

export function Sidebar() {
  const sidebarCollapsed = useViewStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useViewStore((s) => s.setSidebarCollapsed);
  const currentUser = useAppStore((s) => s.currentUser);

  // Anything to configure: at least one Settings section the user's keys list
  const showAdmin = canOpenSettings(currentUser);

  const toggleCollapsed = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  return (
    <aside
      className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ''}`}
    >
      <button
        className={styles.collapseBtn}
        onClick={toggleCollapsed}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <Icon icon={BackIcon} size={16} />
      </button>

      <div className={styles.content}>
        <div className={styles.section}>
          {!sidebarCollapsed && <div className={styles.sectionTitle}>Views</div>}
          <Navigation collapsed={sidebarCollapsed} />
        </div>

        {showAdmin && (
          <div className={styles.section}>
            {!sidebarCollapsed && <div className={styles.sectionTitle}>Admin</div>}
            <AdminSection collapsed={sidebarCollapsed} />
          </div>
        )}

        {!sidebarCollapsed && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Quick Stats</div>
            <QuickStats />
          </div>
        )}
      </div>
    </aside>
  );
}
