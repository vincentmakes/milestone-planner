import { useViewStore } from '@/stores/viewStore';
import { ResourceTabs } from './ResourceTabs';
import { ResourceList } from './ResourceList';
import styles from './ResourcePanel.module.css';
import { Icon, ChevronRightIcon } from '@/components/common/Icon';

export function ResourcePanel() {
  const resourcePanelCollapsed = useViewStore((s) => s.resourcePanelCollapsed);
  const setResourcePanelCollapsed = useViewStore((s) => s.setResourcePanelCollapsed);

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
        <Icon icon={ChevronRightIcon} size={16} />
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
