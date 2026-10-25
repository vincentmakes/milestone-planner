import { useEffect, useId } from 'react';
import { useViewStore } from '@/stores/viewStore';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { leaveViewThen } from '@/utils/viewLeaveGuard';
import { useAllowedViews } from '@/hooks/useAllowedViews';
import { useWorkStore } from '@/stores/workStore';
import type { CurrentView } from '@/types';
import styles from './Navigation.module.css';
import {
  Icon,
  ArchiveIcon,
  ChevronRightIcon,
  DashboardIcon,
  GlobeIcon,
  EquipmentViewIcon,
  UsersIcon,
  WorkIcon,
  KanbanIcon,
  GanttIcon,
} from '@/components/common/Icon';

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
    view: 'dashboards',
    label: 'Dashboards',
    icon: <Icon icon={DashboardIcon} size={18} />,
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

  // The Dashboards entry lists the dashboards the user may open (the store's
  // order: the default first, then by name). Its chevron shows / hides them.
  const dashboardsVisible = visible.includes('dashboards');
  const dashboards = useDashboardStore((s) => s.dashboards);
  const listLoaded = useDashboardStore((s) => s.listLoaded);
  const listFailed = useDashboardStore((s) => s.loadError !== null);
  const openDashboardId = useDashboardStore((s) => s.current?.id ?? null);
  const expanded = useViewStore((s) => s.sidebarDashboardsExpanded);
  const toggleExpanded = useViewStore((s) => s.toggleSidebarDashboards);
  const listId = useId();

  // The list is needed before the view ever opened: one GET (errors are
  // swallowed by the store; the WebSocket provider keeps a loaded list fresh).
  useEffect(() => {
    if (dashboardsVisible && !listLoaded) void useDashboardStore.getState().refreshList();
  }, [dashboardsVisible, listLoaded]);

  return (
    <nav className={`${styles.nav} ${collapsed ? styles.collapsed : ''}`}>
      {NAV_ITEMS.filter((item) => visible.includes(item.view)).map((item) => {
        const isBlocked = blocked && item.view !== currentView && item.view !== 'gantt';
        const badge = item.view === 'work' && approvalCount > 0 ? approvalCount : 0;
        const name =
          badge > 0 ? `${item.label}, ${badge} approval${badge === 1 ? '' : 's'} to decide` : item.label;
        const navButton = (
          <button
            key={item.view}
            type="button"
            className={`${styles.navItem} ${currentView === item.view ? styles.active : ''}`}
            onClick={() => {
              if (item.view === currentView) return;
              // A view with unsaved work (the dashboard builder) may ask first.
              leaveViewThen(() => setCurrentView(item.view));
            }}
            disabled={isBlocked}
            title={isBlocked ? reason('Switching views') : collapsed ? item.label : undefined}
            aria-label={name}
            aria-current={currentView === item.view ? 'page' : undefined}
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
        // Icons only: the list of names has no room, the row alone opens the view.
        if (item.view !== 'dashboards' || collapsed) return navButton;
        const subDisabled = isBlocked;
        const subTitle = isBlocked ? reason('Switching views') : undefined;
        return (
          <div key={item.view} className={styles.group}>
            <div className={styles.groupHead}>
              {navButton}
              <button
                type="button"
                className={`${styles.chevron} ${expanded ? styles.expanded : ''}`}
                onClick={toggleExpanded}
                aria-expanded={expanded}
                aria-controls={listId}
                aria-label={expanded ? 'Hide dashboards' : 'Show dashboards'}
                title={expanded ? 'Hide dashboards' : 'Show dashboards'}
              >
                <Icon icon={ChevronRightIcon} size={16} />
              </button>
            </div>
            {expanded && (
              <ul id={listId} className={styles.subList} aria-label="Dashboards">
                {dashboards.map((dashboard) => {
                  const active = currentView === 'dashboards' && openDashboardId === dashboard.id;
                  return (
                    <li key={dashboard.id}>
                      <button
                        type="button"
                        className={`${styles.subItem} ${active ? styles.active : ''}`}
                        aria-current={active ? 'page' : undefined}
                        disabled={subDisabled}
                        title={subDisabled ? subTitle : dashboard.name}
                        onClick={() => {
                          if (active) return;
                          // The builder's draft may ask first (the view's leave guard).
                          leaveViewThen(() => {
                            setCurrentView('dashboards');
                            void useDashboardStore.getState().open(dashboard.id);
                          });
                        }}
                      >
                        <span className={styles.subLabel}>{dashboard.name}</span>
                      </button>
                    </li>
                  );
                })}
                {listLoaded && !listFailed && dashboards.length === 0 && (
                  <li className={styles.subEmpty}>No dashboards</li>
                )}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
