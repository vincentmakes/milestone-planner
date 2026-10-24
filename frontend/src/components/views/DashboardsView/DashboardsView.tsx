/**
 * DashboardsView — the dashboards shared with the user (2.1.0), and their
 * builder.
 *
 * The toolbar picks a dashboard (`SearchableSelect`; the hint says where it
 * comes from: *Default*, *Mine*, *Everyone*, *Shared by <owner>* or *Shared
 * with no one left*, and the list is ordered in those groups) and refreshes its
 * data. Holders of `dashboards.manage` on screens wider than a phone, outside
 * What-If, also get the builder's actions in the `builder-actions` slot:
 * **New** (the dashboard dialog, then an empty draft — nothing is sent until
 * Save), **Duplicate** ("Copy of …", opened in edit mode), and on a
 * dashboard they may edit **Edit**, **Share…** (the sharing dialog, saving
 * without the widgets) and **Delete** (the default dashboard: admins only).
 * Edit mode (`useDashboardEditor`) turns the row into **Add widget** /
 * **Save** / **Cancel**, the description line into the dashboard's **Name**
 * and **Description** fields (Save asks for a name first, sending nothing),
 * and the grid into a draggable one whose widget headers carry Edit and
 * Remove; switching dashboard or leaving the view with unsaved changes asks
 * first. Below the toolbar: the description, whom the dashboard is shared
 * with (`SharedWithLine`), an error `Notice`, the empty state, and the
 * widget grid.
 *
 * On mount the list loads and the initial dashboard opens (the last one
 * opened in this tenant, else the default, else the first); window focus
 * reloads the data, and leaving the view drops a pending live reload. Below
 * 640 px the grid is view-only. Lazy-loaded by MainLayout (ECharts and the
 * grid stay in this chunk) inside an error boundary.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useHasPermission } from '@/hooks/useCan';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import type { SearchableOption } from '@/components/common/SearchableSelect';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import {
  Icon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  PlusIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from '@/components/common/Icon';
import { confirmAction } from '@/utils/confirmDialog';
import type { Dashboard, DashboardSummary, MetricResult, SharedWith } from '@/types';
import { DashboardGrid } from './DashboardGrid';
import { NO_TARGET_TEXT, SharedWithLine } from './SharedWithLine';
import { sharedWithNoOne } from './sharing';
import { DashboardDialog } from './builder/DashboardDialog';
import { WidgetEditor } from './builder/WidgetEditor';
import { plainError, useDashboardEditor } from './builder/useDashboardEditor';
import { copyTargets, MAX_WIDGETS } from './builder/widgetDraft';
import type { DashboardMeta, DraftWidget } from './builder/widgetDraft';
import styles from './DashboardsView.module.css';

export const EMPTY_TEXT = 'No dashboard is shared with you yet.';
export const DELETED_TEXT = 'Dashboard deleted';
export const FIRST_WIDGET_TEXT = 'Add your first widget.';
export const NAME_REQUIRED_TEXT = 'Enter a name';
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

/** The phone breakpoint of UI_GUIDELINES §2.12. */
export const PHONE_QUERY = '(max-width: 640px)';

