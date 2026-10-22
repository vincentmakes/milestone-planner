/**
 * Notification bell + panel.
 *
 * This is a popover, not a modal: click-outside-to-close is the correct
 * behaviour here (the no-backdrop-close rule covers dialogs only). Dismissal
 * (outside click, Tab out, Escape) is the shared `useDismissableOverlay`.
 *
 * Server notifications and browser-derived due reminders are merged for
 * display; only the former are marked read against the API. A click opens
 * the card on the Kanban board, or — for approval requests, decisions and
 * assigned tasks — My Todos on the matching tab; both are blocked during
 * What-If (they leave the Gantt). A notification about a project, or about a
 * card while the board is out of reach (no `views.kanban`), opens the project
 * on the Gantt instead, switching site when it sits on another one (blocked
 * during What-If too); one without a project (a deleted project) is only
 * marked read.
 */

import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useNotificationStore } from '@/stores/notificationStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useTodoStore } from '@/stores/todoStore';
import type { TodoStatusFilter, TodoTab } from '@/stores/todoStore';
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/endpoints/notifications';
import {
  dismissDerivedNotification,
  useDerivedDueNotifications,
} from '@/hooks/useDerivedDueNotifications';
import { cardKey } from '@/utils/kanbanCards';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { selectSite } from '@/hooks/useDataLoader';
import { relativeTime } from '@/utils/relativeTime';
import type { AppNotification, NotificationType, Project, Site } from '@/types';
import styles from './NotificationBell.module.css';
import { useHasPermission } from '@/hooks/useCan';

const TYPE_ICONS: Record<string, string> = {
  assigned: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  mention: 'M12 2a10 10 0 1 0 4 19.2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5',
  status_change: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  due_soon: 'M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  overdue: 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  approval_requested: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  approval_decided: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
  todo_assigned: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  // A person with a pencil: someone else edited your booking.
  assignment_changed:
    'M11.5 15H7a4 4 0 0 0-4 4v2M10 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM21.4 16.6a1.4 1.4 0 0 0-2-2l-4 4a2 2 0 0 0-.5.9l-.8 2.8 2.8-.8a2 2 0 0 0 .9-.5z',
  // A calendar with plan bars: someone else changed your project's plan.
  project_changed:
    'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 14h6M11 18h6',
};

/** Icon colour classes for the types whose class name is not the type itself. */
const TYPE_CLASSES: Partial<Record<NotificationType, string>> = {
  assignment_changed: styles.assignmentChanged,
  project_changed: styles.projectChanged,
};

interface CardRef {
  entityType: 'phase' | 'subphase';
  entityId: number;
  projectId: number;
}

/** The Kanban card this notification is about, if it is about one. */
function cardOf(n: AppNotification): CardRef | null {
  if (!n.project_id || !n.entity_id) return null;
  if (n.entity_type !== 'phase' && n.entity_type !== 'subphase') return null;
  return { entityType: n.entity_type, entityId: n.entity_id, projectId: n.project_id };
}

interface TodosTarget {
  tab: TodoTab;
  /** The Open/Done filter that shows the item (none on To decide, which has no filter) */
  filter?: TodoStatusFilter;
}

/**
 * Where in My Todos a notification about a request or a task lands. A
 * decision is about a request that is no longer pending, so My requests
 * opens on Done; a new task is open.
 */
const TODO_TARGETS: Partial<Record<NotificationType, TodosTarget>> = {
  approval_requested: { tab: 'decide' },
  approval_decided: { tab: 'requests', filter: 'done' },
  todo_assigned: { tab: 'tasks', filter: 'open' },
};

/** My Todos' target for this notification, unless it is about a card. */
function todosTargetFor(n: AppNotification): TodosTarget | null {
  if (cardOf(n)) return null;
  return TODO_TARGETS[n.type] ?? null;
}

/** Where a click on a notification leads. */
type NotificationTarget =
  | { kind: 'card'; card: CardRef }
  | { kind: 'todos'; todos: TodosTarget }
  /** The project on the Gantt, at `site` (one of the visible sites) */
  | { kind: 'gantt'; project: Project; site: Site }
  /** It names a project the Gantt cannot show: deleted, archived or not visible */
  | { kind: 'missing' }
  /** Nothing to open (no project, e.g. a deleted one): only marked read */
  | { kind: 'none' };

