/**
 * The optional comment of a new staff booking and the note of an equipment
 * booking (r9).
 *
 * Staff, create only: assigned directly the comment is added to the booking's
 * thread (the field shows only with `kanban.comment`); as a request it is the
 * message for the approver (always offered; the "added once approved" hint
 * only with `kanban.comment`). Sent serialised then trimmed, omitted when
 * blank; Enter in it never submits. Equipment: a note on create and edit (an
 * edit always sends it, "" clears it), and always booked on the project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import {
  createEquipmentAssignment,
  createStaffAssignment,
  loadAllProjects,
  updateEquipmentAssignment,
} from '@/api/endpoints/projects';
import { getMentionableUsers } from '@/api/endpoints/kanban';
import { clearMentionableUsersCache } from '@/api/endpoints/mentionableCache';
import { makePhase, makeProject, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import { pickOption } from '@/test/searchableSelect';
import type { PermissionKey } from '@/types/permissions';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  updateStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  updateEquipmentAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/api/endpoints/kanban', () => ({
  getMentionableUsers: vi.fn(),
  getComments: vi.fn().mockResolvedValue([]),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
}));

const PM = 42;
const ME = 4;

const project = makeProject({
  id: 1,
  site_id: 1,
  pm_id: PM,
  phases: [
    makePhase({
      id: 3,
      staffAssignments: [{ id: 11, staff_id: 9, staff_name: 'Carol Chen', allocation: 50, start_date: '', end_date: '' }],
    }),
  ],
  equipmentAssignments: [
    { id: 21, equipment_id: 5, project_id: 1, start_date: '2026-03-02', end_date: '2026-03-06', note: 'Bring the column' },
  ],
});

function seed(user: Parameters<typeof makeUser>[0]) {
  useAppStore.setState({
    projects: [project],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [
      { id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 100 },
      { id: ME, name: 'Bob Brown', site_id: 1, active: true, max_capacity: 100 },
    ] as never,
    equipment: [{ id: 5, name: 'HPLC', type: 'Analytical', site_id: 1 }] as never,
    currentUser: makeUser(user),
  });
}

/** The project's manager (an editor) with or without the commenting key. */
function seedEditor(canComment = true) {
  seed({
    id: PM,
    role: 'user',
    permissions: canComment ? [...USER_DEFAULTS] : USER_DEFAULTS.filter((k) => k !== 'kanban.comment'),
  });
}

/** A user whose own bookings need approval, with or without the commenting key. */
function seedRequester(canComment = true) {
  const keys: PermissionKey[] = ['assignments.self_create'];
  seed({
    id: ME,
    role: 'user',
    permissions: USER_DEFAULTS.filter((k) => !keys.includes(k) && (canComment || k !== 'kanban.comment')),
    approval_required: keys,
  });
}

function openStaffCreate(context: { projectId: number; phaseId?: number } = { projectId: 1, phaseId: 3 }) {
  useUIStore.setState({ editingStaffAssignment: null, editingEquipmentAssignment: null });
  useUIStore.getState().openModal('staffAssignment', context);
}

const commentField = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length } });
}

function press(textarea: HTMLTextAreaElement, key: string) {
  fireEvent.keyDown(textarea, { key });
  fireEvent.keyUp(textarea, { key });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMentionableUsersCache();
  vi.mocked(getMentionableUsers).mockResolvedValue([
    { id: 7, name: 'Alice Anderson', job_title: 'Engineer' },
    { id: PM, name: 'Paula Manager', job_title: null },
  ]);
  vi.mocked(loadAllProjects).mockResolvedValue([project]);
});

