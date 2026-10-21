/**
 * My Todos — the signed-in user's work that is not a card: approval requests
 * to decide, tasks (assigned to or created by them) and their own requests.
 *
 * Three tabs (`role="tablist"`, arrow keys move between them) with their
 * open counts, an Open/Done filter for tasks and requests, and New task
 * (hidden while What-If is active: the view cannot be reached then anyway,
 * view switching is blocked, but a sandbox opened elsewhere must not create
 * here). Data lives in todoStore: loaded on mount and window focus, and kept
 * live by the `todo:changed` / `approval:changed` pushes and the `todos` /
 * `approvals` WebSocket slices. A decision or a cancel also reloads the
 * projects, whose booking rows carry the pending state.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { PlusIcon } from '@/components/settings/panels/PanelIcons';
import { useTodoStore } from '@/stores/todoStore';
import type { TodoTab } from '@/stores/todoStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useHasPermission } from '@/hooks/useCan';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { approvalsApi } from '@/api/endpoints/approvals';
import { todosApi } from '@/api/endpoints/todos';
import { collectCardsForProjects } from '@/utils/kanbanCards';
import { formatDateISO } from '@/utils/date';
import { ApprovalRequestRow, MyRequestRow } from './ApprovalRequestRow';
import { TodoList } from './TodoList';
import { TodoDialog } from './TodoDialog';
import type { ApprovalRequest, TodoTask } from '@/types';
import styles from './TodosView.module.css';

const TABS: ReadonlyArray<{ id: TodoTab; label: string }> = [
  { id: 'decide', label: 'To decide' },
  { id: 'tasks', label: 'My tasks' },
  { id: 'requests', label: 'My requests' },
];

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function TodosView() {
  const tasks = useTodoStore((s) => s.tasks);
  const mine = useTodoStore((s) => s.mine);
  const toDecide = useTodoStore((s) => s.toDecide);
  const loaded = useTodoStore((s) => s.loaded);
  const activeTab = useTodoStore((s) => s.activeTab);
  const statusFilter = useTodoStore((s) => s.statusFilter);
  const setActiveTab = useTodoStore((s) => s.setActiveTab);
  const setStatusFilter = useTodoStore((s) => s.setStatusFilter);
  const refresh = useTodoStore((s) => s.refresh);
  const currentUserId = useAppStore((s) => s.currentUser?.id ?? null);
  const projects = useAppStore((s) => s.projects);
  const { refreshProjects } = useDataLoader();

  const whatIf = useWhatIfBlocked();
  const canOwn = useHasPermission('todos.manage_own');
  const canAssign = useHasPermission('todos.assign_others');
  const canCreate = (canOwn || canAssign) && !whatIf.blocked;

  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const [dialog, setDialog] = useState<{ task: TodoTask | null } | null>(null);
  const tabRefs = useRef<Partial<Record<TodoTab, HTMLButtonElement | null>>>({});
  const baseId = useId();

  // Load on mount and on focus; the pushes are hints (per-process manager).
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const cardNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const card of collectCardsForProjects(projects)) {
      names.set(`${card.entityType}:${card.entityId}`, card.name);
    }
    return names;
  }, [projects]);

  const today = formatDateISO(new Date());
  const showDone = statusFilter === 'done';
  const openTasks = useMemo(() => tasks.filter((t) => t.status === 'open'), [tasks]);
  const closedTasks = useMemo(() => tasks.filter((t) => t.status !== 'open'), [tasks]);
  const pendingMine = useMemo(() => mine.filter((r) => r.status === 'pending'), [mine]);
  const closedMine = useMemo(() => mine.filter((r) => r.status !== 'pending'), [mine]);

  const counts: Record<TodoTab, number> = {
    decide: toDecide.length,
    tasks: openTasks.length,
    requests: pendingMine.length,
  };

  const selectTab = (tab: TodoTab) => {
    setActiveTab(tab);
    setError(null);
    tabRefs.current[tab]?.focus();
  };

  const handleTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === activeTab);
    const next: Record<string, number> = {
      ArrowRight: (index + 1) % TABS.length,
      ArrowLeft: (index - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    selectTab(TABS[next[e.key]].id);
  };

  const handleDecided = useCallback(
    async (request: ApprovalRequest) => {
      // No setError(null): after a 409 ApprovalActions reports the error first,
      // then calls this to show the request's real fate.
      useTodoStore.getState().applyDecisionLocal(request.id);
      await refreshProjects();
      void refresh();
    },
    [refresh, refreshProjects]
  );

  const handleCancel = useCallback(
    async (request: ApprovalRequest) => {
      setError(null);
      try {
        await approvalsApi.cancel(request.id);
        useTodoStore.getState().applyDecisionLocal(request.id, 'cancelled');
        await refreshProjects();
      } catch (err) {
        setError(message(err, 'Could not cancel the request'));
        void refresh();
      }
    },
    [refresh, refreshProjects]
  );

  const handleToggleDone = useCallback(async (task: TodoTask, done: boolean) => {
    const status = done ? 'done' : 'open';
    const store = useTodoStore.getState();
    setError(null);
    setBusyIds((ids) => new Set(ids).add(task.id));
    store.upsertTaskLocal({ ...task, status });
    try {
      const saved = await todosApi.update(task.id, { status });
      useTodoStore.getState().upsertTaskLocal(saved as TodoTask);
    } catch (err) {
      useTodoStore.getState().upsertTaskLocal(task);
      setError(message(err, 'Could not update the task'));
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(task.id);
        return next;
      });
    }
  }, []);

  const panelId = `${baseId}-panel`;
  const tabId = (tab: TodoTab) => `${baseId}-tab-${tab}`;

  const renderPanel = () => {
    if (!loaded) return <p className={styles.empty}>Loading…</p>;
    if (activeTab === 'decide') {
      if (toDecide.length === 0) return <p className={styles.empty}>No requests to decide</p>;
      return (
        <ul className={styles.list}>
          {toDecide.map((request) => (
            <ApprovalRequestRow key={request.id} request={request} onDecided={handleDecided} onError={setError} />
          ))}
        </ul>
      );
    }
    if (activeTab === 'tasks') {
      const shown = showDone ? closedTasks : openTasks;
      if (shown.length === 0) {
        return <p className={styles.empty}>{showDone ? 'No done tasks' : 'No open tasks'}</p>;
      }
      return (
        <TodoList
          tasks={shown}
          currentUserId={currentUserId}
          today={today}
          cardNames={cardNames}
          busyIds={busyIds}
          onToggleDone={(task, done) => void handleToggleDone(task, done)}
          onEdit={(task) => setDialog({ task })}
        />
      );
    }
    const shown = showDone ? closedMine : pendingMine;
    if (shown.length === 0) {
      return <p className={styles.empty}>{showDone ? 'No decided requests' : 'No pending requests'}</p>;
    }
    return (
      <ul className={styles.list}>
        {shown.map((request) => (
          <MyRequestRow key={request.id} request={request} onCancel={handleCancel} />
        ))}
      </ul>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="My Todos">
          {TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={`${styles.tab} ${selected ? styles.activeTab : ''}`}
                onClick={() => selectTab(tab.id)}
                onKeyDown={handleTabKey}
              >
                {tab.label}
                <span className={styles.tabCount}>{counts[tab.id]}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.toolbarRight}>
          {activeTab !== 'decide' && (
            <div className={styles.filter} role="group" aria-label="Show">
              {(['open', 'done'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`${styles.filterChip} ${statusFilter === value ? styles.activeChip : ''}`}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {value === 'open' ? 'Open' : 'Done'}
                </button>
              ))}
            </div>
          )}
          {canCreate && (
            <Button icon={<PlusIcon />} onClick={() => setDialog({ task: null })}>
              New task
            </Button>
          )}
        </div>
      </div>

      <div className={styles.body}>
        <div id={panelId} role="tabpanel" aria-labelledby={tabId(activeTab)} className={styles.panel}>
          {error && <Notice tone="error">{error}</Notice>}
          {renderPanel()}
        </div>
      </div>

      <TodoDialog isOpen={dialog !== null} task={dialog?.task ?? null} onClose={() => setDialog(null)} />
    </div>
  );
}
