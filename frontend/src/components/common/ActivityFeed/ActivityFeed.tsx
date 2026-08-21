/**
 * ActivityFeed Component
 *
 * Miro/Monday-style live activity feed. Shows a stack of toast cards in the
 * bottom-right whenever another user makes a change in the same tenant.
 * Cascaded changes (e.g. one drag that triggers child-subphase updates)
 * are coalesced into a single toast per user+project within a short window.
 */

import { memo, useEffect, useState, useMemo, useRef } from 'react';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import type { ChangePayload } from '@/hooks/useWebSocket';
import { useAppStore } from '@/stores/appStore';
import styles from './ActivityFeed.module.css';

const TOAST_LIFETIME = 6000;
const MAX_VISIBLE = 4;
/** Coalesce additional changes from the same user/project into one toast within this window. */
const COALESCE_WINDOW = 2500;

const AVATAR_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f97316',
  '#10b981',
  '#06b6d4',
  '#f59e0b',
  '#ef4444',
];

function getAvatarColor(userId: number): string {
  return AVATAR_COLORS[userId % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ENTITY_LABELS: Record<string, string> = {
  phase: 'phase',
  subphase: 'subphase',
  project: 'project',
  assignment: 'assignment',
  staff: 'staff member',
  equipment: 'equipment',
  equipment_block: 'equipment block',
  vacation: 'vacation',
  skill: 'skill',
  site: 'site',
  custom_column: 'custom column',
  note: 'note',
  tag: 'tag',
  card_comment: 'comment',
  staff_assignment: 'staff assignment',
  equipment_assignment: 'equipment booking',
  user: 'user',
  predefined_phase: 'phase template',
  bank_holiday: 'bank holiday',
  company_event: 'company event',
};

const ACTION_VERBS: Record<string, string> = {
  create: 'added',
  update: 'updated',
  delete: 'deleted',
  move: 'moved',
};

interface ToastEntry {
  _key: string;
  _at: number;
  user_id: number;
  user_name: string;
  /** project_id for the bucket; 0 means not project-scoped. */
  project_id: number;
  /** Aggregate counter so we can show "5 changes" if many cascaded events arrive. */
  count: number;
  /** Most recent change in this group, used to render the description. */
  latest: ChangePayload;
}

function describe(toast: ToastEntry, projectName: string | undefined): string {
  const change = toast.latest;
  const verb = ACTION_VERBS[change.action] ?? 'changed';
  const entity = ENTITY_LABELS[change.entity_type] ?? change.entity_type;
  const summary = change.summary?.trim();
  const target = summary ? `${entity} "${summary}"` : entity;

  // Multiple cascaded events: keep it short.
  if (toast.count > 1) {
    if (projectName) return `made ${toast.count} changes in ${projectName}`;
    return `made ${toast.count} changes`;
  }

  if (projectName && change.entity_type !== 'project') {
    return `${verb} ${target} in ${projectName}`;
  }
  if (change.entity_type === 'project' && summary) {
    return `${verb} project "${summary}"`;
  }
  return `${verb} ${target}`;
}

interface ActivityToastProps {
  toast: ToastEntry;
  projectName: string | undefined;
  onDismiss: (key: string) => void;
}

const ActivityToast = memo(function ActivityToast({ toast, projectName, onDismiss }: ActivityToastProps) {
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    // Toast lifetime is measured from the LATEST change in the group, so a
    // burst of cascaded updates keeps the same card visible.
    const elapsed = Date.now() - toast._at;
    const remaining = Math.max(800, TOAST_LIFETIME - elapsed);
    const fade = window.setTimeout(() => setClosing(true), Math.max(300, remaining - 300));
    const remove = window.setTimeout(() => onDismiss(toast._key), remaining);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(remove);
    };
  }, [toast._key, toast._at, onDismiss]);

  const description = describe(toast, projectName);
  const color = getAvatarColor(toast.user_id);

  return (
    <div className={`${styles.toast} ${closing ? styles.closing : ''}`}>
      <div className={styles.avatar} style={{ backgroundColor: color }}>
        {getInitials(toast.user_name)}
      </div>
      <div className={styles.body}>
        <div className={styles.title}>
          <span className={styles.userName}>{toast.user_name}</span>
          <span className={styles.action}>{description}</span>
        </div>
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={() => onDismiss(toast._key)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
});

function changeKey(c: ChangePayload): string {
  return `${c.timestamp ?? ''}:${c.entity_type}:${c.entity_id}:${c.action}:${c.user_id}`;
}

export const ActivityFeed = memo(function ActivityFeed() {
  const { recentChanges } = useWebSocketContext();
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  // Site -> project_id index. Used to filter incoming change broadcasts so
  // a user looking at site A doesn't get spammed by activity in site B.
  // Broadcasts whose project_id we can't classify (project_id=0, or for an
  // entity that isn't tied to a project) are shown by default - they're
  // typically site-agnostic things like a new tag or skill.
  const projectSiteById = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const p of projects) {
      map.set(p.id, (p as { site_id?: number | null }).site_id ?? null);
    }
    return map;
  }, [projects]);

  useEffect(() => {
    if (recentChanges.length === 0) return;

    const currentSiteId = currentSite?.id ?? null;

    // Find any changes we haven't ingested yet AND that belong to the
    // current site (or that aren't site-scoped at all).
    const fresh: ChangePayload[] = [];
    for (const c of recentChanges) {
      const k = changeKey(c);
      if (seenRef.current.has(k)) continue;
      seenRef.current.add(k);

      if (currentSiteId != null && c.project_id) {
        const projectSite = projectSiteById.get(c.project_id);
        if (projectSite != null && projectSite !== currentSiteId) {
          // Edit happened in another site - drop the toast.
          continue;
        }
      }

      fresh.push(c);
    }
    if (fresh.length === 0) return;

    setToasts((prev) => {
      const next = [...prev];
      const now = Date.now();
      for (const c of fresh) {
        // Bucket by user + project so cascaded child updates merge with their parent.
        const bucketIdx = next.findIndex(
          (t) =>
            t.user_id === c.user_id &&
            t.project_id === c.project_id &&
            now - t._at < COALESCE_WINDOW,
        );
        if (bucketIdx >= 0) {
          const prevToast = next[bucketIdx];
          next[bucketIdx] = {
            ...prevToast,
            _at: now,
            count: prevToast.count + 1,
            latest: c,
            user_name: c.user_name,
          };
        } else {
          next.push({
            _key: changeKey(c),
            _at: now,
            user_id: c.user_id,
            user_name: c.user_name,
            project_id: c.project_id,
            count: 1,
            latest: c,
          });
        }
      }
      return next.slice(-MAX_VISIBLE);
    });
  }, [recentChanges, currentSite, projectSiteById]);

  const projectNamesById = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  const dismiss = (key: string) => {
    setToasts((prev) => prev.filter((t) => t._key !== key));
  };

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container} role="status" aria-live="polite">
      {toasts.map((t) => (
        <ActivityToast
          key={t._key}
          toast={t}
          projectName={t.project_id ? projectNamesById.get(t.project_id) : undefined}
          onDismiss={dismiss}
        />
      ))}
    </div>
  );
});

export default ActivityFeed;
