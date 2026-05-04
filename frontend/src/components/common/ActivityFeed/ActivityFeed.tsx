/**
 * ActivityFeed Component
 *
 * Miro/Monday-style live activity feed. Shows a stack of toast cards in the
 * bottom-right whenever another user makes a change in the same tenant.
 * Each toast auto-dismisses after a few seconds, giving the receiving user
 * clear attribution for what just changed and who made the change.
 */

import { memo, useEffect, useState, useMemo } from 'react';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import type { ChangePayload } from '@/hooks/useWebSocket';
import { useAppStore } from '@/stores/appStore';
import styles from './ActivityFeed.module.css';

const TOAST_LIFETIME = 4500;
const MAX_VISIBLE = 4;

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

interface ToastEntry extends ChangePayload {
  /** Unique key for React rendering even if multiple changes share entity_id */
  _key: string;
  /** Local time the toast was queued (for fade-out) */
  _at: number;
}

const ENTITY_LABELS: Record<string, string> = {
  phase: 'phase',
  subphase: 'subphase',
  project: 'project',
  assignment: 'assignment',
};

const ACTION_VERBS: Record<string, string> = {
  create: 'added',
  update: 'updated',
  delete: 'deleted',
  move: 'moved',
};

function describeChange(change: ChangePayload, projectName: string | undefined): string {
  const verb = ACTION_VERBS[change.action] ?? 'changed';
  const entity = ENTITY_LABELS[change.entity_type] ?? change.entity_type;
  const summary = change.summary?.trim();
  const target = summary ? `${entity} "${summary}"` : entity;
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
    const fade = window.setTimeout(() => setClosing(true), TOAST_LIFETIME - 300);
    const remove = window.setTimeout(() => onDismiss(toast._key), TOAST_LIFETIME);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(remove);
    };
  }, [toast._key, onDismiss]);

  const description = describeChange(toast, projectName);
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

export const ActivityFeed = memo(function ActivityFeed() {
  const { recentChanges } = useWebSocketContext();
  const projects = useAppStore((s) => s.projects);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [seen] = useState<Set<string>>(() => new Set());

  // Append new changes to the toast queue. We dedupe by timestamp+entity so
  // a single broadcast can't spawn duplicate toasts.
  useEffect(() => {
    if (recentChanges.length === 0) return;

    const newToasts: ToastEntry[] = [];
    for (const change of recentChanges) {
      const key = `${change.timestamp ?? ''}:${change.entity_type}:${change.entity_id}:${change.action}:${change.user_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newToasts.push({ ...change, _key: key, _at: Date.now() });
    }
    if (newToasts.length === 0) return;

    setToasts((prev) => {
      const combined = [...prev, ...newToasts];
      // Keep only most recent N
      return combined.slice(-MAX_VISIBLE);
    });
  }, [recentChanges, seen]);

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
          projectName={projectNamesById.get(t.project_id)}
          onDismiss={dismiss}
        />
      ))}
    </div>
  );
});

export default ActivityFeed;
