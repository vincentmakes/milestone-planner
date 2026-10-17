/**
 * Settings › Users for superusers.
 *
 * The backend refuses (403) a superuser who edits an admin account, or who
 * changes the email or password of anyone but themselves. A superuser's store
 * only holds their own sites, so site links to other sites must be carried
 * over untouched, and `site_ids` is only sent once the picker was used.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { UsersPanel } from '../panels/UsersPanel';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createUser, deleteUser } from '@/api/endpoints/users';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import type { Site, User } from '@/types';

const getUsers = vi.fn();
const updateUser = vi.fn();
vi.mock('@/api/endpoints/users', () => ({
  getUsers: (...args: unknown[]) => getUsers(...args),
  updateUser: (...args: unknown[]) => updateUser(...args),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshStaff: vi.fn() }),
}));

const siteA: Site = { id: 1, name: 'Site A' } as Site;
const siteB: Site = { id: 2, name: 'Site B' } as Site;

const ada: User = {
  id: 1,
  email: 'admin@demo.local',
  first_name: 'Ada',
  last_name: 'Admin',
  name: 'Ada Admin',
  role: 'admin',
  active: true,
  site_ids: [1, 2],
};

const sam: User = {
  id: 2,
  email: 'sam@demo.local',
  first_name: 'Sam',
  last_name: 'Super',
  name: 'Sam Super',
  role: 'superuser',
  active: true,
  site_ids: [1],
};

/** A multi-site user: Site B is outside the superuser's sites */
const bob: User = {
  id: 4,
  email: 'bob.brown@demo.local',
  first_name: 'Bob',
  last_name: 'Brown',
  name: 'Bob Brown',
  role: 'user',
  active: true,
  site_ids: [1, 2],
  job_title: 'Analyst',
};

function seed(currentUser: User, sites: Site[]) {
  useAppStore.setState({ currentUser, sites, skills: [] });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

async function openEditor(name: string) {
  fireEvent.click(within(await rowOf(name)).getByTitle('Edit user'));
  await screen.findByText('Edit User');
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

beforeEach(() => {
  getUsers.mockReset().mockResolvedValue([ada, sam, bob]);
  updateUser.mockReset().mockResolvedValue({});
});

describe('UsersPanel as a superuser', () => {
  beforeEach(() => seed(sam, [siteA]));

  it('offers no Edit button on admin accounts', async () => {
    render(<UsersPanel />);
    expect(within(await rowOf('Ada Admin')).queryByTitle('Edit user')).not.toBeInTheDocument();
    expect(within(await rowOf('Bob Brown')).getByTitle('Edit user')).toBeInTheDocument();
  });

  it("hides another person's email and password and never sends them", async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    expect(screen.queryByLabelText('Email *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Browne' } });
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    const [id, payload] = updateUser.mock.calls[0];
    expect(id).toBe(4);
    expect(payload).toMatchObject({ first_name: 'Bob', last_name: 'Browne' });
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('password');
    // Role/active stay admin-only
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('active');
  });

  it('does not send site_ids when the site picker was not used', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser.mock.calls[0][1]).not.toHaveProperty('site_ids');
  });

  it('keeps links to sites outside their own when the picker is used', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    // Only Site A is offered; Site B is not in the superuser's store
    expect(screen.queryByRole('button', { name: 'Site B' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Site A' }));
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser.mock.calls[0][1].site_ids).toEqual([2]);
  });

  it('adds an own site without dropping the unseen one', async () => {
    getUsers.mockResolvedValue([ada, sam, { ...bob, site_ids: [2] }]);
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    fireEvent.click(screen.getByRole('button', { name: 'Site A' }));
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect([...updateUser.mock.calls[0][1].site_ids].sort()).toEqual([1, 2]);
  });

  it('keeps email and password on their own account', async () => {
    render(<UsersPanel />);
    await openEditor('Sam Super');

    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'sam.super@demo.local' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'new-secret' } });
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser.mock.calls[0][1]).toMatchObject({
      email: 'sam.super@demo.local',
      password: 'new-secret',
    });
  });
});

