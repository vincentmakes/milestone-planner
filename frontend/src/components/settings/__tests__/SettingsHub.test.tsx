/**
 * SettingsHub is the single window for admin/superuser configuration. These
 * pin its contracts: sections are gated by role (matching what the backend
 * accepts), the legacy modal keys open the hub at the right section, Escape
 * closes it but a backdrop click does not, and unsaved General changes are
 * guarded (also against the global keyboard-shortcut Escape handler).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SettingsHub } from '../SettingsHub';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { stubConfirm } from '@/test/confirmDialog';
import type { SettingsPanelProps } from '../types';
import type { UserRole } from '@/types';
import { makeUser } from '@/test/factories';
import { canOpenSettings, getVisibleSections } from '../sections';

// Panels talk to the API; the hub only needs something to render.
vi.mock('../panels/GeneralPanel', () => ({
  GeneralPanel: ({ onDirtyChange }: SettingsPanelProps) => (
    <div>
      General panel
      <button type="button" onClick={() => onDirtyChange(true)}>
        Make dirty
      </button>
    </div>
  ),
}));
vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({ undo: vi.fn(), redo: vi.fn() }),
}));
vi.mock('../panels/SitesPanel', () => ({ SitesPanel: () => <div>Sites panel</div> }));
vi.mock('../panels/TeamsPanel', () => ({ TeamsPanel: () => <div>Teams panel</div> }));
vi.mock('../panels/BankHolidaysPanel', () => ({ BankHolidaysPanel: () => <div>Bank holidays panel</div> }));
vi.mock('../panels/CompanyEventsPanel', () => ({ CompanyEventsPanel: () => <div>Company events panel</div> }));
vi.mock('../panels/UsersPanel', () => ({ UsersPanel: () => <div>Users panel</div> }));
vi.mock('../panels/SkillsPanel', () => ({ SkillsPanel: () => <div>Skills panel</div> }));
vi.mock('../panels/AbsenceTypesPanel', () => ({ AbsenceTypesPanel: () => <div>Absence types panel</div> }));
vi.mock('../panels/EquipmentPanel', () => ({ EquipmentPanel: () => <div>Equipment panel</div> }));
vi.mock('../panels/EquipmentTypesPanel', () => ({ EquipmentTypesPanel: () => <div>Equipment types panel</div> }));
vi.mock('../panels/PredefinedPhasesPanel', () => ({ PredefinedPhasesPanel: () => <div>Predefined phases panel</div> }));
vi.mock('../panels/SSOPanel', () => ({ SSOPanel: () => <div>SSO panel</div> }));
vi.mock('../panels/RolesPanel', () => ({ RolesPanel: () => <div>Roles panel</div> }));

const ALL_SECTIONS = [
  'General',
  'Roles',
  'Sites',
  'Teams',
  'Bank holidays',
  'Company events',
  'Users',
  'Skills',
  'Absence types',
  'Equipment',
  'Equipment types',
  'Predefined phases',
  'SSO',
];
// Keys only admins hold by default. General is listed for everyone who opens
// the hub (per-browser appearance; the panel keeps the instance-wide settings
// for settings.general), and superusers see Sites for its export control.
const ADMIN_ONLY = ['Absence types', 'SSO', 'Roles'];

/** The hub as mounted in the app, next to the global keyboard shortcuts */
function HubWithShortcuts() {
  useKeyboardShortcuts();
  return <SettingsHub />;
}

function setRole(role: UserRole, permissions?: string[]) {
  useAppStore.setState({ currentUser: makeUser({ role, ...(permissions ? { permissions } : {}) }) });
}

const navButton = (name: string) => screen.queryByRole('button', { name });
const sectionTitle = () => document.getElementById('settings-section-title')?.textContent;

