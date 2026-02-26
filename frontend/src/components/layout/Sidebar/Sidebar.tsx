import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { Navigation } from './Navigation';
import { AdminSection } from './AdminSection';
import { QuickStats } from './QuickStats';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const sidebarCollapsed = useViewStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useViewStore((s) => s.setSidebarCollapsed);
  const currentUser = useAppStore((s) => s.currentUser);

  const isAdminOrSuperuser =
    currentUser?.role === 'admin' || currentUser?.role === 'superuser';

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
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      <div className={styles.content}>
        <div className={styles.section}>
          {!sidebarCollapsed && <div className={styles.sectionTitle}>Views</div>}
          <Navigation collapsed={sidebarCollapsed} />
        </div>

        {isAdminOrSuperuser && (
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
