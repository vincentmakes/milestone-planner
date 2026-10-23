/**
 * useDashboardEditor — the dashboard builder's draft (2.1.0).
 *
 * Edit mode is a draft of the open dashboard (`startEdit`) or of a new one
 * (`startNew`, created by the dialog; nothing is sent until Save): its name,
 * description, visibility, roles and widgets, each widget with a client id
 * (`w<id>` for a saved one, `n<k>` for a new one, which has no `id`). The
 * grid shows the draft (`gridWidgets`: a new widget carries a negative grid
 * id) with the store's data, or a widget's last preview once the widget
 * editor saved it (`gridData`).
 *
 * - `dirty`: a new dashboard always; else the draft differs from what was
 *   opened (key order ignored).
 * - `setLayouts(layouts)`: the grid's layouts (grid id → `{lg, md, sm}`) back
 *   onto the widgets. react-grid-layout reports on mount and after a
 *   compaction too, so a call that changes no position is ignored (no
 *   re-render, not dirty).
 * - `cancel()` asks `Discard the changes to this dashboard?` when dirty;
 *   `confirmDiscard()` asks the same without leaving (switching dashboards,
 *   and the view's leave guard, registered while editing).
 * - `save()` runs under `useSubmitGuard`: the store saves (POST for a new
 *   dashboard, else a PUT replacing the widgets) and shows the saved
 *   dashboard; edit mode ends. A failure stays in edit mode with `error`.
 *
 * While editing, `dashboardStore.editing` is set, so a live "dashboard
 * changed" reload never replaces the open dashboard under the draft.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { confirmAction } from '@/utils/confirmDialog';
import { setViewLeaveGuard } from '@/utils/viewLeaveGuard';
import type { Dashboard, DashboardDraft, DashboardWidget, MetricError, MetricResult, WidgetLayout } from '@/types';
import {
  comparableDraft,
  gridIdOf,
  sameLayout,
  stableKey,
  toDraftWidget,
} from './widgetDraft';
import type { DashboardMeta, DraftWidget, EditorDraft } from './widgetDraft';

export const DISCARD_CONFIRM = {
  message: 'Discard the changes to this dashboard?',
  destructive: true,
  confirmLabel: 'Discard',
} as const;

const SAVE_ERROR = 'The dashboard could not be saved.';

/** A save error in plain words (FastAPI's model-level 422 is prefixed with "body: "). */
export function plainError(err: unknown, fallback: string): string {
  const message = err instanceof Error && err.message ? err.message : fallback;
  return message.replace(/(^|, )body: /g, '$1');
}

function draftOf(dashboard: Dashboard): EditorDraft {
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    visibility: dashboard.visibility,
    role_ids: [...dashboard.role_ids],
    widgets: dashboard.widgets.map(toDraftWidget),
  };
}

export interface DashboardEditor {
  editing: boolean;
  draft: EditorDraft | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** The draft's widgets for the grid (new ones with a negative id) */
  gridWidgets: DashboardWidget[];
  /** The grid's data: the store's results, or a widget's last preview */
  gridData: Record<number, MetricResult | MetricError>;
  startNew: (meta: DashboardMeta) => void;
  startEdit: (dashboard?: Dashboard | null) => void;
  /** Leave edit mode, asking first when dirty; true when it left */
  cancel: () => Promise<boolean>;
  /** Ask (when dirty) whether the draft may be dropped, without leaving */
  confirmDiscard: () => Promise<boolean>;
  /** Leave edit mode without asking */
  discard: () => void;
  setMeta: (meta: DashboardMeta) => void;
  setLayouts: (layouts: Record<number, WidgetLayout>) => void;
  upsertWidget: (widget: DraftWidget, preview?: MetricResult | null) => void;
  removeWidget: (clientId: string) => void;
  /** The draft widget behind a grid id */
  widgetByGridId: (gridId: number) => DraftWidget | undefined;
  save: () => Promise<Dashboard | null>;
  clearError: () => void;
}