function targetFor(
  n: AppNotification,
  canOpenCards: boolean,
  projects: readonly Project[],
  visibleSites: readonly Site[]
): NotificationTarget {
  const card = cardOf(n);
  if (card && canOpenCards) return { kind: 'card', card };
  const todos = todosTargetFor(n);
  if (todos) return { kind: 'todos', todos };
  // A card the board cannot open (all types), or the project itself.
  if (!n.project_id || !(card || n.entity_type === 'project')) return { kind: 'none' };
  const project = projects.find((p) => p.id === n.project_id && !p.archived);
  const site = project && visibleSites.find((s) => s.id === project.site_id);
  return project && site ? { kind: 'gantt', project, site } : { kind: 'missing' };
}

const OPEN_CARD_ACTION = 'Opening a card from a notification';
const OPEN_TODOS_ACTION = 'Opening My Todos from a notification';
const OPEN_OTHER_SITE_ACTION = 'Opening a project on another site from a notification';
const MISSING_PROJECT_MESSAGE = 'This project is no longer available';

export function NotificationBell() {
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const items = useNotificationStore((s) => s.items);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const panelOpen = useNotificationStore((s) => s.panelOpen);
  const setItems = useNotificationStore((s) => s.setItems);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const setPanelOpen = useNotificationStore((s) => s.setPanelOpen);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const markReadLocal = useNotificationStore((s) => s.markReadLocal);
  const markAllReadLocal = useNotificationStore((s) => s.markAllReadLocal);

  const currentUser = useAppStore((s) => s.currentUser);
  const projects = useAppStore((s) => s.projects);
  const currentSiteId = useAppStore((s) => s.currentSite?.id ?? null);
  const visibleSites = useVisibleSites();
  const setCurrentView = useViewStore((s) => s.setCurrentView);
  const setKanbanProjectId = useViewStore((s) => s.setKanbanProjectId);
  const ensureProjectExpanded = useViewStore((s) => s.ensureProjectExpanded);
  const openKanbanCard = useUIStore((s) => s.openKanbanCardModal);
  const showFlash = useUIStore((s) => s.showFlash);
  const setTodoTab = useTodoStore((s) => s.setActiveTab);
  const setTodoFilter = useTodoStore((s) => s.setStatusFilter);

  const derived = useDerivedDueNotifications();
  // What-If is Gantt-only and cannot switch site, so a target that leaves the
  // Gantt or changes site is blocked while the sandbox is active (other rows
  // stay usable).
  const whatIf = useWhatIfBlocked();
  // Card links open the Kanban board, which needs views.kanban (its reads
  // answer 403 without it): without it the card's project opens on the Gantt.
  const canOpenCards = useHasPermission('views.kanban');

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    try {
      const [list, count] = await Promise.all([getNotifications(), getUnreadCount()]);
      setItems(list);
      setUnreadCount(count);
    } catch (err) {
      console.error('[Notifications] Failed to refresh:', err);
    }
  }, [currentUser, setItems, setUnreadCount]);

  // Load on mount and on focus. The WebSocket push is only a hint: the
  // connection manager is per-process, so a user on another worker misses it.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const { onBlur } = useDismissableOverlay({
    open: panelOpen,
    onClose: () => setPanelOpen(false),
    wrapperRef: panelRef,
    triggerRef: bellRef,
  });

  const merged = useMemo(() => {
    // Derived reminders first: they are actionable now.
    return [...derived, ...items].slice(0, 60);
  }, [derived, items]);

  const totalBadge = unreadCount + derived.length;

  /** Why What-If blocks this target, if it does. */
  const blockedReason = (target: NotificationTarget): string | undefined => {
    if (!whatIf.blocked) return undefined;
    if (target.kind === 'card') return whatIf.reason(OPEN_CARD_ACTION);
    if (target.kind === 'todos') return whatIf.reason(OPEN_TODOS_ACTION);
    if (target.kind === 'gantt' && target.site.id !== currentSiteId) {
      return whatIf.reason(OPEN_OTHER_SITE_ACTION);
    }
    return undefined;
  };

  const handleOpen = async (n: AppNotification, target: NotificationTarget) => {
    if (blockedReason(target)) return;
    if (target.kind === 'card') {
      const { entityType, entityId, projectId } = target.card;
      setKanbanProjectId(projectId);
      setCurrentView('kanban');
      openKanbanCard(entityType, entityId, projectId);
    } else if (target.kind === 'todos') {
      // My Todos needs no key: every user has one.
      setTodoTab(target.todos.tab);
      if (target.todos.filter) setTodoFilter(target.todos.filter);
      setCurrentView('todos');
    } else if (target.kind === 'gantt') {
      // selectSite also loads the site's calendar and custom columns.
      if (target.site.id !== currentSiteId) void selectSite(target.site);
      setCurrentView('gantt');
      ensureProjectExpanded(target.project.id);
    } else if (target.kind === 'missing') {
      showFlash(MISSING_PROJECT_MESSAGE, 'info');
    }
    setPanelOpen(false);

    if (n.source === 'derived') {
      // Derived reminders are dismissed locally; there is no server row.
      if ((n.entity_type === 'phase' || n.entity_type === 'subphase') && n.entity_id && n.body) {
        const due = n.body.split('due ').pop() ?? '';
        dismissDerivedNotification(cardKey(n.entity_type, n.entity_id), due);
      }
      return;
    }

    if (!n.read_at) {
      markReadLocal(n.id);
      try {
        await markNotificationRead(n.id);
      } catch (err) {
        console.error('[Notifications] Failed to mark read:', err);
        void refresh();
      }
    }
  };

  const handleMarkAll = async () => {
    markAllReadLocal();
    try {
      await markAllNotificationsRead();
    } catch (err) {
      console.error('[Notifications] Failed to mark all read:', err);
      void refresh();
    }
  };

  if (!currentUser) return null;

  return (
    <div ref={panelRef} className={styles.wrapper} onBlur={onBlur}>
      <button
        ref={bellRef}
        type="button"
        className={`${styles.bell} ${totalBadge > 0 ? styles.hasUnread : ''}`}
        onClick={togglePanel}
        aria-label={`Notifications${totalBadge > 0 ? ` (${totalBadge} unread)` : ''}`}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        aria-controls={panelOpen ? panelId : undefined}
        title="Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {totalBadge > 0 && (
          <span className={styles.badge}>{totalBadge > 99 ? '99+' : totalBadge}</span>
        )}
      </button>

      {panelOpen && (
        <div id={panelId} className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className={styles.markAll} onClick={handleMarkAll}>
                Mark all read
              </button>
            )}
          </div>

          {whatIf.blocked && (
            <p className={styles.whatIfNote} role="note">
              {whatIf.reason(OPEN_CARD_ACTION)}
            </p>
          )}

          <ul className={styles.list}>
            {merged.map((n) => {
              const target = targetFor(n, canOpenCards, projects, visibleSites);
              const reason = blockedReason(target);
              return (
                <li key={`${n.source ?? 'server'}-${n.id}`}>
                  <button
                    type="button"
                    className={`${styles.item} ${!n.read_at ? styles.unread : ''}`}
                    onClick={() => handleOpen(n, target)}
                    disabled={Boolean(reason)}
                    title={reason}
                  >
                    <span className={`${styles.icon} ${TYPE_CLASSES[n.type] ?? styles[n.type] ?? ''}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d={TYPE_ICONS[n.type] ?? TYPE_ICONS.comment} />
                      </svg>
                    </span>
                    <span className={styles.text}>
                      <span className={styles.title}>{n.title}</span>
                      {n.body && <span className={styles.body}>{n.body}</span>}
                      <span className={styles.time}>{relativeTime(n.created_at)}</span>
                    </span>
                    {!n.read_at && <span className={styles.dot} aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
            {merged.length === 0 && <li className={styles.empty}>Nothing new</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
