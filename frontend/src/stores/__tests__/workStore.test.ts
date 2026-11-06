/**
 * workStore: one refresh loads my requests and the requests to decide
 * (shared while in flight, a failing list keeps its last value, a reset
 * mid-flight drops the result); openCount is the requests to decide,
 * recomputed by every setter; decisions apply locally; tab and filters are
 * view state forgotten by reset. The History: page 1, Load more after the
 * last row (deduped), filters as params, stale answers dropped, the reload
 * hint only once a page was loaded (empty included).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWorkStore } from '../workStore';
import { useAppStore } from '../appStore';
import { approvalsApi } from '@/api/endpoints/approvals';
import { makeApprovalRequest, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { getMine: vi.fn(), getToDecide: vi.fn(), listHistory: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useWorkStore.getState().reset();
  useAppStore.setState({ currentUser: makeUser({ id: 4 }) });
  vi.mocked(approvalsApi.getMine).mockResolvedValue([makeApprovalRequest({ id: 40 })]);
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([makeApprovalRequest({ requester_id: 7, can_decide: true })]);
});

describe('refresh', () => {
  it('loads both lists', async () => {
    await useWorkStore.getState().refresh();
    const s = useWorkStore.getState();
    expect(s.mine.map((r) => r.id)).toEqual([40]);
    expect(s.toDecide.map((r) => r.id)).toEqual([31]);
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.openCount).toBe(1);
  });

  it('shares one request while a refresh is in flight', async () => {
    await Promise.all([useWorkStore.getState().refresh(), useWorkStore.getState().refresh()]);
    expect(approvalsApi.getMine).toHaveBeenCalledTimes(1);
    expect(approvalsApi.getToDecide).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a signed-in user', async () => {
    useAppStore.setState({ currentUser: null });
    await useWorkStore.getState().refresh();
    expect(approvalsApi.getMine).not.toHaveBeenCalled();
  });

  it('keeps the last value of a list that failed, logs it and reports it in loadError', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await useWorkStore.getState().refresh();
    expect(useWorkStore.getState().loadError).toBeNull();
    vi.mocked(approvalsApi.getToDecide).mockRejectedValueOnce(new Error('500'));
    vi.mocked(approvalsApi.getMine).mockResolvedValueOnce([]);
    await useWorkStore.getState().refresh();
    expect(useWorkStore.getState().toDecide).toHaveLength(1);
    expect(useWorkStore.getState().mine).toEqual([]);
    expect(useWorkStore.getState().loadError).toBe(
      'Some of your requests could not be loaded. They will reload on the next change.'
    );
    expect(error).toHaveBeenCalledWith('[Work] Failed to load', expect.any(Error));

    // A good refresh clears it.
    await useWorkStore.getState().refresh();
    expect(useWorkStore.getState().loadError).toBeNull();
    error.mockRestore();
  });

  it('says so when nothing could be loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(approvalsApi.getMine).mockRejectedValueOnce(new Error('500'));
    vi.mocked(approvalsApi.getToDecide).mockRejectedValueOnce(new Error('500'));
    await useWorkStore.getState().refresh();
    expect(useWorkStore.getState().loadError).toBe(
      'Your requests could not be loaded. They will reload on the next change.'
    );
    expect(useWorkStore.getState().loaded).toBe(true);
    error.mockRestore();
  });

  it('drops a result that lands after a reset (sign-out)', async () => {
    const pending = useWorkStore.getState().refresh();
    useWorkStore.getState().reset();
    await pending;
    expect(useWorkStore.getState().mine).toEqual([]);
    expect(useWorkStore.getState().loaded).toBe(false);
  });
});

describe('openCount', () => {
  it('counts the requests to decide', () => {
    useWorkStore.getState().setToDecide([makeApprovalRequest(), makeApprovalRequest({ id: 32 })]);
    expect(useWorkStore.getState().openCount).toBe(2);
    useWorkStore.getState().setMine([makeApprovalRequest({ id: 40 })]);
    expect(useWorkStore.getState().openCount).toBe(2);
  });
});

describe('local decisions', () => {
  it('applies a decision: leaves "to decide", updates my request', () => {
    useWorkStore.getState().setToDecide([makeApprovalRequest({ id: 31 })]);
    useWorkStore.getState().setMine([makeApprovalRequest({ id: 31 }), makeApprovalRequest({ id: 40 })]);
    useWorkStore.getState().applyDecisionLocal(31, 'cancelled');
    const s = useWorkStore.getState();
    expect(s.toDecide).toEqual([]);
    expect(s.mine.map((r) => [r.id, r.status])).toEqual([
      [31, 'cancelled'],
      [40, 'pending'],
    ]);
    expect(s.openCount).toBe(0);
  });

  it('applies a decision of unknown outcome by removing it from "to decide" only', () => {
    useWorkStore.getState().setToDecide([makeApprovalRequest({ id: 31 })]);
    useWorkStore.getState().setMine([makeApprovalRequest({ id: 31 })]);
    useWorkStore.getState().applyDecisionLocal(31);
    expect(useWorkStore.getState().toDecide).toEqual([]);
    expect(useWorkStore.getState().mine[0].status).toBe('pending');
  });
});

describe('view state and reset', () => {
  it('opens on My Assignments, switches tab and filters, and reset forgets everything', () => {
    expect(useWorkStore.getState().activeTab).toBe('assignments');
    useWorkStore.getState().setActiveTab('requests');
    useWorkStore.getState().setRequestsFilter('done');
    useWorkStore.getState().setAssignmentsFilter('all');
    useWorkStore.getState().setToDecide([makeApprovalRequest()]);
    expect(useWorkStore.getState()).toMatchObject({
      activeTab: 'requests',
      requestsFilter: 'done',
      assignmentsFilter: 'all',
    });
    useWorkStore.getState().reset();
    const s = useWorkStore.getState();
    expect(s.activeTab).toBe('assignments');
    expect(s.requestsFilter).toBe('open');
    expect(s.assignmentsFilter).toBe('upcoming');
    expect(s.toDecide).toEqual([]);
    expect(s.openCount).toBe(0);
    expect(s.loadError).toBeNull();
  });
});

describe('history', () => {
  const page = (ids: number[]) => ids.map((id) => makeApprovalRequest({ id, status: 'approved' }));
  const fullPage = (from: number) => page(Array.from({ length: 50 }, (_, i) => from - i));
  const history = () => useWorkStore.getState().history;
  const lastParams = () => vi.mocked(approvalsApi.listHistory).mock.lastCall?.[0];

  it('loads page 1 of my decisions; a full page has more', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(fullPage(100));
    await useWorkStore.getState().loadHistory();
    expect(lastParams()).toEqual({
      scope: 'decided',
      closed: undefined,
      status: undefined,
      project_id: undefined,
      requester_id: undefined,
      decided_by: undefined,
      before_id: undefined,
      limit: 50,
    });
    expect(history()).toMatchObject({ hasMore: true, loading: false, loaded: true, error: null });
    expect(history().rows).toHaveLength(50);

    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(page([3, 2]));
    await useWorkStore.getState().loadHistory();
    expect(history().rows.map((r) => r.id)).toEqual([3, 2]);
    expect(history().hasMore).toBe(false);
  });

  it('loads more after the last row held and drops the ids already held', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(fullPage(100));
    await useWorkStore.getState().loadHistory();
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(page([51, 50, 49]));
    await useWorkStore.getState().loadMoreHistory();
    expect(lastParams()?.before_id).toBe(51);
    const ids = history().rows.map((r) => r.id);
    expect(ids).toHaveLength(52);
    expect(ids.slice(-3)).toEqual([51, 50, 49]);
    expect(history().hasMore).toBe(false);
  });

  it('sends the filters; All requests adds closed and the decider', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValue([]);
    await useWorkStore
      .getState()
      .setHistoryFilters({ scope: 'all', outcome: 'expired', projectId: 2, requesterId: 7, decidedBy: 9 });
    expect(lastParams()).toMatchObject({
      scope: 'all',
      closed: true,
      status: 'expired',
      project_id: 2,
      requester_id: 7,
      decided_by: 9,
    });
    // Back to my decisions: the All-mode outcome and the decider go.
    await useWorkStore.getState().setHistoryFilters({ scope: 'decided' });
    expect(history().filters).toEqual({
      scope: 'decided',
      outcome: 'all',
      projectId: 2,
      requesterId: 7,
      decidedBy: null,
    });
    expect(lastParams()).toMatchObject({ scope: 'decided', closed: undefined, status: undefined, decided_by: undefined });
  });

  it('keeps an outcome both modes offer when switching back', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValue([]);
    await useWorkStore.getState().setHistoryFilters({ scope: 'all', outcome: 'rejected' });
    await useWorkStore.getState().setHistoryFilters({ scope: 'decided' });
    expect(history().filters.outcome).toBe('rejected');
  });

  it('drops an answer overtaken by a newer load', async () => {
    let answerOld: (rows: ReturnType<typeof page>) => void = () => {};
    vi.mocked(approvalsApi.listHistory)
      .mockReturnValueOnce(new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce(page([9]));
    const old = useWorkStore.getState().loadHistory();
    await useWorkStore.getState().setHistoryFilters({ outcome: 'rejected' });
    answerOld(page([1, 2]));
    await old;
    expect(history().rows.map((r) => r.id)).toEqual([9]);
    expect(history().loading).toBe(false);
  });

  it('drops a failure overtaken by a newer load', async () => {
    let failOld: (err: Error) => void = () => {};
    vi.mocked(approvalsApi.listHistory)
      .mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)))
      .mockResolvedValueOnce(page([9]));
    const old = useWorkStore.getState().loadHistory();
    await useWorkStore.getState().loadHistory();
    failOld(new Error('late'));
    await old;
    expect(history().error).toBeNull();
    expect(history().rows.map((r) => r.id)).toEqual([9]);
  });

  it('reports a failed page 1 in place and clears the rows; a failed Load more keeps them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(fullPage(100));
    await useWorkStore.getState().loadHistory();
    vi.mocked(approvalsApi.listHistory).mockRejectedValueOnce(new Error('500'));
    await useWorkStore.getState().loadMoreHistory();
    expect(history().rows).toHaveLength(50);
    expect(history().error).toBe('The history could not be loaded. Try again later.');

    vi.mocked(approvalsApi.listHistory).mockRejectedValueOnce(new Error('500'));
    await useWorkStore.getState().loadHistory();
    expect(history()).toMatchObject({ rows: [], hasMore: false, loading: false, loaded: true });
    expect(error).toHaveBeenCalledWith('[Work] Failed to load the history', expect.any(Error));
  });

  it('reloads page 1 on a hint only once a page was loaded', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValue(page([5]));
    await useWorkStore.getState().reloadHistoryIfHeld();
    expect(approvalsApi.listHistory).not.toHaveBeenCalled();

    await useWorkStore.getState().loadHistory();
    vi.mocked(approvalsApi.listHistory).mockResolvedValue(page([6, 5]));
    await useWorkStore.getState().reloadHistoryIfHeld();
    expect(approvalsApi.listHistory).toHaveBeenCalledTimes(2);
    expect(lastParams()?.before_id).toBeUndefined();
    expect(history().rows.map((r) => r.id)).toEqual([6, 5]);
  });

  it('reloads an open History that is empty when a decision lands', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce([]);
    await useWorkStore.getState().loadHistory();
    expect(history()).toMatchObject({ rows: [], loaded: true });

    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(page([8]));
    await useWorkStore.getState().reloadHistoryIfHeld();
    expect(approvalsApi.listHistory).toHaveBeenCalledTimes(2);
    expect(history().rows.map((r) => r.id)).toEqual([8]);
  });

  it('drops a Load more overtaken by a page-1 reload, whichever answer lands first', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(fullPage(100));
    await useWorkStore.getState().loadHistory();

    // Load more lands last: its stale tail must not be appended to the reload.
    let answerMore: (rows: ReturnType<typeof page>) => void = () => {};
    vi.mocked(approvalsApi.listHistory)
      .mockReturnValueOnce(new Promise((resolve) => (answerMore = resolve)))
      .mockResolvedValueOnce(page([6, 5]));
    const more = useWorkStore.getState().loadMoreHistory();
    await useWorkStore.getState().reloadHistoryIfHeld();
    answerMore(page([50, 49]));
    await more;
    expect(history().rows.map((r) => r.id)).toEqual([6, 5]);
    expect(history()).toMatchObject({ hasMore: false, loading: false });

    // Load more lands first (while the reload is in flight): dropped all the same.
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(fullPage(100));
    await useWorkStore.getState().loadHistory();
    let answerReload: (rows: ReturnType<typeof page>) => void = () => {};
    vi.mocked(approvalsApi.listHistory)
      .mockResolvedValueOnce(page([50, 49]))
      .mockReturnValueOnce(new Promise((resolve) => (answerReload = resolve)));
    const more2 = useWorkStore.getState().loadMoreHistory();
    const reload = useWorkStore.getState().loadHistory();
    await more2;
    answerReload(page([7]));
    await reload;
    expect(history().rows.map((r) => r.id)).toEqual([7]);
    expect(history().loading).toBe(false);
  });

  it('is cleared by reset, and an answer that lands after it is dropped', async () => {
    let answer: (rows: ReturnType<typeof page>) => void = () => {};
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(page([5]));
    await useWorkStore.getState().setHistoryFilters({ projectId: 3 });
    vi.mocked(approvalsApi.listHistory).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const late = useWorkStore.getState().loadHistory();
    useWorkStore.getState().reset();
    answer(page([7]));
    await late;
    expect(history()).toEqual({
      rows: [],
      hasMore: false,
      loading: false,
      loaded: false,
      error: null,
      filters: { scope: 'decided', outcome: 'all', projectId: null, requesterId: null, decidedBy: null },
    });
  });
});
