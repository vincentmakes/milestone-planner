import { useAppStore } from '@/stores/appStore';
import { ResourceTabs } from './ResourceTabs';
import { ResourceList } from './ResourceList';
import styles from './ResourcePanel.module.css';

export function ResourcePanel() {
  const resourcePanelCollapsed = useAppStore((s) => s.resourcePanelCollapsed);
  const setResourcePanelCollapsed = useAppStore((s) => s.setResourcePanelCollapsed);

  const toggleCollapsed = () => {
    setResourcePanelCollapsed(!resourcePanelCollapsed);
  };

  return (
    <aside
      className={`${styles.panel} ${resourcePanelCollapsed ? styles.collapsed : ''}`}
    >
      <button
        className={styles.collapseBtn}
        onClick={toggleCollapsed}
        title={resourcePanelCollapsed ? 'Expand panel' : 'Collapse panel'}
        aria-label={resourcePanelCollapsed ? 'Expand panel' : 'Collapse panel'}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      <div className={styles.content}>
        <div className={styles.header}>
          <h2 className={styles.title}>Resources</h2>
        </div>
        <ResourceTabs />
        <ResourceList />
      </div>
    </aside>
  );
}