export function useDashboardEditor(current: Dashboard | null): DashboardEditor {
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  // A widget the widget editor saved: its last preview (null = none yet).
  const [previews, setPreviews] = useState<Record<string, MetricResult | null>>({});
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting, begin, end } = useSubmitGuard();
  const data = useDashboardStore((s) => s.data);
  const editing = draft !== null;

  const dirty = useMemo(
    () => draft !== null && (baseline === null || stableKey(comparableDraft(draft)) !== baseline),
    [draft, baseline]
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // The store must not replace the open dashboard under the draft.
  useEffect(() => {
    useDashboardStore.getState().setEditing(editing);
  }, [editing]);
  useEffect(() => () => useDashboardStore.getState().setEditing(false), []);

  const discard = useCallback(() => {
    // At once, so the view may open another dashboard right after.
    useDashboardStore.getState().setEditing(false);
    setDraft(null);
    setBaseline(null);
    setPreviews({});
    setError(null);
  }, []);

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return confirmAction({ ...DISCARD_CONFIRM });
  }, []);

  // Leaving the view while editing asks the same question.
  useEffect(() => (editing ? setViewLeaveGuard(confirmDiscard) : undefined), [editing, confirmDiscard]);

  const startNew = useCallback((meta: DashboardMeta) => {
    setDraft({ ...meta, role_ids: [...meta.role_ids], widgets: [] });
    setBaseline(null);
    setPreviews({});
    setError(null);
  }, []);

  const startEdit = useCallback(
    (dashboard?: Dashboard | null) => {
      const source = dashboard ?? current;
      if (!source) return;
      const next = draftOf(source);
      setDraft(next);
      setBaseline(stableKey(comparableDraft(next)));
      setPreviews({});
      setError(null);
    },
    [current]
  );

  const cancel = useCallback(async () => {
    if (!(await confirmDiscard())) return false;
    discard();
    return true;
  }, [confirmDiscard, discard]);

  const setMeta = useCallback((meta: DashboardMeta) => {
    setDraft((prev) => (prev ? { ...prev, ...meta, role_ids: [...meta.role_ids] } : prev));
  }, []);

  const setLayouts = useCallback((layouts: Record<number, WidgetLayout>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      let changed = false;
      const widgets = prev.widgets.map((widget) => {
        const next = layouts[gridIdOf(widget)];
        if (!next || sameLayout(next, widget.layout)) return widget;
        changed = true;
        return { ...widget, layout: next };
      });
      // A report that moves nothing (mount, compaction) keeps the same state.
      return changed ? { ...prev, widgets } : prev;
    });
  }, []);

  const upsertWidget = useCallback((widget: DraftWidget, preview?: MetricResult | null) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const index = prev.widgets.findIndex((w) => w.clientId === widget.clientId);
      const widgets =
        index === -1 ? [...prev.widgets, widget] : prev.widgets.map((w, i) => (i === index ? widget : w));
      return { ...prev, widgets };
    });
    // The stored result no longer matches the widget: its preview, or nothing.
    setPreviews((prev) => ({ ...prev, [widget.clientId]: preview ?? null }));
  }, []);

  const removeWidget = useCallback((clientId: string) => {
    setDraft((prev) => (prev ? { ...prev, widgets: prev.widgets.filter((w) => w.clientId !== clientId) } : prev));
  }, []);

  const gridWidgets = useMemo<DashboardWidget[]>(
    () =>
      (draft?.widgets ?? []).map((widget, index) => ({
        id: gridIdOf(widget),
        kind: widget.kind,
        title: widget.title,
        query: widget.query,
        options: widget.options,
        layout: widget.layout,
        sort_order: index,
      })),
    [draft]
  );

  const gridData = useMemo(() => {
    const out: Record<number, MetricResult | MetricError> = {};
    for (const widget of draft?.widgets ?? []) {
      if (widget.clientId in previews) {
        const preview = previews[widget.clientId];
        if (preview) out[gridIdOf(widget)] = preview;
      } else if (widget.id !== undefined && data[widget.id]) {
        out[widget.id] = data[widget.id];
      }
    }
    return out;
  }, [draft, previews, data]);

  const widgetByGridId = useCallback(
    (gridId: number) => draft?.widgets.find((w) => gridIdOf(w) === gridId),
    [draft]
  );

  const save = useCallback(async (): Promise<Dashboard | null> => {
    if (!draft || !begin()) return null;
    setError(null);
    const body: DashboardDraft = {
      ...(draft.id !== undefined ? { id: draft.id } : {}),
      name: draft.name,
      description: draft.description,
      visibility: draft.visibility,
      role_ids: draft.visibility === 'roles' ? draft.role_ids : [],
      widgets: draft.widgets.map(({ kind, title, query, options, layout }, index) => ({
        kind,
        title,
        query,
        options,
        layout,
        sort_order: index,
      })),
    };
    try {
      const saved = await useDashboardStore.getState().save(body);
      discard();
      return saved;
    } catch (err) {
      console.error('[Dashboards] Failed to save a dashboard', err);
      setError(plainError(err, SAVE_ERROR));
      return null;
    } finally {
      end();
    }
  }, [draft, begin, end, discard]);

  const clearError = useCallback(() => setError(null), []);

  return {
    editing,
    draft,
    dirty,
    saving: isSubmitting,
    error,
    gridWidgets,
    gridData,
    startNew,
    startEdit,
    cancel,
    confirmDiscard,
    discard,
    setMeta,
    setLayouts,
    upsertWidget,
    removeWidget,
    widgetByGridId,
    save,
    clearError,
  };
}
