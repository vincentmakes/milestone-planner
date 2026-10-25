/**
 * useDashboardEditor — the dashboard builder's draft (2.1.0).
 *
 * Edit mode is a draft of the open dashboard (`startEdit`) or of a new one
 * (`startNew`, created by the dialog; nothing is sent until Save): its name,
 * description, visibility, sharing targets (roles, sites, teams, people) and
 * widgets, each widget with a client id
 * (`w<id>` for a saved one, `n<k>` for a new one, which has no `id`). The
 * grid shows the draft (`gridWidgets`: a new widget carries a negative grid
 * id) with the store's data, or a widget's last preview once the widget
 * editor saved it (`gridData`).
 *
 * - `dirty`: a new dashboard always; else the draft differs from what was
 *   opened (key order ignored).
 * - `setLayouts(layouts, source)`: the grid's layouts (grid id → `{lg, md, sm}`)
 *   back onto the widgets. react-grid-layout reports on mount and after a
 *   compaction too, so a call that changes no position is ignored (no
 *   re-render, not dirty). `source` says whether a drag or resize made the
 *   change (`'gesture'`, the default: one undo entry) or the library settled
 *   the grid after another change (`'settle'`: a widget removed, an undo —
 *   applied to the current state without an entry of its own, so it never
 *   clears the redo stack and one action stays one undo step).
 * - `cancel()` asks `Discard the changes to this dashboard?` when dirty;
 *   `confirmDiscard()` asks the same without leaving (switching dashboards,
 *   and the view's leave guard, registered while editing). Another dashboard
 *   opening under the draft (the sidebar's list, after the guard) discards it.
 * - `setMeta(partial)`: the inline name / description fields of edit mode
 *   (any part of the meta).
 * - `save()` runs under `useSubmitGuard`: the store saves (POST for a new
 *   dashboard, else a PUT replacing the widgets) and shows the saved
 *   dashboard; edit mode ends. A failure stays in edit mode with `error`.
 *   The PUT carries the name, description and widgets only -- never the
 *   visibility or the target lists, which only Share... changes -- so a
 *   widget save keeps the sharing as the server holds it (a change made
 *   meanwhile, a target deleted since). The POST of a new dashboard carries
 *   the sharing chosen in the New dialog (the lists empty unless `shared`).
 *   The draft keeps the sharing for the "Shared with" line and `dirty`.
 *
 * **Undo / redo** (`undo`, `redo`, `canUndo`, `canRedo`): every change of the
 * draft (`setLayouts` from a gesture, `upsertWidget`, `removeWidget`,
 * `setMeta`) pushes the state before it — the draft with the widgets'
 * previews, so an undone widget shows its preview again — onto the undo stack
 * (at most `HISTORY_LIMIT`, the oldest dropped) and clears the redo stack.
 * Typing coalesces: `setMeta` calls on the same field within
 * `COALESCE_MS` of the previous one extend the entry on top instead of
 * pushing, so one undo restores the text from before the burst; any other
 * action (or an undo) ends the run. `startEdit`, `startNew`, `discard` and a
 * successful save clear both stacks. `dirty` still compares with what was
 * opened, so undoing back to it makes the draft clean again.
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
  copyTargets,
  gridIdOf,
  sameLayout,
  savedTargets,
  stableKey,
  toDraftWidget,
} from './widgetDraft';
import type { DashboardMeta, DraftWidget, EditorDraft } from './widgetDraft';
import type { LayoutSource } from '../gridLayouts';

/** The undo stack's depth: older entries are dropped. */
export const HISTORY_LIMIT = 50;
/** Typing in one field within this long after the last keystroke is one undo step. */
export const COALESCE_MS = 1000;

/** A state of the draft the undo / redo stacks hold. */
interface Snapshot {
  draft: EditorDraft;
  previews: Record<string, MetricResult | null>;
}

