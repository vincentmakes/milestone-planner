/**
 * workStore: one refresh loads my requests and the requests to decide
 * (shared while in flight, a failing list keeps its last value, a reset
 * mid-flight drops the result); openCount is the requests to decide,
 * recomputed by every setter; decisions apply locally; tab and filters are
 * view state forgotten by reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWorkStore } from '../workStore';
import { useAppStore } from '../appStore';
import { approvalsApi } from '@/api/endpoints/approvals';
import { makeApprovalRequest, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { getMine: vi.fn(), getToDecide: vi.fn() },
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
