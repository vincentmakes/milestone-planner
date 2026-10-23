/**
 * CardComments: the thread of a card or a project — loads it, posts with
 * @-mentions (people on the target first, the site's mentionable people
 * cached per site), deletes after a confirm (author or moderator), guards a
 * double click, shows its own errors, and none of its buttons submits a form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CardComments } from '../CardComments';
import { createComment, deleteComment, getComments, getMentionableUsers } from '@/api/endpoints/kanban';
import type { CardComment } from '@/api/endpoints/kanban';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import { makeUser } from '@/test/factories';
import type { StaffAssignment } from '@/types';

vi.mock('@/api/endpoints/kanban', () => ({
  getComments: vi.fn(),
  getMentionableUsers: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
}));

const ME = 4;

function comment(over: Partial<CardComment> = {}): CardComment {
  return {
    id: 1,
    entity_type: 'phase',
    entity_id: 10,
    project_id: 1,
    author_id: 7,
    author_name: 'Alice Anderson',
    body: 'Check with @[Bob Brown](4)',
    mentioned_user_ids: [4],
    edited: false,
    created_at: '2026-10-20T08:00:00.000Z',
    updated_at: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

const participants: StaffAssignment[] = [
  { id: 1, staff_id: 9, staff_name: 'Carol Chen', allocation: 50, start_date: '', end_date: '' },
];

function renderThread(props: Partial<Parameters<typeof CardComments>[0]> = {}) {
  return render(
    <CardComments
      entityType="phase"
      entityId={10}
      projectId={1}
      siteId={1}
      participants={participants}
      meUserId={ME}
      {...props}
    />
  );
}

const composer = () => screen.getByLabelText('Comment') as HTMLTextAreaElement;
const postButton = () => screen.getByRole('button', { name: 'Comment' });

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
  useAppStore.setState({ currentUser: makeUser({ id: ME, role: 'user' }) });
  vi.mocked(getComments).mockResolvedValue([comment()]);
  vi.mocked(getMentionableUsers).mockResolvedValue([
    { id: 7, name: 'Alice Anderson', job_title: 'Engineer' },
    { id: ME, name: 'Bob Brown', job_title: null },
  ]);
  vi.mocked(createComment).mockResolvedValue(comment({ id: 2 }));
});

describe('CardComments', () => {
  it('loads the thread of its target and renders mentions', async () => {
    renderThread();
    expect(await screen.findByText('Alice Anderson')).toBeInTheDocument();
    expect(getComments).toHaveBeenCalledWith('phase', 10);
    expect(screen.getByRole('region', { name: 'Comments' })).toHaveTextContent('Check with @Bob Brown');
  });

  it('loads a project thread by the project id', async () => {
    renderThread({ entityType: 'project', entityId: 1 });
    await settle();
    expect(getComments).toHaveBeenCalledWith('project', 1);
  });

  it('says when there are no comments, and logs a failed load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getComments).mockRejectedValueOnce(new Error('500'));
    renderThread();
    await settle();
    expect(screen.getByText('No comments yet')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith('[Comments] Failed to load comments:', expect.any(Error));
    error.mockRestore();
  });

  it('offers the people on the target first, then the site, never me', async () => {
    renderThread();
    await waitFor(() => expect(getMentionableUsers).toHaveBeenCalledWith(1));
    await settle();
    type(composer(), '@');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Carol Chen');
    expect(options.map((o) => o.textContent).join(' ')).toContain('Alice Anderson');
    expect(options.map((o) => o.textContent).join(' ')).not.toContain('Bob Brown');
  });

  it('heads the target\'s people "On this card", or "On this project" on a project thread', async () => {
    const { unmount } = renderThread();
    await waitFor(() => expect(getMentionableUsers).toHaveBeenCalledWith(1));
    await settle();
    type(composer(), '@');
    expect(within(screen.getByRole('listbox')).getByText('On this card')).toBeInTheDocument();
    unmount();

    renderThread({ entityType: 'project', entityId: 1 });
    await settle();
    type(composer(), '@');
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('On this project')).toBeInTheDocument();
    expect(within(list).queryByText('On this card')).not.toBeInTheDocument();
  });

  it('loads the site list once for two threads of one site', async () => {
    const first = renderThread();
    await settle();
    first.unmount();
    renderThread({ entityId: 11 });
    await settle();
    expect(getMentionableUsers).toHaveBeenCalledTimes(1);
  });

  it('asks for no site list without a site, and logs a failed one', async () => {
    renderThread({ siteId: null });
    await settle();
    expect(getMentionableUsers).not.toHaveBeenCalled();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getMentionableUsers).mockRejectedValueOnce(new Error('403'));
    renderThread({ siteId: 2 });
    await settle();
    expect(error).toHaveBeenCalledWith('[Comments] Failed to load mentionable users:', expect.any(Error));
    error.mockRestore();
  });

  it('posts with a picked mention, clears the composer and reloads the thread', async () => {
    renderThread();
    await settle();
    type(composer(), 'ping @Ali');
    press(composer(), 'ArrowDown');
    press(composer(), 'Enter');
    await act(async () => {
      fireEvent.click(postButton());
    });
    expect(createComment).toHaveBeenCalledWith('phase', 10, 'ping @[Alice Anderson](7)', [7]);
    await waitFor(() => expect(composer()).toHaveValue(''));
    expect(getComments).toHaveBeenCalledTimes(2);
  });

  it('posts nothing for a blank draft', async () => {
    renderThread();
    await settle();
    type(composer(), '   ');
    expect(postButton()).toBeDisabled();
    fireEvent.click(postButton());
    expect(createComment).not.toHaveBeenCalled();
  });

  it('posts one comment when Comment is clicked twice before the first post settles', async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(createComment).mockImplementationOnce(() => new Promise((r) => { finish = r; }) as never);
    renderThread();
    await settle();
    type(composer(), 'Looks good');
    const post = postButton();
    act(() => {
      fireEvent.click(post);
      fireEvent.click(post);
    });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(post).toBeDisabled();
    await act(async () => finish({}));
    await waitFor(() => expect(composer()).toHaveValue(''));
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal in its own notice and keeps the draft", async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new Error('Permission required: kanban.comment'));
    renderThread();
    await settle();
    type(composer(), 'Hello');
    await act(async () => {
      fireEvent.click(postButton());
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Permission required: kanban.comment');
    expect(composer()).toHaveValue('Hello');
  });

  it('deletes my own comment after the confirm, and not when declined', async () => {
    vi.mocked(getComments).mockResolvedValue([comment({ id: 5, author_id: ME, author_name: 'Bob Brown' })]);
    vi.mocked(deleteComment).mockResolvedValue({ success: true });
    const confirm = stubConfirm(false);
    renderThread();
    const remove = await screen.findByRole('button', { name: 'Delete comment' });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete this comment? This cannot be undone.', destructive: true })
    );
    expect(deleteComment).not.toHaveBeenCalled();

    stubConfirm(true);
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(deleteComment).toHaveBeenCalledWith(5);
  });

  it('shows a failed delete in place', async () => {
    vi.mocked(getComments).mockResolvedValue([comment({ id: 5, author_id: ME })]);
    vi.mocked(deleteComment).mockRejectedValueOnce(new Error('Comment not found'));
    stubConfirm(true);
    renderThread();
    const remove = await screen.findByRole('button', { name: 'Delete comment' });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Comment not found');
  });

  it("offers deleting someone else's comment to moderators only", async () => {
    renderThread();
    await screen.findByText('Alice Anderson');
    expect(screen.queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
  });

  it('lets a moderator delete anyone\'s comment, and names a deleted author', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: ME, role: 'moderator', permissions: ['kanban.moderate_comments'] }),
    });
    vi.mocked(getComments).mockResolvedValue([comment({ author_id: null, author_name: null, edited: true })]);
    renderThread();
    expect(await screen.findByText('Deleted user')).toBeInTheDocument();
    expect(screen.getByText(/\(edited\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
  });

  it('never submits a form around it', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    vi.mocked(getComments).mockResolvedValue([comment({ id: 5, author_id: ME })]);
    render(
      <form onSubmit={onSubmit}>
        <CardComments entityType="phase" entityId={10} projectId={1} siteId={1} participants={[]} meUserId={ME} />
      </form>
    );
    await screen.findByRole('button', { name: 'Delete comment' });
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button');
    type(composer(), 'Hi');
    await act(async () => {
      fireEvent.click(postButton());
    });
    expect(createComment).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts clean on another thread', async () => {
    const view = renderThread();
    await settle();
    type(composer(), 'draft');
    view.rerender(
      <CardComments entityType="subphase" entityId={20} projectId={1} siteId={1} participants={[]} meUserId={ME} />
    );
    await settle();
    expect(composer()).toHaveValue('');
    expect(getComments).toHaveBeenLastCalledWith('subphase', 20);
  });
});