describe('UsersPanel as an admin', () => {
  beforeEach(() => seed(ada, [siteA, siteB]));

  it('edits anyone, including credentials, roles and every site', async () => {
    render(<UsersPanel />);
    expect(within(await rowOf('Ada Admin')).getByTitle('Edit user')).toBeInTheDocument();
    await openEditor('Bob Brown');

    expect(screen.getByLabelText('Email *')).toHaveValue('bob.brown@demo.local');
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'reset-123' } });
    save();

    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser.mock.calls[0][1]).toMatchObject({
      email: 'bob.brown@demo.local',
      password: 'reset-123',
      site_ids: [1, 2],
      role: 'user',
      active: true,
    });
  });
});

describe('UsersPanel filters and new user form (admin)', () => {
  beforeEach(() => {
    seed(ada, [siteA, siteB]);
    useAppStore.setState({ skills: [{ id: 3, name: 'HPLC' }] as never });
    getUsers.mockResolvedValue([ada, sam, { ...bob, skills: [{ id: 3, name: 'HPLC' }] }]);
  });

  it('filters the list by status, role, job title, site and skill', async () => {
    render(<UsersPanel />);
    await rowOf('Bob Brown');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

    const pick = (label: string, value: string) => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(screen.getByLabelText(label)).toHaveValue(value);
    };
    const count = (text: string) => expect(screen.getByText(text)).toBeInTheDocument();

    pick('Status', 'disabled');
    count('0 users (filtered from 3)');
    pick('Status', 'active');
    count('3 users');

    pick('Role', 'superuser');
    count('1 user (filtered from 3)');
    expect(screen.getByText('Sam Super')).toBeInTheDocument();
    pick('Role', 'all');

    pick('Job Title', 'Analyst');
    count('1 user (filtered from 3)');
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    pick('Job Title', 'all');

    pick('Site', '2');
    count('2 users (filtered from 3)');
    expect(screen.queryByText('Sam Super')).not.toBeInTheDocument();
    pick('Site', 'all');

    pick('Skill', '3');
    count('1 user (filtered from 3)');
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
  });

  it('creates a user with the typed details and the chosen role', async () => {
    vi.mocked(createUser).mockResolvedValue({} as never);
    render(<UsersPanel />);
    await rowOf('Bob Brown');
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }));

    const password = screen.getByLabelText('Password *');
    expect(password).toHaveAttribute('placeholder', 'Min 8 characters');
    expect(password).toBeRequired();

    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Cleo' } });
    expect(screen.getByLabelText('First Name *')).toHaveValue('Cleo');
    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Chen' } });
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'cleo@demo.local' } });
    fireEvent.change(password, { target: { value: 'welcome-1' } });
    const role = screen.getByLabelText('Role *');
    fireEvent.change(role, { target: { value: 'superuser' } });
    expect(role).toHaveValue('superuser');

    fireEvent.submit(role.closest('form')!);
    await waitFor(() => expect(createUser).toHaveBeenCalled());
    expect(vi.mocked(createUser).mock.calls[0][0]).toMatchObject({
      first_name: 'Cleo',
      last_name: 'Chen',
      email: 'cleo@demo.local',
      password: 'welcome-1',
      role: 'superuser',
    });
  });
});

describe('UsersPanel accessible names', () => {
  beforeEach(() => seed(ada, [siteA, siteB]));

  it('names the Edit action after the person on the row', async () => {
    render(<UsersPanel />);
    const edit = within(await rowOf('Bob Brown')).getByRole('button', { name: 'Edit Bob Brown' });
    expect(edit).toHaveAttribute('title', 'Edit user');
    expect(edit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(await rowOf('Sam Super')).getByRole('button', { name: 'Edit Sam Super' })).toBeInTheDocument();
  });

  it('offers Active as a switch an admin can flip for someone else', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');
    const active = screen.getByRole('switch', { name: 'Active' });
    expect(active).toBeChecked();
    expect(active).toBeEnabled();
    fireEvent.click(active);
    expect(active).not.toBeChecked();
    save();
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith(4, expect.objectContaining({ active: false })));
  });

  it('labels the inline new-skill confirm and cancel buttons', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');
    fireEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    expect(screen.getByRole('button', { name: 'Add skill' }).querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel adding a skill' }));
    expect(screen.queryByRole('button', { name: 'Add skill' })).not.toBeInTheDocument();
  });
});

