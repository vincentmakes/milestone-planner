/**
 * The archived view's edit button opens the project editor (which can also
 * unarchive the project), so it is offered to project editors only:
 * admins, superusers and the project's manager (utils/permissions.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArchivedView } from '../ArchivedView';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import type { Project } from '@/types';

vi.mock('@/hooks', () => ({
  useScrollSync: vi.fn(),
}));

const archived = {
  id: 5,
  name: 'Legacy Assay',
  site_id: 1,
  pm_id: 42,
  pm_name: 'Pat Manager',
  customer: 'Acme',
  confirmed: true,
  archived: true,
  start_date: '2025-01-01',
  end_date: '2025-06-30',
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

function seed(user: { id: number; role: 'admin' | 'superuser' | 'user' }) {
  useAppStore.setState({
    projects: [archived],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: { name: 'Someone', ...user } as never,
  });
}

const editButton = () => screen.queryByTitle('Edit project');

beforeEach(() => {
  useUIStore.setState({ activeModal: null, editingProject: null });
});

describe('ArchivedView edit button', () => {
  it.each(['admin', 'superuser'] as const)('is offered to a %s and opens the editor', (role) => {
    seed({ id: 1, role });
    render(<ArchivedView />);

    fireEvent.click(editButton()!);
    expect(useUIStore.getState().activeModal).toBe('project');
    expect(useUIStore.getState().editingProject?.id).toBe(5);
  });

  it("is offered to the project's manager", () => {
    seed({ id: 42, role: 'user' });
    render(<ArchivedView />);
    expect(editButton()).toBeInTheDocument();
  });

  it('is hidden from a plain user who does not manage the project', () => {
    seed({ id: 7, role: 'user' });
    render(<ArchivedView />);
    expect(screen.getByText('Legacy Assay')).toBeInTheDocument();
    expect(editButton()).not.toBeInTheDocument();
  });
});