describe('SettingsHub', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeModal: null,
      settingsSection: null,
      settingsIntent: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every section to admins', async () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings());
    render(<SettingsHub />);

    for (const label of ALL_SECTIONS) {
      expect(navButton(label)).toBeInTheDocument();
    }
    expect(await screen.findByText('General panel')).toBeInTheDocument();
  });

  it('hides admin-only sections from superusers', async () => {
    setRole('superuser');
    act(() => useUIStore.getState().openSettings());
    render(<SettingsHub />);

    for (const label of ADMIN_ONLY) {
      expect(navButton(label)).not.toBeInTheDocument();
    }
    for (const label of ALL_SECTIONS.filter((l) => !ADMIN_ONLY.includes(l))) {
      expect(navButton(label)).toBeInTheDocument();
    }
    // First visible section (General: appearance) is shown
    expect(await screen.findByText('General panel')).toBeInTheDocument();
  });

  it('lists the sections of a custom role\'s keys, General first', async () => {
    setRole('team_lead', ['projects.view', 'teams.manage', 'sites.export']);
    act(() => useUIStore.getState().openSettings());
    render(<SettingsHub />);

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['General', 'Sites', 'Teams'])
    );
    for (const label of ['Users', 'Bank holidays', 'Skills', 'Equipment', 'SSO']) {
      expect(navButton(label)).not.toBeInTheDocument();
    }
    expect(await screen.findByText('General panel')).toBeInTheDocument();
  });

  it('does not open for plain users', () => {
    setRole('user');
    act(() => useUIStore.getState().openSettings('users'));
    render(<SettingsHub />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back to the first allowed section when the requested one is admin-only', async () => {
    setRole('superuser');
    act(() => useUIStore.getState().openModal('ssoConfig'));
    render(<SettingsHub />);
    expect(sectionTitle()).toBe('General');
    expect(await screen.findByText('General panel')).toBeInTheDocument();
  });

  it('opens General for superusers from the legacy "settings" key', async () => {
    setRole('superuser');
    act(() => useUIStore.getState().openModal('settings'));
    render(<SettingsHub />);
    expect(sectionTitle()).toBe('General');
    expect(await screen.findByText('General panel')).toBeInTheDocument();
  });

  it.each([
    ['userManagement', 'Users'],
    ['manageSites', 'Sites'],
    ['siteManagement', 'Sites'],
    ['manageEquipment', 'Equipment'],
    ['predefinedPhases', 'Predefined phases'],
    ['ssoConfig', 'SSO'],
    ['settings', 'General'],
    ['bankHoliday', 'Bank holidays'],
    ['companyEvent', 'Company events'],
  ] as const)('opens the hub at the right section for the legacy "%s" key', async (key, title) => {
    setRole('admin');
    act(() => useUIStore.getState().setActiveModal(key));
    render(<SettingsHub />);

    expect(useUIStore.getState().activeModal).toBe('settingsHub');
    expect(sectionTitle()).toBe(title);
    expect(await screen.findByText(`${title} panel`)).toBeInTheDocument();
  });

  it('turns the legacy add keys into an "add" intent', () => {
    act(() => useUIStore.getState().openModal('customHoliday'));
    expect(useUIStore.getState()).toMatchObject({
      activeModal: 'settingsHub',
      settingsSection: 'bank-holidays',
      settingsIntent: { type: 'add' },
    });
  });

  it('is not rendered through a legacy key or openSettings during What-If', async () => {
    setRole('admin');
    useWhatIfStore.getState().enterWhatIfMode([]);
    try {
      act(() => useUIStore.getState().setActiveModal('userManagement'));
      act(() => useUIStore.getState().openModal('manageEquipment'));
      act(() => useUIStore.getState().openSettings('sites'));
      render(<SettingsHub />);
      expect(useUIStore.getState().activeModal).toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      await useWhatIfStore.getState().exitWhatIfMode(false);
    }
  });

  it('opens the Sites section for the legacy "site" key', () => {
    act(() => useUIStore.getState().openModal('site'));
    expect(useUIStore.getState()).toMatchObject({
      activeModal: 'settingsHub',
      settingsSection: 'sites',
      settingsIntent: null,
    });
  });

  it('switches section from the list', async () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('general'));
    render(<SettingsHub />);

    fireEvent.click(navButton('Skills')!);
    expect(sectionTitle()).toBe('Skills');
    expect(await screen.findByText('Skills panel')).toBeInTheDocument();
    expect(useUIStore.getState().settingsSection).toBe('skills');
  });

  it('closes on Escape', () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('users'));
    render(<SettingsHub />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT close when the backdrop is clicked', () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('users'));
    render(<SettingsHub />);

    fireEvent.click(screen.getByRole('dialog'));
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('asks before leaving General with unsaved changes', async () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('general'));
    render(<SettingsHub />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make dirty' }));

    let answer = false;
    const confirmSpy = stubConfirm(() => answer);

    await act(async () => {
      fireEvent.click(navButton('Users')!);
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'You have unsaved changes. Discard them and switch section?',
        confirmLabel: 'Discard',
      })
    );
    expect(sectionTitle()).toBe('General');

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(confirmSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'You have unsaved changes. Are you sure you want to close?' })
    );
    expect(useUIStore.getState().activeModal).toBe('settingsHub');

    answer = true;
    await act(async () => {
      fireEvent.click(navButton('Users')!);
    });
    expect(sectionTitle()).toBe('Users');
    expect(await screen.findByText('Users panel')).toBeInTheDocument();
  });

  it('switches through the compact section select only once the discard is confirmed', async () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('general'));
    render(<SettingsHub />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make dirty' }));

    const confirmSpy = stubConfirm(false);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'users' } });
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(sectionTitle()).toBe('General');

    confirmSpy.mockResolvedValue(true);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'users' } });
    });
    await waitFor(() => expect(sectionTitle()).toBe('Users'));
  });

  it('keeps the unsaved-changes guard when the global Escape shortcut is mounted', async () => {
    setRole('admin');
    act(() => useUIStore.getState().openSettings('general'));
    render(<HubWithShortcuts />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make dirty' }));

    const confirmSpy = stubConfirm(false);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    confirmSpy.mockResolvedValue(true);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});

describe('canOpenSettings / getVisibleSections', () => {
  it('opens only with a key that lists a section other than General', () => {
    expect(canOpenSettings(makeUser({ role: 'admin' }))).toBe(true);
    expect(canOpenSettings(makeUser({ role: 'superuser' }))).toBe(true);
    expect(canOpenSettings(makeUser({ role: 'user' }))).toBe(false);
    expect(canOpenSettings(makeUser({ role: 'x', permissions: ['settings.sso'] }))).toBe(true);
    expect(canOpenSettings(null)).toBe(false);
    expect(getVisibleSections(makeUser({ role: 'user' }))).toEqual([]);
  });

  it('lists Sites with either sites.manage or sites.export', () => {
    const ids = (permissions: string[]) =>
      getVisibleSections(makeUser({ role: 'x', permissions })).map((s) => s.id);
    expect(ids(['sites.manage'])).toEqual(['general', 'sites']);
    expect(ids(['sites.export'])).toEqual(['general', 'sites']);
    expect(ids(['settings.sso', 'tags.manage'])).toEqual(['general', 'tags', 'sso']);
  });

  it('lists Roles with roles.manage, in the General group', async () => {
    const ids = (permissions: string[]) =>
      getVisibleSections(makeUser({ role: 'x', permissions })).map((s) => s.id);
    expect(ids(['roles.manage'])).toEqual(['general', 'roles']);
    expect(ids(['users.view'])).not.toContain('roles');
    const roles = getVisibleSections(makeUser({ role: 'admin' })).find((s) => s.id === 'roles');
    expect(roles).toMatchObject({ group: 'General', label: 'Roles', permission: 'roles.manage' });

    setRole('admin');
    act(() => useUIStore.getState().openSettings('roles'));
    render(<SettingsHub />);
    expect(await screen.findByText('Roles panel')).toBeInTheDocument();
  });
});
