/**
 * Custom-column *definitions* are admin-only on the backend (require_admin),
 * so the definition UI is only offered to admins: the "Manage Custom Columns"
 * button, the header double-click editor and the width resize handle.
 * Filtering a column stays available to everyone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectPanel } from '../ProjectPanel/ProjectPanel';
import { CustomColumnHeader } from '../CustomColumns/CustomColumnHeader';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import type { CustomColumn, UserRole } from '@/types';

const updateCustomColumn = vi.fn();
vi.mock('@/api', () => ({
  updateCustomColumn: (...args: unknown[]) => updateCustomColumn(...args),
}));

vi.mock('@/hooks', () => ({
  useDataLoader: () => ({ refreshCustomColumns: vi.fn() }),
}));

vi.mock('@/components/modals', () => ({
  CustomColumnModal: () => null,
  CustomColumnsManagerModal: () => null,
}));

const column: CustomColumn = {
  id: 3,
  name: 'Priority',
  column_type: 'text',
  list_options: null,
  site_id: null,
  display_order: 0,
  width: 120,
} as unknown as CustomColumn;

function seedUser(role: UserRole) {
  useAppStore.setState({
    currentUser: { id: 1, name: 'Someone', role } as never,
    currentSite: { id: 1, name: 'Basel' } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCustomColumnStore.setState({ customColumns: [], customColumnValues: {}, customColumnFilters: {} });
});

describe('ProjectPanel "Manage Custom Columns"', () => {
  it('is offered to admins', () => {
    seedUser('admin');
    render(<ProjectPanel projects={[]} width={320} />);
    expect(screen.getByTitle('Manage Custom Columns')).toBeInTheDocument();
  });

  it('is hidden from superusers, who still get New Project', () => {
    seedUser('superuser');
    render(<ProjectPanel projects={[]} width={320} />);
    expect(screen.queryByTitle('Manage Custom Columns')).not.toBeInTheDocument();
    expect(screen.getByTitle('New Project')).toBeInTheDocument();
  });
});

describe('ProjectPanel header accessible names', () => {
  it('names every icon button, hides its svg and exposes the overview toggle state', () => {
    seedUser('admin');
    useCustomColumnStore.setState({ customColumns: [column] });
    render(<ProjectPanel projects={[]} width={320} />);

    // The overview is shown by default; the pressed state follows the toggle
    const toggle = screen.getByRole('button', { name: 'Show staff and equipment' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show staff and equipment' })).toHaveAttribute('aria-pressed', 'false');

    const visibility = screen.getByRole('button', { name: 'Column visibility' });
    expect(visibility).toHaveAttribute('aria-haspopup', 'dialog');
    expect(visibility).toHaveAttribute('aria-expanded', 'false');

    for (const name of ['Manage custom columns', 'Import project', 'New project']) {
      const btn = screen.getByRole('button', { name });
      expect(btn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

describe('ProjectPanel column visibility dropdown', () => {
  it('is a dialog that Escape closes, focus back on the trigger', () => {
    seedUser('admin');
    useCustomColumnStore.setState({ customColumns: [column] });
    render(<ProjectPanel projects={[]} width={320} />);
    const trigger = screen.getByRole('button', { name: 'Column visibility' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Column visibility' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Column visibility' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('ProjectPanel header grouping', () => {
  it('separates the view controls from the actions with a divider for admins', () => {
    seedUser('admin');
    render(<ProjectPanel projects={[]} width={320} />);
    expect(screen.getByTestId('header-divider')).toBeInTheDocument();
  });

  it('gives superusers the divider and the actions group minus Manage Columns', () => {
    seedUser('superuser');
    render(<ProjectPanel projects={[]} width={320} />);
    expect(screen.getByTestId('header-divider')).toBeInTheDocument();
    expect(screen.getByTitle('Import Project')).toBeInTheDocument();
    expect(screen.getByTitle('New Project')).toBeInTheDocument();
    expect(screen.queryByTitle('Manage Custom Columns')).not.toBeInTheDocument();
    // The tag filter belongs to the view controls, before the divider.
    const divider = screen.getByTestId('header-divider');
    const tagTrigger = screen.getByRole('button', { name: 'Tags' });
    expect(tagTrigger.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no divider to a plain user, who has no actions', () => {
    seedUser('user');
    render(<ProjectPanel projects={[]} width={320} />);
    expect(screen.queryByTestId('header-divider')).not.toBeInTheDocument();
    expect(screen.queryByTitle('New Project')).not.toBeInTheDocument();
  });
});

describe('CustomColumnHeader definition controls', () => {
  const renderHeader = () => {
    const onEdit = vi.fn();
    const onWidthChange = vi.fn();
    render(<CustomColumnHeader column={column} onEdit={onEdit} onWidthChange={onWidthChange} />);
    return { onEdit, onWidthChange, header: screen.getByText('Priority').closest('div')!.parentElement! };
  };

  it('opens the value filter as a dialog named after the column; Escape closes it', () => {
    seedUser('user');
    renderHeader();
    const trigger = screen.getByRole('button', { name: 'Filter Priority' });
    expect(trigger).toHaveAttribute('title', 'Filter column');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Filter Priority' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filter Priority' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('opens the editor on double-click and offers resizing for admins', () => {
    seedUser('admin');
    const { onEdit, header } = renderHeader();
    fireEvent.doubleClick(header);
    expect(onEdit).toHaveBeenCalledWith(column);
    expect(screen.getByTestId('custom-column-resize-handle')).toBeInTheDocument();
  });

  it('persists the width the column was resized to, not the starting width', async () => {
    seedUser('admin');
    renderHeader();
    const handle = screen.getByTestId('custom-column-resize-handle');
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150 });
    fireEvent.mouseUp(document);
    await vi.waitFor(() => expect(updateCustomColumn).toHaveBeenCalledWith(3, { width: 170 }));
  });

  it.each(['superuser', 'user'] as const)('offers neither to a %s', (role) => {
    seedUser(role);
    const { onEdit, header } = renderHeader();
    fireEvent.doubleClick(header);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('custom-column-resize-handle')).not.toBeInTheDocument();
    // Filtering is not a definition change and stays available
    expect(screen.getByTitle('Filter column')).toBeInTheDocument();
  });
});