interface EditorState {
  draft: EditorDraft | null;
  // A widget the widget editor saved: its last preview (null = none yet).
  previews: Record<string, MetricResult | null>;
  past: Snapshot[];
  future: Snapshot[];
  // The typing run `setMeta` may extend: the field(s) and the last keystroke.
  run: { key: string; at: number } | null;
}

const IDLE: EditorState = { draft: null, previews: {}, past: [], future: [], run: null };

const fresh = (draft: EditorDraft | null): EditorState => ({ ...IDLE, draft });

/** `prev` changed to `draft` / `previews` by a user action: one undo entry. */
function record(
  prev: EditorState,
  draft: EditorDraft,
  previews: Record<string, MetricResult | null> = prev.previews,
  run: EditorState['run'] = null
): EditorState {
  const past = prev.draft ? [...prev.past, { draft: prev.draft, previews: prev.previews }] : prev.past;
  return {
    draft,
    previews,
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],
    run,
  };
}

export const DISCARD_CONFIRM = {
  message: 'Discard the changes to this dashboard?',
  destructive: true,
  confirmLabel: 'Discard',
} as const;

const SAVE_ERROR = 'The dashboard could not be saved.';

/**
 * A save or preview error in plain words: the API client flattens a FastAPI
 * 422 into `<location>: <message>` (`body: `, `absolute: `, or a dotted path
 * such as `body.filters.period.absolute: `); every such leading location is
 * dropped, the message itself is kept as it is.
 */
export function plainError(err: unknown, fallback: string): string {
  const message = err instanceof Error && err.message ? err.message : fallback;
  return message.replace(/(^|, )(?:[\w.]+: )+/g, '$1');
}

