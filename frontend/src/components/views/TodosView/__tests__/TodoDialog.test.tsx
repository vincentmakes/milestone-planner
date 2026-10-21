/**
 * The task dialog: a title is required; the assignee is the signed-in user
 * only without todos.assign_others (or the PM bundle on the chosen project);
 * a card can be linked once a project is chosen; a double click creates one
 * task (submit guard); edits send explicit nulls for cleared fields; the
 * creator deletes after a confirmation; failures show in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TodoDialog } from '../TodoDialog';
import { todosApi } from '@/api/endpoints/todos';
import { useAppStore } from '@/stores/appStore';
import { useTodoStore } from '@/stores/todoStore';
import { resetAllStores } from '@/stores';
import { stubConfirm } from '@/test/confirmDialog';
import { makePhase, makeProject, makeStaff, makeSubphase, makeTodo, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';

vi.mock('@/api/endpoints/todos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/todos')>()),
  todosApi: { getMine: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

const onClose = vi.fn();
const project = makeProject({
  id: 1,
  name: 'Bioprocess Scale-Up',
  pm_id: 4,
  phases: [
    makePhase({ id: 10, name: 'Feasibility' }),
    makePhase({ id: 11, name: 'Design', children: [makeSubphase({ id: 20, name: 'DoE setup', parent_phase_id: 11 })] }),
  ],
});
const other = makeProject({ id: 2, name: 'Catalyst Optimization', pm_id: 7 });
const archived = makeProject({ id: 3, name: 'Old project', archived: true });

function seed(permissions: readonly string[] = USER_DEFAULTS) {
  useAppStore.setState({
    currentUser: makeUser({ id: 4, first_name: 'Bob', last_name: 'Brown', role: 'user', permissions: permissions as never }),
    projects: [other, project, archived],
    staff: [
      makeStaff({ id: 4, name: 'Bob Brown', site_id: 1 }),
      makeStaff({ id: 7, name: 'Alice Smith', site_id: 1 }),
      makeStaff({ id: 7, name: 'Alice Smith', site_id: 2 }),
      makeStaff({ id: 9, name: 'Inactive Ivan', active: false }),
    ],
  });
}

const assignee = () => screen.getByLabelText('Assignee') as HTMLSelectElement;
const optionLabels = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  seed();
});

describe('create', () => {
  it('requires a title', async () => {
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required');
    expect(todosApi.create).not.toHaveBeenCalled();
  });

  it('creates one task on a double click and adds it to the store', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(todosApi.create).mockImplementation(() => new Promise((r) => (resolve = r as never)));
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Order reagents  ' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Two boxes' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-02' } });
    const create = screen.getByRole('button', { name: 'Create task' });
    act(() => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    expect(todosApi.create).toHaveBeenCalledTimes(1);
    expect(todosApi.create).toHaveBeenCalledWith({
      title: 'Order reagents',
      notes: 'Two boxes',
      due_date: '2026-11-02',
      assignee_id: 4,
      project_id: null,
      entity_type: null,
      entity_id: null,
    });
    await act(async () => resolve(makeTodo({ id: 5, title: 'Order reagents' })));
    expect(useTodoStore.getState().tasks.map((t) => t.id)).toEqual([5]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a failed create in place and stays open', async () => {
    vi.mocked(todosApi.create).mockRejectedValueOnce(new Error('Assignee not found'));
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Assignee not found');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('assignee', () => {
  it('offers only me without todos.assign_others', () => {
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    expect(optionLabels(assignee())).toEqual(['Bob Brown (me)']);
    expect(assignee()).toBeDisabled();
    expect(screen.getByText('You can assign tasks only to yourself')).toBeInTheDocument();
  });

  it('offers the active staff, once each, with todos.assign_others', () => {
    seed([...USER_DEFAULTS, 'todos.assign_others']);
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    expect(optionLabels(assignee())).toEqual(['Bob Brown (me)', 'Alice Smith']);
    fireEvent.change(assignee(), { target: { value: '7' } });
    expect(assignee().value).toBe('7');
  });

  it('offers others on a project I manage (PM bundle), and falls back to me when the project changes', () => {
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '1' } });
    expect(optionLabels(assignee())).toEqual(['Bob Brown (me)', 'Alice Smith']);
    fireEvent.change(assignee(), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '2' } });
    expect(optionLabels(assignee())).toEqual(['Bob Brown (me)']);
    expect(assignee().value).toBe('4');
  });
});

describe('project and card', () => {
  it('lists active projects by name and the chosen project’s cards', async () => {
    vi.mocked(todosApi.create).mockResolvedValueOnce(makeTodo({ id: 6 }));
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    const projectSelect = screen.getByLabelText('Project') as HTMLSelectElement;
    expect(optionLabels(projectSelect)).toEqual(['No project', 'Bioprocess Scale-Up', 'Catalyst Optimization']);
    const card = screen.getByLabelText('Card') as HTMLSelectElement;
    expect(card).toBeDisabled();
    fireEvent.change(projectSelect, { target: { value: '1' } });
    expect(optionLabels(card)).toEqual(['No card', 'Feasibility', 'Design / DoE setup']);
    fireEvent.change(card, { target: { value: 'subphase:20' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Prepare' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(todosApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 1, entity_type: 'subphase', entity_id: 20 })
      )
    );
    // Changing the project drops the card.
  });

  it('drops the card when the project changes', () => {
    render(<TodoDialog isOpen task={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Card'), { target: { value: 'phase:10' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    expect((screen.getByLabelText('Card') as HTMLSelectElement).value).toBe('');
  });
});

describe('edit', () => {
  const task = makeTodo({
    id: 8,
    title: 'Check the plan',
    notes: 'Old note',
    due_date: '2026-11-02',
    project_id: 1,
    project_name: 'Bioprocess Scale-Up',
    entity_type: 'phase',
    entity_id: 10,
  });

  it('starts from the task and sends explicit nulls for cleared fields', async () => {
    vi.mocked(todosApi.update).mockResolvedValueOnce({ ...task, notes: null, due_date: null });
    render(<TodoDialog isOpen task={task} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeInTheDocument();
    expect((screen.getByLabelText('Card') as HTMLSelectElement).value).toBe('phase:10');
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(todosApi.update).toHaveBeenCalledWith(8, {
        title: 'Check the plan',
        notes: null,
        due_date: null,
        assignee_id: 4,
        project_id: 1,
        entity_type: 'phase',
        entity_id: 10,
      })
    );
    expect(useTodoStore.getState().tasks[0]).toMatchObject({ id: 8, notes: null });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the current assignee of a task I gave someone else', () => {
    render(<TodoDialog isOpen task={{ ...task, assignee_id: 7, assignee_name: 'Alice Smith' }} onClose={onClose} />);
    expect(optionLabels(assignee())).toEqual(['Bob Brown (me)', 'Alice Smith']);
    expect(assignee().value).toBe('7');
  });

  it('deletes after a confirmation, as the creator', async () => {
    const confirm = stubConfirm(true);
    vi.mocked(todosApi.remove).mockResolvedValueOnce({ success: true, id: 8 });
    useTodoStore.getState().setTasks([task]);
    render(<TodoDialog isOpen task={task} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(todosApi.remove).toHaveBeenCalledWith(8));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete the task "Check the plan"?' }));
    expect(useTodoStore.getState().tasks).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('does nothing when the delete is not confirmed, and reports a failed one', async () => {
    stubConfirm(false);
    render(<TodoDialog isOpen task={task} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => {});
    expect(todosApi.remove).not.toHaveBeenCalled();

    stubConfirm(true);
    vi.mocked(todosApi.remove).mockRejectedValueOnce(new Error('Only the creator can delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the creator can delete');
  });

  it('offers no Delete on a task someone else created', () => {
    render(<TodoDialog isOpen task={{ ...task, created_by: 7, created_by_name: 'Alice Smith' }} onClose={onClose} />);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