describe('AssignmentModal: the comment of a new staff booking', () => {
  it('sends a direct booking comment with a picked mention, serialised then trimmed', async () => {
    seedEditor();
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(getMentionableUsers).toHaveBeenCalledWith(1);
    expect(screen.getByText('Comment (optional)')).toBeInTheDocument();
    expect(screen.getByText("Added to the booking's comment thread.")).toBeInTheDocument();

    pickOption(/^Staff Member/, 'Alice Anderson');
    const field = commentField('Comment (optional)');
    // The people on the card come first, then the site's; never yourself.
    type(field, '@');
    const options = within(screen.getByRole('listbox', { name: 'Mentionable people' })).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Carol Chen');
    expect(options.map((o) => o.textContent).join(' ')).toContain('Alice Anderson');
    expect(options.map((o) => o.textContent).join(' ')).not.toContain('Paula Manager');
    type(field, '  Welcome @Ali');
    press(field, 'ArrowDown');
    press(field, 'Enter');
    type(field, `${field.value}aboard  `); // a picked mention ends with a space

    fireEvent.click(screen.getByRole('button', { name: 'Assign Staff' }));
    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      staff_id: 7,
      project_id: 1,
      phase_id: 3,
      comment: 'Welcome @[Alice Anderson](7) aboard',
    });
  });

  it('omits a blank comment', async () => {
    seedEditor();
    openStaffCreate({ projectId: 1 });
    render(<AssignmentModal mode="staff" />);
    await settle();
    pickOption(/^Staff Member/, 'Alice Anderson');
    type(commentField('Comment (optional)'), '   ');

    fireEvent.click(screen.getByRole('button', { name: 'Assign Staff' }));
    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).not.toHaveProperty('comment');
  });

  it('never submits on Enter in the comment', async () => {
    seedEditor();
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();
    pickOption(/^Staff Member/, 'Alice Anderson');
    const field = commentField('Comment (optional)');
    type(field, 'First line');
    press(field, 'Enter');
    await settle();

    expect(createStaffAssignment).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });

  it('hides the comment of a direct booking without kanban.comment, and loads no people', async () => {
    seedEditor(false);
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();

    expect(screen.queryByText('Comment (optional)')).not.toBeInTheDocument();
    expect(getMentionableUsers).not.toHaveBeenCalled();
  });

  it('labels a request message for the approver, with the thread hint for a commenter', async () => {
    seedRequester();
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();

    expect(screen.getByRole('button', { name: 'Request to assign me' })).toBeInTheDocument();
    expect(screen.getByText("Added to the booking's comment thread once approved.")).toBeInTheDocument();
    type(commentField('Message for the approver (optional)'), ' Can I help? ');
    fireEvent.click(screen.getByRole('button', { name: 'Request to assign me' }));
    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      staff_id: ME,
      comment: 'Can I help?',
    });
  });

  it('offers a request message without kanban.comment, but no thread hint', async () => {
    seedRequester(false);
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();

    expect(commentField('Message for the approver (optional)')).toBeInTheDocument();
    expect(screen.queryByText(/comment thread/)).not.toBeInTheDocument();
  });

  it('names the field with a real label and words the placeholder for who gets notified', async () => {
    seedEditor();
    openStaffCreate();
    const { unmount } = render(<AssignmentModal mode="staff" />);
    await settle();
    const direct = screen.getByLabelText('Comment (optional)');
    expect(direct.tagName).toBe('TEXTAREA');
    expect(direct).toHaveAttribute('placeholder', 'Type @ to notify someone.');
    unmount();

    seedRequester();
    openStaffCreate();
    const second = render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByLabelText('Message for the approver (optional)')).toHaveAttribute(
      'placeholder',
      'Type @ to mention someone; they are notified once the request is approved.'
    );
    second.unmount();

    seedRequester(false);
    openStaffCreate();
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByLabelText('Message for the approver (optional)')).toHaveAttribute(
      'placeholder',
      'Why you need this booking.'
    );
  });

  it('shows no comment field when editing a booking', async () => {
    seedEditor();
    useUIStore.getState().setEditingStaffAssignment({
      id: 11,
      project_id: 1,
      phase_id: 3,
      subphase_id: null,
      staff_id: 9,
      staff_name: 'Carol Chen',
      allocation: 50,
      start_date: '',
      end_date: '',
    });
    useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3 });
    render(<AssignmentModal mode="staff" />);
    await settle();

    expect(screen.queryByText('Comment (optional)')).not.toBeInTheDocument();
  });
});

describe('AssignmentModal: the note of an equipment booking', () => {
  it('books equipment from a phase row on the project, with its note', async () => {
    seedEditor();
    useUIStore.setState({ editingEquipmentAssignment: null });
    useUIStore.getState().openModal('equipmentAssignment', { projectId: 1, phaseId: 3 });
    render(<AssignmentModal mode="equipment" />);
    pickOption(/^Equipment/, 'HPLC');
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  Bring the column  ' } });
    expect(screen.getByLabelText('Note (optional)')).toHaveAttribute('maxLength', '2000');

    fireEvent.click(screen.getByRole('button', { name: 'Assign Equipment' }));
    await waitFor(() => expect(createEquipmentAssignment).toHaveBeenCalled());
    const sent = vi.mocked(createEquipmentAssignment).mock.calls[0][0];
    expect(sent).toMatchObject({ equipment_id: 5, project_id: 1, note: 'Bring the column' });
    expect(sent).not.toHaveProperty('phase_id');
    expect(sent).not.toHaveProperty('subphase_id');
  });

  it('omits a blank note on create', async () => {
    seedEditor();
    useUIStore.setState({ editingEquipmentAssignment: null });
    useUIStore.getState().openModal('equipmentAssignment', { projectId: 1 });
    render(<AssignmentModal mode="equipment" />);
    pickOption(/^Equipment/, 'HPLC');

    fireEvent.click(screen.getByRole('button', { name: 'Assign Equipment' }));
    await waitFor(() => expect(createEquipmentAssignment).toHaveBeenCalled());
    expect(vi.mocked(createEquipmentAssignment).mock.calls[0][0]).not.toHaveProperty('note');
  });

  it('refuses to book equipment without a project', async () => {
    seedEditor();
    useUIStore.setState({ editingEquipmentAssignment: null });
    useUIStore.getState().openModal('equipmentAssignment', {});
    render(<AssignmentModal mode="equipment" />);
    pickOption(/^Equipment/, 'HPLC');

    fireEvent.click(screen.getByRole('button', { name: 'Assign Equipment' }));
    expect(await screen.findByText('No project to book the equipment on')).toBeInTheDocument();
    expect(createEquipmentAssignment).not.toHaveBeenCalled();
  });

  it.each([
    ['keeps an edited note', 'Use the long column', 'Use the long column', 'Use the long column'],
    ['clears an emptied note', '', '', null],
  ])('%s on edit', async (_name, typed, sent, local) => {
    seedEditor();
    // The reload returns what the store holds, so the local patch shows.
    vi.mocked(loadAllProjects).mockImplementation(async () => useAppStore.getState().projects);
    useUIStore.getState().setEditingEquipmentAssignment(project.equipmentAssignments[0]);
    useUIStore.getState().openModal('equipmentAssignment', { projectId: 1 });
    render(<AssignmentModal mode="equipment" />);
    const field = screen.getByLabelText('Note (optional)');
    expect(field).toHaveValue('Bring the column');
    fireEvent.change(field, { target: { value: typed } });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateEquipmentAssignment).toHaveBeenCalled());
    expect(updateEquipmentAssignment).toHaveBeenCalledWith(21, {
      equipment_id: 5,
      start_date: '2026-03-02',
      end_date: '2026-03-06',
      note: sent,
    });
    // The local tree shows the note at once (What-If: the reload is a no-op).
    const booking = useAppStore.getState().projects[0].equipmentAssignments[0];
    expect(booking.note).toBe(local);
  });
});