describe('UsersPanel nested pickers and Escape', () => {
  beforeEach(() => seed(ada, [siteA, siteB]));

  it('Escape in the job-title suggestions closes only the suggestions', async () => {
    const onDocumentEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDocumentEscape();
    };
    document.addEventListener('keydown', listener);
    try {
      render(<UsersPanel />);
      await openEditor('Bob Brown');

      const jobTitle = screen.getByLabelText('Job Title');
      fireEvent.focus(jobTitle);
      fireEvent.change(jobTitle, { target: { value: '' } });
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.keyDown(jobTitle, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      // The enclosing dialog's document-level Escape listener never saw it
      expect(onDocumentEscape).not.toHaveBeenCalled();

      // With the list closed, Escape is left to the dialog
      fireEvent.keyDown(jobTitle, { key: 'Escape' });
      expect(onDocumentEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  it('Escape in the new-skill input cancels only that input', async () => {
    const onDocumentEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDocumentEscape();
    };
    document.addEventListener('keydown', listener);
    try {
      render(<UsersPanel />);
      await openEditor('Bob Brown');

      fireEvent.click(screen.getByRole('button', { name: '+ New skill' }));
      const input = screen.getByPlaceholderText('New skill name');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(screen.queryByPlaceholderText('New skill name')).not.toBeInTheDocument();
      expect(onDocumentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });
});

describe('UsersPanel own account (admin)', () => {
  beforeEach(() => seed(ada, [siteA, siteB]));

  it('disables Role and Delete on the signed-in admin\'s own row', async () => {
    render(<UsersPanel />);
    await openEditor('Ada Admin');

    expect(screen.getByLabelText('Role *')).toBeDisabled();
    expect(screen.getByText("You can't change your own role")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete User' })).toBeDisabled();

    // Saving their own details never sends a role/active change
    save();
    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(updateUser.mock.calls[0][1]).not.toHaveProperty('role');
    expect(updateUser.mock.calls[0][1]).not.toHaveProperty('active');
  });

  it('keeps Role and Delete enabled on other people\'s rows', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');
    expect(screen.getByLabelText('Role *')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete User' })).toBeEnabled();
  });
});

describe('UsersPanel form guards', () => {
  beforeEach(() => seed(ada, [siteA, siteB]));

  it('reports unsaved changes to the hub and clears them on Cancel', async () => {
    const onDirtyChange = vi.fn();
    render(<UsersPanel onDirtyChange={onDirtyChange} />);
    await openEditor('Bob Brown');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Browne' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('sends one update when the form is submitted twice', async () => {
    let finish!: () => void;
    updateUser.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    const form = screen.getByLabelText('Last Name *').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(updateUser).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.queryByText('Edit User')).not.toBeInTheDocument());
  });

  it('refuses a changed password shorter than 8 characters', async () => {
    render(<UsersPanel />);
    await openEditor('Bob Brown');
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'short7!' } });
    // Bypass the browser's minLength check, as a script or old browser would
    fireEvent.submit(screen.getByLabelText('Last Name *').closest('form')!);

    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('UsersPanel during What-If', () => {
  beforeEach(() => {
    seed(ada, [siteA, siteB]);
    vi.mocked(deleteUser).mockReset();
    useWhatIfStore.getState().enterWhatIfMode([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
  });

  it("disables Delete on other people's rows with the What-If hint", async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    const del = screen.getByRole('button', { name: 'Delete User' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', whatIfUnavailableMessage('Deleting users'));
    fireEvent.click(del);
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('deletes other people again once What-If ends', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteUser).mockResolvedValue(undefined as never);
    await useWhatIfStore.getState().exitWhatIfMode(false);
    render(<UsersPanel />);
    await openEditor('Bob Brown');

    const del = screen.getByRole('button', { name: 'Delete User' });
    expect(del).toBeEnabled();
    expect(del).not.toHaveAttribute('title');
    fireEvent.click(del);
    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith(4));
  });

  it('keeps the own-account message on the signed-in admin', async () => {
    render(<UsersPanel />);
    await openEditor('Ada Admin');
    const del = screen.getByRole('button', { name: 'Delete User' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', "You can't delete your own account");
  });
});
