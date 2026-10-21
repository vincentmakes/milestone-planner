/**
 * My Todos: three tabs (To decide / My tasks / My requests) with counts, an
 * Open/Done filter, decisions through the shared ApprovalActions (then the
 * projects reload), the done switch (optimistic, reverted on failure), card
 * links that open the Kanban card (not during What-If), cancelling my own
 * request, and New task (hidden during What-If). Loads on mount and focus.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TodosView } from '../TodosView';
import { todosApi } from '@/api/endpoints/todos';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from '@/stores/appStore';
import { useTodoStore } from '@/stores/todoStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeApprovalRequest, makePhase, makeProject, makeTodo, makeUser } from '@/test/factories';

const refreshProjects = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects }),
}));
vi.mock('@/api/endpoints/todos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/todos')>()),
  todosApi: { getMine: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: {
    getMine: vi.fn(),
    getToDecide: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
}));

const toDecide = makeApprovalRequest({ id: 31, requester_id: 7, requester_name: 'Alice Smith', can_decide: true });
const myRequest = makeApprovalRequest({ id: 40, action: 'assignments.self_remove', assignment_id: 72 });
const decidedRequest = makeApprovalRequest({ id: 41, status: 'approved', decided_by_name: 'Carol' });
const linkedTask = makeTodo({
  id: 1,
  title: 'Check the DoE plan',
  project_id: 1,
  project_name: 'Bioprocess Scale-Up',
  entity_type: 'phase',
  entity_id: 10,
  due_date: '2020-01-01',
});
const doneTask = makeTodo({ id: 2, title: 'Book the HPLC', status: 'done' });
const forOthers = makeTodo({ id: 3, title: 'Write the report', assignee_id: 7, assignee_name: 'Alice Smith' });

function seedApi() {
  vi.mocked(todosApi.getMine).mockResolvedValue([linkedTask, doneTask, forOthers]);
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([toDecide]);
  vi.mocked(approvalsApi.getMine).mockResolvedValue([myRequest, decidedRequest]);
}

async function renderView() {
  const view = render(<TodosView />);
  await waitFor(() => expect(useTodoStore.getState().loaded).toBe(true));
  return view;
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  refreshProjects.mockResolvedValue(undefined);
  useAppStore.setState({
    currentUser: makeUser({ id: 4, role: 'user' }),
    projects: [makeProject({ id: 1, name: 'Bioprocess Scale-Up', phases: [makePhase({ id: 10, name: 'Feasibility' })] })],
  });
  seedApi();
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('tabs', () => {
  it('shows the three tabs with their open counts, My tasks first', async () => {
    await renderView();
    expect(screen.getByRole('tablist', { name: 'My Todos' })).toBeInTheDocument();
    expect(tab(/^To decide/)).toHaveTextContent('1');
    expect(tab(/^My tasks/)).toHaveTextContent('2');
    expect(tab(/^My requests/)).toHaveTextContent('1');
    expect(tab(/^My tasks/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Check the DoE plan');
  });

  it('switches tab on click and with the arrow keys', async () => {
    await renderView();
    fireEvent.click(tab(/^To decide/));
    expect(useTodoStore.getState().activeTab).toBe('decide');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Alice Smith wants to join Feasibility of Bioprocess Scale-Up at 40%');
    fireEvent.keyDown(tab(/^To decide/), { key: 'ArrowLeft' });
    expect(useTodoStore.getState().activeTab).toBe('requests');
    fireEvent.keyDown(tab(/^My requests/), { key: 'ArrowRight' });
    expect(useTodoStore.getState().activeTab).toBe('decide');
    fireEvent.keyDown(tab(/^To decide/), { key: 'End' });
    expect(useTodoStore.getState().activeTab).toBe('requests');
    fireEvent.keyDown(tab(/^My requests/), { key: 'Home' });
    expect(useTodoStore.getState().activeTab).toBe('decide');
    fireEvent.keyDown(tab(/^To decide/), { key: 'x' });
    expect(useTodoStore.getState().activeTab).toBe('decide');
  });

  it('reloads on window focus', async () => {
    await renderView();
    expect(todosApi.getMine).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(todosApi.getMine).toHaveBeenCalledTimes(2));
  });
});

describe('To decide', () => {
  beforeEach(() => useTodoStore.getState().setActiveTab('decide'));

  it('approves through the API, drops the row and reloads the projects', async () => {
    vi.mocked(approvalsApi.approve).mockResolvedValueOnce({ success: true, id: 31, status: 'approved' });
    await renderView();
    vi.mocked(approvalsApi.getToDecide).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Alice Smith' }));
    await waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledWith(31));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(useTodoStore.getState().toDecide).toEqual([]);
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

  it('says when nothing awaits a decision, and hides the Open/Done filter', async () => {
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
});

describe('My tasks', () => {
  it('lists open tasks with the overdue chip, who it is for, and the card link', async () => {
    await renderView();
    const panel = screen.getByRole('tabpanel');
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Overdue');
    expect(items[1]).toHaveTextContent('For Alice Smith');
    expect(within(panel).queryByText('Book the HPLC')).not.toBeInTheDocument();
  });

  it('shows done tasks under Done', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(useTodoStore.getState().statusFilter).toBe('done');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Book the HPLC');
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('Check the DoE plan');
  });

  it('marks a task done through the API, optimistically', async () => {
    vi.mocked(todosApi.update).mockResolvedValueOnce({ ...linkedTask, status: 'done' });
    await renderView();
    const item = screen.getAllByRole('listitem')[0];
    fireEvent.click(within(item).getByRole('switch', { name: 'Done' }));
    expect(useTodoStore.getState().tasks.find((t) => t.id === 1)?.status).toBe('done');
    await waitFor(() => expect(todosApi.update).toHaveBeenCalledWith(1, { status: 'done' }));
    // One request to decide; task 3 is Alice's.
    expect(useTodoStore.getState().openCount).toBe(1);
  });

  it('reopens a done task', async () => {
    vi.mocked(todosApi.update).mockResolvedValueOnce({ ...doneTask, status: 'open' });
    useTodoStore.getState().setStatusFilter('done');
    await renderView();
    fireEvent.click(screen.getByRole('switch', { name: 'Done' }));
    await waitFor(() => expect(todosApi.update).toHaveBeenCalledWith(2, { status: 'open' }));
  });

  it('puts the task back and says why when the write fails', async () => {
    vi.mocked(todosApi.update).mockRejectedValueOnce(new Error('Task not found'));
    await renderView();
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('switch', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Task not found');
    expect(useTodoStore.getState().tasks.find((t) => t.id === 1)?.status).toBe('open');
  });

  it('opens the linked card', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Open card Feasibility' }));
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'kanbanCard' });
    expect(useUIStore.getState().modalContext).toMatchObject({ cardEntityType: 'phase', cardEntityId: 10, cardProjectId: 1 });
  });

  it('shows the card as plain text without views.kanban', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'viewer', permissions: ['projects.view', 'todos.manage_own'] }) });
    await renderView();
    expect(screen.queryByRole('button', { name: 'Open card Feasibility' })).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Feasibility');
  });

  it('opens a task for editing from its title', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Check the DoE plan' }));
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeInTheDocument();
  });

  it('says when there is nothing to do', async () => {
    vi.mocked(todosApi.getMine).mockResolvedValue([]);
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No open tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No done tasks');
  });
});

describe('My requests', () => {
  beforeEach(() => useTodoStore.getState().setActiveTab('requests'));

  it('lists pending requests with Cancel, and decided ones under Done', async () => {
    await renderView();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Leave Feasibility of Bioprocess Scale-Up');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Awaiting approval');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Approved by Carol');
    expect(screen.queryByRole('button', { name: /^Cancel request/ })).not.toBeInTheDocument();
  });

  it('cancels a pending request and reloads the projects', async () => {
    vi.mocked(approvalsApi.cancel).mockResolvedValueOnce({ success: true, id: 40, status: 'cancelled' });
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(approvalsApi.cancel).toHaveBeenCalledWith(40));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(useTodoStore.getState().mine.find((r) => r.id === 40)?.status).toBe('cancelled');
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
  });
});

describe('New task and What-If', () => {
  it('opens the task dialog', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('hides New task without a todo key', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'viewer', permissions: ['projects.view'] }) });
    await renderView();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('hides New task and disables card links during What-If', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'admin' }) });
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderView();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    const link = screen.getByRole('button', { name: 'Open card Feasibility' });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', whatIfUnavailableMessage('Opening a card'));
  });
});
