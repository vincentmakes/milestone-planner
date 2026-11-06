/**
 * My Work: three tabs (My Approvals / My Assignments / My Requests) with
 * counts, decisions through the shared ApprovalActions (then the projects
 * reload), card links that open the Kanban card (not during What-If),
 * cancelling my own request, the Open/Done filter on My Requests, and My
 * Assignments: my approved bookings from the loaded projects, Upcoming / All,
 * Open = the booking dialog for that row. Loads on mount and focus.
 * History: closed requests I decided (or all of them with approvals.view_all),
 * outcome / project / person filters as request params, Load more with the
 * last row's id, empty and error states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkView } from '../WorkView';
import { MyAssignmentRow } from '../MyAssignmentRow';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from '@/stores/appStore';
import { useWorkStore } from '@/stores/workStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { addDaysToDateString, formatDateISO, formatMediumDate } from '@/utils/date';
import { makeApprovalRequest, makePhase, makeProject, makeSite, makeSubphase, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import { pickOption, pickerTrigger } from '@/test/searchableSelect';
import type { ApprovalRequest, StaffAssignment } from '@/types';

const refreshProjects = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects }),
}));
vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: {
    getMine: vi.fn(),
    getToDecide: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    listHistory: vi.fn(),
  },
}));

const toDecide = makeApprovalRequest({ id: 31, requester_id: 7, requester_name: 'Alice Smith', can_decide: true });
const myRequest = makeApprovalRequest({ id: 40, action: 'assignments.self_remove', assignment_id: 72 });
const decidedRequest = makeApprovalRequest({ id: 41, status: 'approved', decided_by_name: 'Carol' });

const today = formatDateISO(new Date());
const inDays = (n: number) => addDaysToDateString(today, n);

function booking(overrides: Partial<StaffAssignment>): StaffAssignment {
  return {
    id: 1,
    staff_id: 4,
    staff_name: 'Bob Brown',
    allocation: 40,
    start_date: inDays(1),
    end_date: inDays(5),
    approval_status: 'approved',
    approval: null,
    ...overrides,
  };
}

function seedProjects() {
  const subphase = makeSubphase({
    id: 20,
    name: 'Calibration',
    start_date: inDays(10),
    end_date: inDays(20),
    staffAssignments: [booking({ id: 200, linked: false, start_date: inDays(12), end_date: inDays(14), allocation: 60 })],
  });
  const phase = makePhase({
    id: 10,
    name: 'Feasibility',
    start_date: inDays(-30),
    end_date: inDays(-10),
    children: [subphase],
    // Past, linked
    staffAssignments: [booking({ id: 100, linked: true, start_date: inDays(-30), end_date: inDays(-10) })],
  });
  useAppStore.setState({
    sites: [makeSite({ id: 1, name: 'Basel' }), makeSite({ id: 2, name: 'Berlin' })],
    projects: [
      makeProject({
        id: 1,
        name: 'Bioprocess Scale-Up',
        site_id: 1,
        phases: [phase],
        staffAssignments: [booking({ id: 1, linked: false, start_date: today, end_date: today })],
      }),
      makeProject({
        id: 2,
        name: 'Trial',
        site_id: 2,
        // Pending: a request, listed under My Requests instead
        staffAssignments: [booking({ id: 2, approval_status: 'pending' })],
      }),
    ],
  });
}

function seedApi() {
  vi.mocked(approvalsApi.listHistory).mockResolvedValue([]);
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([toDecide]);
  vi.mocked(approvalsApi.getMine).mockResolvedValue([myRequest, decidedRequest]);
}

async function renderView() {
  const view = render(<WorkView />);
  await waitFor(() => expect(useWorkStore.getState().loaded).toBe(true));
  return view;
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  refreshProjects.mockResolvedValue(undefined);
  useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
  seedProjects();
  seedApi();
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('tabs', () => {
  it('shows the four tabs with their counts, My Assignments first', async () => {
    await renderView();
    expect(screen.getByRole('tablist', { name: 'My Work' })).toBeInTheDocument();
    // The count is in the name with a separator; the visual count is hidden.
    expect(screen.getByRole('tab', { name: 'My Approvals, 1 item' })).toHaveTextContent('1');
    // Upcoming bookings: today's project booking and the subphase segment.
    expect(screen.getByRole('tab', { name: 'My Assignments, 2 items' })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: 'My Requests, 1 item' })).toHaveTextContent('1');
    // Not loaded before the tab opens.
    expect(screen.getByRole('tab', { name: 'History, 0 items' })).toHaveTextContent('0');
    expect(tab(/^My Approvals/).querySelector('[aria-hidden="true"]')).toHaveTextContent('1');
    expect(useWorkStore.getState().openCount).toBe(1);
    expect(tab(/^My Assignments/)).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tab on click and with the arrow keys', async () => {
    await renderView();
    fireEvent.click(tab(/^My Approvals/));
    expect(useWorkStore.getState().activeTab).toBe('approvals');
    expect(screen.getByRole('tabpanel')).toHaveTextContent(
      'Alice Smith wants to join Feasibility of Bioprocess Scale-Up at 40%'
    );
    fireEvent.keyDown(tab(/^My Approvals/), { key: 'ArrowLeft' });
    expect(useWorkStore.getState().activeTab).toBe('history');
    fireEvent.keyDown(tab(/^History/), { key: 'ArrowRight' });
    expect(useWorkStore.getState().activeTab).toBe('approvals');
    fireEvent.keyDown(tab(/^My Approvals/), { key: 'End' });
    expect(useWorkStore.getState().activeTab).toBe('history');
    fireEvent.keyDown(tab(/^History/), { key: 'ArrowLeft' });
    expect(useWorkStore.getState().activeTab).toBe('requests');
    fireEvent.keyDown(tab(/^My Requests/), { key: 'Home' });
    expect(useWorkStore.getState().activeTab).toBe('approvals');
    fireEvent.keyDown(tab(/^My Approvals/), { key: 'x' });
    expect(useWorkStore.getState().activeTab).toBe('approvals');
  });

  it('reloads on window focus', async () => {
    await renderView();
    expect(approvalsApi.getMine).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(approvalsApi.getMine).toHaveBeenCalledTimes(2));
  });

  it('offers no task creation any more', async () => {
    await renderView();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });
});

describe('load errors', () => {
  it('says in place that the requests could not be loaded instead of an empty state', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(approvalsApi.getToDecide).mockRejectedValue(new Error('500'));
    vi.mocked(approvalsApi.getMine).mockRejectedValue(new Error('500'));
    useWorkStore.getState().setActiveTab('approvals');
    await renderView();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('alert')).toHaveTextContent('Your requests could not be loaded');
    expect(panel).not.toHaveTextContent('No requests to decide');
    // My Assignments does not depend on those lists.
    fireEvent.click(tab(/^My Assignments/));
    expect(within(screen.getByRole('tabpanel')).queryByRole('alert')).not.toBeInTheDocument();
    error.mockRestore();
  });

  it('keeps the list that did load next to the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(approvalsApi.getToDecide).mockRejectedValue(new Error('500'));
    useWorkStore.getState().setActiveTab('requests');
    await renderView();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('alert')).toHaveTextContent('Some of your requests could not be loaded');
    expect(panel).toHaveTextContent('Leave Feasibility of Bioprocess Scale-Up');
    fireEvent.click(tab(/^My Approvals/));
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('No requests to decide');
    error.mockRestore();
  });

  it('says it is loading the requests until the first load lands', () => {
    vi.mocked(approvalsApi.getToDecide).mockReturnValue(new Promise(() => {}));
    useWorkStore.getState().setActiveTab('approvals');
    render(<WorkView />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Loading…');
  });
});

describe('My Approvals', () => {
  beforeEach(() => useWorkStore.getState().setActiveTab('approvals'));

  it('approves through the API, drops the row and reloads the projects', async () => {
    vi.mocked(approvalsApi.approve).mockResolvedValueOnce({ success: true, id: 31, status: 'approved' });
    await renderView();
    vi.mocked(approvalsApi.getToDecide).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Alice Smith' }));
    await waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledWith(31));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(useWorkStore.getState().toDecide).toEqual([]);
  });

  it('rejects with a reason in the dialog', async () => {
    vi.mocked(approvalsApi.reject).mockResolvedValueOnce({ success: true, id: 31, status: 'rejected' });
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Reject Alice Smith' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Fully booked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith(31, 'Fully booked'));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
  });

  it('shows a failed decision in place', async () => {
    vi.mocked(approvalsApi.approve).mockRejectedValueOnce(new Error('offline'));
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Alice Smith' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });

  it('says when nothing awaits a decision, and shows no filter', async () => {
    vi.mocked(approvalsApi.getToDecide).mockResolvedValue([]);
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No requests to decide');
    expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
  });

  it('opens the card the request is about', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Open card Feasibility' }));
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
  });

  it('shows the card as plain text without views.kanban', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'viewer', permissions: ['projects.view'] }) });
    await renderView();
    expect(screen.queryByRole('button', { name: 'Open card Feasibility' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Feasibility');
  });

  it('disables card links during What-If', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'admin' }) });
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderView();
    const link = screen.getByRole('button', { name: 'Open card Feasibility' });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', whatIfUnavailableMessage('Opening a card'));
  });
});

describe('My Assignments', () => {
  it('lists my current and upcoming approved bookings, soonest first', async () => {
    await renderView();
    const items = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Today, the whole project, at Basel
    expect(items[0]).toHaveTextContent('Bioprocess Scale-Up · Basel');
    expect(items[0]).toHaveTextContent('Whole project');
    expect(items[0]).toHaveTextContent(formatMediumDate(today));
    expect(items[0]).toHaveTextContent('40%');
    // The subphase segment with its own dates, a card link, no pin
    expect(items[1]).toHaveTextContent('Calibration');
    expect(items[1]).toHaveTextContent(`${formatMediumDate(inDays(12))} – ${formatMediumDate(inDays(14))}`);
    expect(items[1]).toHaveTextContent('60%');
    expect(within(items[1]).queryByRole('img', { name: /Follows the/ })).not.toBeInTheDocument();
    expect(within(items[1]).getByRole('button', { name: 'Open card Calibration' })).toBeInTheDocument();
    // My pending booking on Trial is a request, not a booking
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('Trial');
  });

  it('shows the past bookings under All, a linked one with its pin', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(useWorkStore.getState().assignmentsFilter).toBe('all');
    const items = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Feasibility');
    // Feasibility has a subphase: a parent is no Kanban card, so no link.
    expect(within(items[0]).queryByRole('button', { name: /Open card/ })).not.toBeInTheDocument();
    expect(within(items[0]).getByRole('img', { name: 'Follows the phase dates' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upcoming' }));
    expect(within(screen.getByRole('tabpanel')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('links a card that comes without a children list (a leaf)', () => {
    const card = { ...makePhase({ id: 11, name: 'Scale-up' }), children: undefined } as never;
    render(
      <ul>
        <MyAssignmentRow
          row={{
            assignment: booking({ id: 300, phase_id: 11 }),
            project: makeProject({ id: 1 }),
            card,
            level: 'phase',
            start: inDays(1),
            end: inDays(5),
            linked: true,
          } as never}
          siteName={null}
        />
      </ul>
    );
    expect(screen.getByRole('button', { name: 'Open card Scale-up' })).toBeInTheDocument();
  });

  it('opens the booking dialog of a card booking with its context', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Open booking on Calibration of Bioprocess Scale-Up' }));
    const ui = useUIStore.getState();
    expect(ui.activeModal).toBe('staffAssignment');
    expect(ui.modalContext).toEqual({ projectId: 1, phaseId: 10, subphaseId: 20 });
    expect(ui.editingStaffAssignment).toEqual({
      id: 200,
      project_id: 1,
      phase_id: 10,
      subphase_id: 20,
      staff_id: 4,
      staff_name: 'Bob Brown',
      allocation: 60,
      start_date: inDays(12),
      end_date: inDays(14),
      linked: false,
    });
  });

  it('opens the booking dialog of a project booking', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Open booking on Bioprocess Scale-Up' }));
    const ui = useUIStore.getState();
    expect(ui.modalContext).toEqual({ projectId: 1, phaseId: undefined, subphaseId: undefined });
    expect(ui.editingStaffAssignment).toMatchObject({ id: 1, phase_id: null, subphase_id: null, linked: false });
  });

  it('says when there are no bookings', async () => {
    useAppStore.setState({ projects: [], sites: [] });
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No upcoming bookings');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No bookings');
  });

  it('lists nothing without a signed-in user', () => {
    useAppStore.setState({ currentUser: null });
    render(<WorkView />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No upcoming bookings');
  });
});

describe('My Requests', () => {
  beforeEach(() => useWorkStore.getState().setActiveTab('requests'));

  it('lists pending requests with Cancel, and decided ones under Done', async () => {
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Leave Feasibility of Bioprocess Scale-Up');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Awaiting approval');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(useWorkStore.getState().requestsFilter).toBe('done');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Approved by Carol');
    expect(screen.queryByRole('button', { name: /^Cancel request/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(useWorkStore.getState().requestsFilter).toBe('open');
  });

  it('cancels a pending request and reloads the projects', async () => {
    vi.mocked(approvalsApi.cancel).mockResolvedValueOnce({ success: true, id: 40, status: 'cancelled' });
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(approvalsApi.cancel).toHaveBeenCalledWith(40));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(useWorkStore.getState().mine.find((r) => r.id === 40)?.status).toBe('cancelled');
  });

  it('shows a failed cancel in place', async () => {
    vi.mocked(approvalsApi.cancel).mockRejectedValueOnce(new Error('Request already approved'));
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request already approved');
  });

  it('says when there are no requests', async () => {
    vi.mocked(approvalsApi.getMine).mockResolvedValue([]);
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No pending requests');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No decided requests');
  });
});

describe('History', () => {
  const decided = (id: number, overrides: Partial<ApprovalRequest> = {}) =>
    makeApprovalRequest({
      id,
      status: 'approved',
      requester_id: 7,
      requester_name: 'Alice Smith',
      decided_by: 4,
      decided_by_name: 'Dora Decider',
      decided_at: '2026-10-21T14:05:00.000Z',
      ...overrides,
    });

  const lastCall = () => vi.mocked(approvalsApi.listHistory).mock.lastCall?.[0];

  async function openHistory() {
    await renderView();
    fireEvent.click(tab(/^History/));
    await waitFor(() => expect(useWorkStore.getState().history.loaded).toBe(true));
  }

  it('loads the requests I decided when the tab opens and lists them', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValue([
      decided(51, { decision_note: 'Fine by me' }),
      decided(50, { status: 'rejected' }),
    ]);
    await openHistory();

    expect(lastCall()).toEqual(expect.objectContaining({ scope: 'decided', limit: 50 }));
    expect(lastCall()?.closed).toBeUndefined();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    expect(panel).toHaveTextContent('Approved by Dora Decider');
    expect(panel).toHaveTextContent('Requested by Alice Smith');
    expect(panel).toHaveTextContent('“Fine by me”');
    expect(screen.getByRole('tab', { name: 'History, 2 items' })).toBeInTheDocument();
    // Fewer than a page: nothing more to load.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers only "Decided by me" without approvals.view_all', async () => {
    await openHistory();
    const scope = screen.getByRole('group', { name: 'Requests' });
    expect(within(scope).getAllByRole('button').map((b) => b.textContent)).toEqual(['Decided by me']);
    const outcome = screen.getByRole('group', { name: 'Outcome' });
    expect(within(outcome).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All',
      'Approved',
      'Rejected',
      'Cancelled',
    ]);
    expect(() => pickerTrigger(/^Decided by/)).toThrow(); // All-requests mode only
  });

  it('switches to every closed request with approvals.view_all', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user', permissions: [...USER_DEFAULTS, 'approvals.view_all'] }),
    });
    vi.mocked(approvalsApi.listHistory).mockResolvedValue([decided(51)]);
    await openHistory();

    fireEvent.click(screen.getByRole('button', { name: 'All requests' }));
    await waitFor(() => expect(lastCall()).toEqual(expect.objectContaining({ scope: 'all', closed: true })));
    const outcome = screen.getByRole('group', { name: 'Outcome' });
    expect(within(outcome).getByRole('button', { name: 'Expired' })).toBeInTheDocument();
    fireEvent.click(within(outcome).getByRole('button', { name: 'Superseded' }));
    await waitFor(() => expect(lastCall()?.status).toBe('superseded'));

    await waitFor(() => expect(useWorkStore.getState().history.loading).toBe(false));
    pickOption(/^Decided by/, 'Dora Decider');
    await waitFor(() => expect(lastCall()?.decided_by).toBe(4));

    // Back to my decisions: the All-mode outcome and decider are dropped.
    fireEvent.click(screen.getByRole('button', { name: 'Decided by me' }));
    await waitFor(() => expect(lastCall()?.scope).toBe('decided'));
    expect(lastCall()?.status).toBeUndefined();
    expect(lastCall()?.decided_by).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Expired' })).not.toBeInTheDocument();
  });

  it('turns the outcome and the pickers into request params', async () => {
    vi.mocked(approvalsApi.listHistory).mockResolvedValue([decided(51)]);
    await openHistory();

    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Rejected' }));
    await waitFor(() => expect(lastCall()?.status).toBe('rejected'));
    await waitFor(() => expect(useWorkStore.getState().history.loading).toBe(false));

    expect(pickerTrigger(/^Project/)).toHaveTextContent('Any project');
    pickOption(/^Project/, 'Trial');
    await waitFor(() => expect(lastCall()?.project_id).toBe(2));
    await waitFor(() => expect(useWorkStore.getState().history.loading).toBe(false));

    pickOption(/^Requested by/, 'Alice Smith');
    await waitFor(() => expect(lastCall()).toEqual(expect.objectContaining({ requester_id: 7, project_id: 2 })));
  });

  it('loads more after the last row when the page was full', async () => {
    const page = Array.from({ length: 50 }, (_, i) => decided(200 - i));
    vi.mocked(approvalsApi.listHistory).mockResolvedValueOnce(page).mockResolvedValueOnce([decided(100)]);
    await openHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(useWorkStore.getState().history.rows).toHaveLength(51));
    expect(lastCall()?.before_id).toBe(151);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says when nothing was decided yet', async () => {
    await openHistory();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No decided requests yet.');
  });

  it('says it is loading until the first page lands', async () => {
    vi.mocked(approvalsApi.listHistory).mockReturnValue(new Promise(() => {}));
    await renderView();
    fireEvent.click(tab(/^History/));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Loading…');
  });

  it('shows a failed load in place instead of the empty state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(approvalsApi.listHistory).mockRejectedValue(new Error('500'));
    await openHistory();
    expect(screen.getByRole('alert')).toHaveTextContent('The history could not be loaded.');
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('No decided requests yet.');
  });
});
