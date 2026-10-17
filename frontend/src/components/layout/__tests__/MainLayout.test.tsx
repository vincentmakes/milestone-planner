/**
 * MainLayout renders the view selected in viewStore.currentView (views are
 * state, not URLs) next to the real sidebar; switching through the sidebar
 * swaps the main view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MainLayout } from '../MainLayout';
import { useViewStore } from '@/stores/viewStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { useKeyboardShortcuts } from '@/hooks';
import { makeUser } from '@/test/factories';
import type { CurrentView } from '@/types';

vi.mock('@/hooks', () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock('../Header', () => ({ Header: () => <header>Header</header> }));
vi.mock('@/components/gantt', () => ({ GanttContainer: () => <div>Gantt view</div> }));
vi.mock('@/components/gantt/ShiftTooltip', () => ({ ShiftTooltip: () => null }));
vi.mock('@/components/views', () => ({
  KanbanView: () => <div>Kanban view</div>,
  StaffView: () => <div>Staff view</div>,
  EquipmentView: () => <div>Equipment view</div>,
  CrossSiteView: () => <div>Cross-site view</div>,
  ArchivedView: () => <div>Archived view</div>,
}));

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('MainLayout', () => {
  it.each<[CurrentView, string]>([
    ['gantt', 'Gantt view'],
    ['kanban', 'Kanban view'],
    ['staff', 'Staff view'],
    ['equipment', 'Equipment view'],
    ['crosssite', 'Cross-site view'],
    ['archived', 'Archived view'],
    ['unknown' as CurrentView, 'Gantt view'],
  ])('renders the %s view', (view, text) => {
    useViewStore.setState({ currentView: view });
    render(<MainLayout />);
    expect(screen.getByRole('main')).toHaveTextContent(text);
    expect(screen.getByText('Header')).toBeInTheDocument();
    expect(useKeyboardShortcuts).toHaveBeenCalled();
  });

  it('switches views from the sidebar navigation', async () => {
    render(<MainLayout />);
    expect(screen.getByRole('main')).toHaveTextContent('Gantt view');
    fireEvent.click(screen.getByRole('button', { name: 'Staff Overview' }));
    expect(useViewStore.getState().currentView).toBe('staff');
    expect(screen.getByRole('main')).toHaveTextContent('Staff view');
  });

  it('stays on the Gantt while What-If is active', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) });
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<MainLayout />);
    fireEvent.click(screen.getByRole('button', { name: 'Staff Overview' }));
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(screen.getByRole('main')).toHaveTextContent('Gantt view');
  });
});
