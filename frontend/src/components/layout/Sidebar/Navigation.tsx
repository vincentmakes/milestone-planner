import { useViewStore } from '@/stores/viewStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useAllowedViews } from '@/hooks/useAllowedViews';
import { useTodoStore } from '@/stores/todoStore';
import type { CurrentView } from '@/types';
import styles from './Navigation.module.css';

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
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="12" y2="15" />
        <line x1="4" y1="21" x2="16" y2="21" />
        <rect x="4" y="3" width="16" height="2" rx="1" />
      </svg>
    ),
  },
  {
    view: 'kanban',
    label: 'Kanban Board',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="5" height="18" rx="1" />
        <rect x="10" y="3" width="5" height="12" rx="1" />
        <rect x="17" y="3" width="4" height="8" rx="1" />
      </svg>
    ),
  },
  {
    view: 'todos',
    label: 'My Todos',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    view: 'staff',
    label: 'Staff Overview',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    view: 'equipment',
    label: 'Equipment',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    view: 'crosssite',
    label: 'Cross-Site',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    view: 'archived',
    label: 'Archived',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="21 8 21 21 3 21 3 8" />
        <rect x="1" y="3" width="22" height="5" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    ),
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
