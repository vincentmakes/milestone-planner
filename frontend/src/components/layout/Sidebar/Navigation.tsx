import { useViewStore } from '@/stores/viewStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useAllowedViews } from '@/hooks/useAllowedViews';
import { useWorkStore } from '@/stores/workStore';
import type { CurrentView } from '@/types';
import styles from './Navigation.module.css';
import { Icon, ArchiveIcon, GlobeIcon, EquipmentViewIcon, UsersIcon, WorkIcon, KanbanIcon, GanttIcon } from '@/components/common/Icon';

interface NavItem {
  view: CurrentView;
  label: string;
  icon: React.ReactNode;
}

interface NavigationProps {
  collapsed?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    view: 'gantt',
    label: 'Gantt Chart',
    icon: <Icon icon={GanttIcon} size={18} />,
  },
  {
    view: 'kanban',
    label: 'Kanban Board',
    icon: <Icon icon={KanbanIcon} size={18} />,
  },
  {
    view: 'work',
    label: 'My Work',
    icon: <Icon icon={WorkIcon} size={18} />,
  },
  {
    view: 'staff',
    label: 'Staff Overview',
    icon: <Icon icon={UsersIcon} size={18} />,
  },
  {
    view: 'equipment',
    label: 'Equipment',
    icon: <Icon icon={EquipmentViewIcon} size={18} />,
  },
  {
    view: 'crosssite',
    label: 'Cross-Site',
    icon: <Icon icon={GlobeIcon} size={18} />,
  },
  {
    view: 'archived',
    label: 'Archived',
    icon: <Icon icon={ArchiveIcon} size={18} />,
  },
];

export function Navigation({ collapsed = false }: NavigationProps) {
  const currentView = useViewStore((s) => s.currentView);
  const setCurrentView = useViewStore((s) => s.setCurrentView);
  // What-If is a Gantt-only sandbox: while it is active the other views are
  // out of reach (nothing is discarded behind the user's back). The Gantt
  // itself stays enabled so the sandbox can always be returned to.
  const { blocked, reason } = useWhatIfBlocked();
  // Views without their key are hidden, and Cross-site while only one site
  // is visible (VIEW_PERMISSIONS in useAllowedViews).
  const { visible } = useAllowedViews();
  // Approval requests to decide (a primitive: workStore keeps it current).
  const approvalCount = useWorkStore((s) => s.openCount);

  return (
    <nav className={`${styles.nav} ${collapsed ? styles.collapsed : ''}`}>
      {NAV_ITEMS.filter((item) => visible.includes(item.view)).map((item) => {
        const isBlocked = blocked && item.view !== currentView && item.view !== 'gantt';
        const badge = item.view === 'work' && approvalCount > 0 ? approvalCount : 0;
        const name =
          badge > 0 ? `${item.label}, ${badge} approval${badge === 1 ? '' : 's'} to decide` : item.label;
        return (
          <button
            key={item.view}
            type="button"
            className={`${styles.navItem} ${currentView === item.view ? styles.active : ''}`}
            onClick={() => setCurrentView(item.view)}
            disabled={isBlocked}
            title={isBlocked ? reason('Switching views') : collapsed ? item.label : undefined}
            aria-label={name}
          >
            <span className={styles.icon}>{item.icon}</span>
            {!collapsed && <span className={styles.label}>{item.label}</span>}
            {badge > 0 && (
              <span className={styles.countBadge} aria-hidden="true">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