function draftOf(dashboard: Dashboard): EditorDraft {
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    visibility: dashboard.visibility,
    ...copyTargets(dashboard),
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
  /** Change part of the name, description or sharing */
  setMeta: (meta: Partial<DashboardMeta>) => void;
  /** The grid's layouts; a `'settle'` report adds no undo entry */
  setLayouts: (layouts: Record<number, WidgetLayout>, source?: LayoutSource) => void;
  upsertWidget: (widget: DraftWidget, preview?: MetricResult | null) => void;
  removeWidget: (clientId: string) => void;
  /** The draft widget behind a grid id */
  widgetByGridId: (gridId: number) => DraftWidget | undefined;
  save: () => Promise<Dashboard | null>;
  clearError: () => void;
  /** Back to the draft before the last change */
  undo: () => void;
  /** Replay the last undone change */
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useDashboardEditor(current: Dashboard | null): DashboardEditor {
  const [state, setState] = useState<EditorState>(IDLE);
  const { draft, previews } = state;
  const [baseline, setBaseline] = useState<string | null>(null);
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
    setState(IDLE);
    setBaseline(null);
    setError(null);
  }, []);

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return confirmAction({ ...DISCARD_CONFIRM });
  }, []);

  // Leaving the view while editing asks the same question.
  useEffect(() => (editing ? setViewLeaveGuard(confirmDiscard) : undefined), [editing, confirmDiscard]);

  // The dashboard open when the draft began. Another one opening under the
  // draft (the sidebar's list, once the leave guard agreed) ends edit mode:
  // the draft never stays over a dashboard it was not made from.
  const currentId = current?.id ?? null;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const draftOfIdRef = useRef<number | null>(null);
  const seenIdRef = useRef(currentId);
  useEffect(() => {
    const changed = currentId !== seenIdRef.current;
    seenIdRef.current = currentId;
    if (editing && changed && currentId !== null && currentId !== draftOfIdRef.current) discard();
  }, [editing, currentId, discard]);

  const startNew = useCallback((meta: DashboardMeta) => {
    draftOfIdRef.current = currentIdRef.current;
    setState(fresh({ ...meta, ...copyTargets(meta), widgets: [] }));
    setBaseline(null);
    setError(null);
  }, []);

  const startEdit = useCallback(
    (dashboard?: Dashboard | null) => {
      const source = dashboard ?? current;
      if (!source) return;
      draftOfIdRef.current = source.id;
      const next = draftOf(source);
      setState(fresh(next));
      setBaseline(stableKey(comparableDraft(next)));
      setError(null);
    },
    [current]
  );

  const cancel = useCallback(async () => {
    if (!(await confirmDiscard())) return false;
    discard();
    return true;
  }, [confirmDiscard, discard]);

  const setMeta = useCallback((meta: Partial<DashboardMeta>) => {
    const key = Object.keys(meta).sort().join(',');
    const now = Date.now();
    setState((prev) => {
      if (!prev.draft) return prev;
      const merged = { ...prev.draft, ...meta };
      const next = { ...merged, ...copyTargets(merged) };
      const draft = prev.draft;
      const same = (Object.keys(meta) as (keyof DashboardMeta)[]).every(
        (k) => stableKey(next[k] ?? null) === stableKey(draft[k] ?? null)
      );
      // Nothing changed (the same text again): no entry, no re-render.
      if (same) return prev;
      const run = { key, at: now };
      // Still typing in the same field: the entry on top keeps the text from before.
      if (prev.run && prev.run.key === key && now - prev.run.at <= COALESCE_MS && prev.past.length > 0) {
        return { ...prev, draft: next, future: [], run };
      }
      return record(prev, next, prev.previews, run);
    });
  }, []);

  const setLayouts = useCallback((layouts: Record<number, WidgetLayout>, source: LayoutSource = 'gesture') => {
    setState((prev) => {
      if (!prev.draft) return prev;
      let changed = false;
      const widgets = prev.draft.widgets.map((widget) => {
        const next = layouts[gridIdOf(widget)];
        if (!next || sameLayout(next, widget.layout)) return widget;
        changed = true;
        return { ...widget, layout: next };
      });
      // A report that moves nothing (mount, compaction) keeps the same state.
      if (!changed) return prev;
      const draft = { ...prev.draft, widgets };
      // The grid settling after another change belongs to that change.
      return source === 'settle' ? { ...prev, draft } : record(prev, draft);
    });
  }, []);

  const upsertWidget = useCallback((widget: DraftWidget, preview?: MetricResult | null) => {
    setState((prev) => {
      if (!prev.draft) return prev;
      const index = prev.draft.widgets.findIndex((w) => w.clientId === widget.clientId);
      const widgets =
        index === -1 ? [...prev.draft.widgets, widget] : prev.draft.widgets.map((w, i) => (i === index ? widget : w));
      // The stored result no longer matches the widget: its preview, or nothing.
      return record(prev, { ...prev.draft, widgets }, { ...prev.previews, [widget.clientId]: preview ?? null });
    });
  }, []);

  const removeWidget = useCallback((clientId: string) => {
    setState((prev) => {
      if (!prev.draft || !prev.draft.widgets.some((w) => w.clientId === clientId)) return prev;
      // Its preview stays, for an undo.
      return record(prev, { ...prev.draft, widgets: prev.draft.widgets.filter((w) => w.clientId !== clientId) });
    });
  }, []);

  const undo = useCallback(() => {
    setState((prev) => {
      const target = prev.past[prev.past.length - 1];
      if (!prev.draft || !target) return prev;
      return {
        ...target,
        past: prev.past.slice(0, -1),
        future: [...prev.future, { draft: prev.draft, previews: prev.previews }],
        run: null,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((prev) => {
      const target = prev.future[prev.future.length - 1];
      if (!prev.draft || !target) return prev;
      return {
        ...target,
        past: [...prev.past, { draft: prev.draft, previews: prev.previews }],
        future: prev.future.slice(0, -1),
        run: null,
      };
    });
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
      // The inline fields keep what is typed; the save sends it trimmed.
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      ...(draft.id === undefined ? { visibility: draft.visibility, ...savedTargets(draft) } : {}),
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
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