function readIsPhone(): boolean {
  // jsdom has no matchMedia: the wide layout, like useHeaderDensity.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/** Whether the screen is phone-sized (≤ 640 px), following resizes. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(readIsPhone);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/** Where a dashboard comes from, and its group rank in the picker. */
function origin(dashboard: DashboardSummary, userId: number | null): { hint: string; rank: number } {
  if (dashboard.is_default) return { hint: 'Default', rank: 0 };
  const mine = userId !== null && dashboard.owner_id === userId;
  if (sharedWithNoOne(dashboard)) return { hint: NO_TARGET_TEXT, rank: mine ? 1 : 2 };
  if (mine) return { hint: 'Mine', rank: 1 };
  if (dashboard.visibility === 'everyone') return { hint: 'Everyone', rank: 3 };
  return { hint: dashboard.owner_name ? `Shared by ${dashboard.owner_name}` : 'Shared with me', rank: 2 };
}

const metaOf = (d: Dashboard): DashboardMeta => ({
  name: d.name,
  description: d.description,
  visibility: d.visibility,
  ...copyTargets(d),
});

const NEW_META: DashboardMeta = {
  name: '',
  description: null,
  visibility: 'private',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
};

export function DashboardsView() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const current = useDashboardStore((s) => s.current);
  const data = useDashboardStore((s) => s.data);
  const loading = useDashboardStore((s) => s.loading);
  const dataLoading = useDashboardStore((s) => s.dataLoading);
  const loadError = useDashboardStore((s) => s.loadError);
  const listLoaded = useDashboardStore((s) => s.listLoaded);
  const userId = useAppStore((s) => s.currentUser?.id ?? null);
  const canManage = useHasPermission('dashboards.manage');
  // `roles.manage` is locked to the admin role: the one admin check by key.
  const isAdmin = useHasPermission('roles.manage');
  const { blocked: whatIfActive } = useWhatIfBlocked();
  const phone = useIsPhone();

  const editor = useDashboardEditor(current);
  const [dialog, setDialog] = useState<'new' | 'share' | null>(null);
  // The widget editor: open on a widget (null = a new one)
  const [widgetTarget, setWidgetTarget] = useState<{ widget: DraftWidget | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // A new draft's targets with their names (the dialog's; the server resolves them on save)
  const [newSharedWith, setNewSharedWith] = useState<SharedWith | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { isSubmitting: acting, guard } = useSubmitGuard();

  // The builder's controls: the key, a wide screen, and never in What-If.
  const builder = canManage && !phone && !whatIfActive;

  // The list, then the initial dashboard (or the open one's fresh data).
  useEffect(() => {
    let cancelled = false;
    const store = useDashboardStore.getState();
    void store.refreshList().then(() => {
      if (cancelled) return;
      const state = useDashboardStore.getState();
      const open = state.current;
      if (open && state.dashboards.some((d) => d.id === open.id)) {
        void state.reloadData(true);
        return;
      }
      const initial = state.pickInitial();
      if (initial !== null) void state.open(initial);
    });
    return () => {
      cancelled = true;
      useDashboardStore.getState().cancelPendingReload();
    };
  }, []);

  // Back to the tab: fresh numbers (live pushes may have been missed).
  useEffect(() => {
    const onFocus = () => {
      const store = useDashboardStore.getState();
      void store.refreshList();
      void store.reloadData(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const options = useMemo<SearchableOption[]>(() => {
    return dashboards
      .map((dashboard) => ({ dashboard, ...origin(dashboard, userId) }))
      .sort((a, b) => a.rank - b.rank || a.dashboard.name.localeCompare(b.dashboard.name))
      .map(({ dashboard, hint }) => ({ id: dashboard.id, label: dashboard.name, hint }));
  }, [dashboards, userId]);

  const empty = listLoaded && dashboards.length === 0;
  const draft = editor.draft;

  // --- Actions ---------------------------------------------------------------
  const switchTo = async (id: number | null) => {
    if (id === null) return;
    if (editor.editing) {
      // Never open another dashboard under the draft.
      if (!(await editor.confirmDiscard())) return;
      editor.discard();
    }
    void useDashboardStore.getState().open(id);
  };

  const duplicate = () =>
    guard(async () => {
      if (!current) return;
      setActionError(null);
      try {
        const name = `Copy of ${current.name}`.slice(0, NAME_MAX);
        const copy = await useDashboardStore.getState().duplicate(current.id, name);
        setNameError(null);
        editor.startEdit(copy);
      } catch (err) {
        console.error('[Dashboards] Failed to duplicate a dashboard', err);
        setActionError(plainError(err, 'The dashboard could not be duplicated.'));
      }
    });

  const remove = async () => {
    if (!current) return;
    const ok = await confirmAction({
      message: `Delete dashboard "${current.name}"? Its widgets are deleted with it. This cannot be undone.`,
      destructive: true,
    });
    if (!ok) return;
    await guard(async () => {
      setActionError(null);
      try {
        await useDashboardStore.getState().remove(current.id);
        useUIStore.getState().showFlash(DELETED_TEXT, 'info');
      } catch (err) {
        console.error('[Dashboards] Failed to delete a dashboard', err);
        setActionError(plainError(err, 'The dashboard could not be deleted.'));
      }
    });
  };

  // Save asks for a name first: nothing is sent without one.
  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setNameError(NAME_REQUIRED_TEXT);
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    void editor.save();
  };

  const saveWidget = (widget: DraftWidget, preview: MetricResult | null) => {
    editor.upsertWidget(widget, preview);
    setWidgetTarget(null);
  };

  // --- Toolbar ---------------------------------------------------------------
  const full = (draft?.widgets.length ?? 0) >= MAX_WIDGETS;
  const addWidgetButton = (label: string, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button
      variant={variant}
      icon={<Icon icon={PlusIcon} />}
      onClick={() => setWidgetTarget({ widget: null })}
      disabled={full || editor.saving}
      title={full ? `A dashboard holds at most ${MAX_WIDGETS} widgets` : undefined}
    >
      {label}
    </Button>
  );

  let builderActions: ReactNode = null;
  if (editor.editing) {
    // Kept while editing even if the screen narrows, so the draft is never stranded.
    builderActions = (
      <>
        {addWidgetButton('Add widget')}
        <Button onClick={saveDraft} loading={editor.saving}>
          Save
        </Button>
        <Button
          variant="secondary"
          icon={<Icon icon={CloseIcon} />}
          onClick={() => void editor.cancel()}
          disabled={editor.saving}
        >
          Cancel
        </Button>
      </>
    );
  } else if (builder) {
    const canEdit = Boolean(current?.can_edit);
    const canDelete = canEdit && (!current?.is_default || isAdmin);
    builderActions = (
      <>
        <Button icon={<Icon icon={PlusIcon} />} onClick={() => setDialog('new')} disabled={acting}>
          New
        </Button>
        {current && (
          <Button
            variant="secondary"
            icon={<Icon icon={CopyIcon} />}
            onClick={() => void duplicate()}
            loading={acting}
          >
            Duplicate
          </Button>
        )}
        {current && canEdit && (
          <Button
            variant="secondary"
            icon={<Icon icon={EditIcon} />}
            onClick={() => {
              setNameError(null);
              editor.startEdit();
            }}
            disabled={acting}
          >
            Edit
          </Button>
        )}
        {current && canEdit && (
          <Button
            variant="secondary"
            icon={<Icon icon={ShareIcon} />}
            onClick={() => setDialog('share')}
            disabled={acting}
          >
            Share…
          </Button>
        )}
        {current && canDelete && (
          <Button
            variant="secondary"
            icon={<Icon icon={TrashIcon} />}
            onClick={() => void remove()}
            disabled={acting}
          >
            Delete
          </Button>
        )}
      </>
    );
  }

  const newDraft = draft !== null && draft.id === undefined;

  // Whom the shown dashboard is shared with: a new draft's from the dialog,
  // an open one's from the server (edit mode never changes the sharing).
  const sharing =
    draft && newDraft
      ? newSharedWith && { visibility: draft.visibility, owner_id: userId, shared_with: newSharedWith }
      : current;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.left}>
          <SearchableSelect
            aria-label="Dashboard"
            className={styles.picker}
            options={options}
            value={newDraft ? null : current?.id ?? null}
            onChange={(id) => void switchTo(id)}
            placeholder={newDraft ? draft.name : empty ? 'No dashboard' : 'Choose a dashboard'}
            disabled={options.length === 0}
            searchLabel="Find a dashboard"
            searchPlaceholder="Type to find a dashboard…"
            noMatchText="No dashboard matches"
            emptyText="No dashboard"
          />
          {editor.editing && (
            <span className={styles.editing} role="status">
              {editor.dirty ? 'Editing — unsaved changes' : 'Editing'}
            </span>
          )}
        </div>
        <div className={styles.right}>
          {!editor.editing && (
            <Button
              variant="ghost"
              icon={<Icon icon={RefreshIcon} />}
              onClick={() => void useDashboardStore.getState().reloadData(true)}
              loading={dataLoading}
              disabled={!current}
            >
              Refresh
            </Button>
          )}
          {(builder || editor.editing) && (
            <div data-slot="builder-actions" className={styles.builderActions}>
              {builderActions}
            </div>
          )}
        </div>
      </div>

      <div className={styles.content}>
        {draft ? (
          <div className={styles.metaFields}>
            <Input
              ref={nameRef}
              label="Name *"
              fullWidth
              value={draft.name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                editor.setMeta({ name: e.target.value });
                if (nameError) setNameError(null);
              }}
              aria-invalid={nameError ? true : undefined}
            />
            <Input
              label="Description"
              fullWidth
              value={draft.description ?? ''}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => editor.setMeta({ description: e.target.value === '' ? null : e.target.value })}
              placeholder="Optional description"
            />
          </div>
        ) : (
          current?.description && <p className={styles.description}>{current.description}</p>
        )}
        {sharing && (
          <div className={styles.sharedWith}>
            <SharedWithLine dashboard={sharing} userId={userId} />
          </div>
        )}
        {draft && nameError && <Notice tone="error">{nameError}</Notice>}
        {editor.error && <Notice tone="error">{editor.error}</Notice>}
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {loadError && <Notice tone="error">{loadError}</Notice>}

        {editor.editing ? (
          editor.gridWidgets.length === 0 ? (
            <div className={styles.firstWidget}>
              <p className={styles.empty}>{FIRST_WIDGET_TEXT}</p>
              {addWidgetButton('Add widget', 'primary')}
            </div>
          ) : (
            <DashboardGrid
              widgets={editor.gridWidgets}
              data={editor.gridData}
              dataLoading={dataLoading}
              editing
              onLayoutChange={editor.setLayouts}
              onEditWidget={(id) => setWidgetTarget({ widget: editor.widgetByGridId(id) ?? null })}
              onRemoveWidget={(id) => {
                const widget = editor.widgetByGridId(id);
                if (widget) editor.removeWidget(widget.clientId);
              }}
            />
          )
        ) : (
          <>
            {empty && <p className={styles.empty}>{EMPTY_TEXT}</p>}
            {!current && loading && (
              <p className={styles.empty} role="status">
                Loading…
              </p>
            )}
            {current && current.widgets.length === 0 && (
              <p className={styles.empty}>This dashboard has no widgets yet.</p>
            )}
            {current && current.widgets.length > 0 && (
              <DashboardGrid widgets={current.widgets} data={data} dataLoading={dataLoading} editing={false} />
            )}
          </>
        )}
      </div>

      {dialog === 'new' && (
        <DashboardDialog
          mode="new"
          initial={NEW_META}
          onClose={() => setDialog(null)}
          onDone={(meta, sharedWith) => {
            setDialog(null);
            setNewSharedWith(sharedWith);
            setNameError(null);
            editor.startNew(meta);
          }}
        />
      )}
      {dialog === 'share' && current && (
        <DashboardDialog
          mode="share"
          initial={metaOf(current)}
          sharedWith={current.shared_with}
          dashboardId={current.id}
          onClose={() => setDialog(null)}
          onDone={() => setDialog(null)}
        />
      )}
      {widgetTarget && draft && (
        <WidgetEditor
          widget={widgetTarget.widget}
          widgets={draft.widgets}
          onClose={() => setWidgetTarget(null)}
          onSave={saveWidget}
        />
      )}
    </div>
  );
}
