/**
 * Notification bell + panel.
 *
 * This is a popover, not a modal: click-outside-to-close is the correct
 * behaviour here (the no-backdrop-close rule covers dialogs only). Dismissal
 * (outside click, Tab out, Escape) is the shared `useDismissableOverlay`.
 *
 * Server notifications and browser-derived due reminders are merged for
 * display; only the former are marked read against the API. A click opens
 * the card on the Kanban board, or — for approval requests and decisions —
 * My Work on the matching tab; both are blocked during
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
import { useWorkStore } from '@/stores/workStore';
import type { RequestsFilter, WorkTab } from '@/stores/workStore';
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
import type { IconComponent } from '@/components/common/Icon';
import { Icon, AssignedIcon, CommentIcon, MentionIcon, CheckBoxIcon, ClockIcon, WarningIcon, ShieldIcon, CheckCircleIcon, ManageAccountsIcon, EditCalendarIcon, BellIcon } from '@/components/common/Icon';

const TYPE_ICONS: Record<string, IconComponent> = {
  assigned: AssignedIcon,
  comment: CommentIcon,
  mention: MentionIcon,
  status_change: CheckBoxIcon,
  due_soon: ClockIcon,
  overdue: WarningIcon,
  approval_requested: ShieldIcon,
  approval_decided: CheckCircleIcon,
  // A person with a gear: someone else edited your booking.
  assignment_changed: ManageAccountsIcon,
  // A calendar with a pencil: someone else changed your project's plan.
  project_changed: EditCalendarIcon,
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

interface WorkTarget {
  tab: WorkTab;
  /** The Open/Done filter of My Requests that shows the item (none on My Approvals) */
  filter?: RequestsFilter;
}

/**
 * Where in My Work a notification about a request lands. A decision is about
 * a request that is no longer pending, so My Requests opens on Done.
 */
const WORK_TARGETS: Partial<Record<NotificationType, WorkTarget>> = {
  approval_requested: { tab: 'approvals' },
  approval_decided: { tab: 'requests', filter: 'done' },
};

/** My Work's target for this notification, unless it is about a card. */
function workTargetFor(n: AppNotification): WorkTarget | null {
  if (cardOf(n)) return null;
  return WORK_TARGETS[n.type] ?? null;
}

/** Where a click on a notification leads. */
type NotificationTarget =
  | { kind: 'card'; card: CardRef }
  | { kind: 'work'; work: WorkTarget }
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
  const work = workTargetFor(n);
  if (work) return { kind: 'work', work };
  // A card the board cannot open (all types), or the project itself.
  if (!n.project_id || !(card || n.entity_type === 'project')) return { kind: 'none' };
  const project = projects.find((p) => p.id === n.project_id && !p.archived);
  const site = project && visibleSites.find((s) => s.id === project.site_id);
  return project && site ? { kind: 'gantt', project, site } : { kind: 'missing' };
}

const OPEN_CARD_ACTION = 'Opening a card from a notification';
const OPEN_WORK_ACTION = 'Opening My Work from a notification';
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
  const setWorkTab = useWorkStore((s) => s.setActiveTab);
  const setRequestsFilter = useWorkStore((s) => s.setRequestsFilter);

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
    if (target.kind === 'work') return whatIf.reason(OPEN_WORK_ACTION);
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
    } else if (target.kind === 'work') {
      // My Work needs no key: every user has one.
      setWorkTab(target.work.tab);
      if (target.work.filter) setRequestsFilter(target.work.filter);
      setCurrentView('work');
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
        <Icon icon={BellIcon} size={18} />
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
                      <Icon icon={TYPE_ICONS[n.type] ?? TYPE_ICONS.comment} size={14} />
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
