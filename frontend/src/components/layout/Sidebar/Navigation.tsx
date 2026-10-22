import { useViewStore } from '@/stores/viewStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useAllowedViews } from '@/hooks/useAllowedViews';
import { useTodoStore } from '@/stores/todoStore';
import type { CurrentView } from '@/types';
import styles from './Navigation.module.css';
import { Icon, ArchiveIcon, GlobeIcon, EquipmentViewIcon, UsersIcon, CheckBoxIcon, KanbanIcon, GanttIcon } from '@/components/common/Icon';

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
    view: 'todos',
    label: 'My Todos',
    icon: <Icon icon={CheckBoxIcon} size={18} />,
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
  // Views without their key are hidden; Cross-site is disabled with a reason
  // while only one site is visible (VIEW_PERMISSIONS in useAllowedViews).
  const { visible, disabledReason } = useAllowedViews();
  // Requests to decide + my open tasks (a primitive: todoStore keeps it current).
  const todoCount = useTodoStore((s) => s.openCount);

  return (
    <nav className={`${styles.nav} ${collapsed ? styles.collapsed : ''}`}>
      {NAV_ITEMS.filter((item) => visible.includes(item.view)).map((item) => {
        const isBlocked = blocked && item.view !== currentView && item.view !== 'gantt';
        const unavailable = disabledReason[item.view];
        const badge = item.view === 'todos' && todoCount > 0 ? todoCount : 0;
        const name = badge > 0 ? `${item.label}, ${badge} open item${badge === 1 ? '' : 's'}` : item.label;
        return (
          <button
            key={item.view}
            type="button"
            className={`${styles.navItem} ${currentView === item.view ? styles.active : ''}`}
            onClick={() => setCurrentView(item.view)}
            disabled={isBlocked || Boolean(unavailable)}
            title={
              isBlocked ? reason('Switching views') : unavailable ?? (collapsed ? item.label : undefined)
            }
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
