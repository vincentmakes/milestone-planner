/**
 * Header controls: site switching (reloads the site's holidays, events and
 * custom columns, clears column filters), period navigation and labels,
 * zoom buttons, and the light/dark toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SiteSelector } from '../SiteSelector';
import { DateNavigation } from '../DateNavigation';
import { ZoomControls } from '../ZoomControls';
import { ThemeToggle } from '../ThemeToggle';
import { getBankHolidays, getCompanyEvents, getCustomColumnsWithValues } from '@/api';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { useViewStore } from '@/stores/viewStore';
import { resetAllStores } from '@/stores';
import { makeCustomColumn, makeSite, makeUser } from '@/test/factories';
import type { BankHoliday, CompanyEvent } from '@/types';

vi.mock('@/api', async () => {
  const sites = await vi.importActual<typeof import('@/api/endpoints/sites')>('@/api/endpoints/sites');
  return {
    getBankHolidays: vi.fn(),
    getCompanyEvents: vi.fn(),
    getCustomColumnsWithValues: vi.fn(),
    buildHolidayDateSet: sites.buildHolidayDateSet,
    buildEventDateSet: sites.buildEventDateSet,
  };
});

const basel = makeSite({ id: 1, name: 'Basel' });
const zurich = makeSite({ id: 2, name: 'Zurich' });
const bern = makeSite({ id: 3, name: 'Bern' });

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
  vi.mocked(getBankHolidays).mockReset().mockResolvedValue([]);
  vi.mocked(getCompanyEvents).mockReset().mockResolvedValue([]);
  vi.mocked(getCustomColumnsWithValues).mockReset().mockResolvedValue({ columns: [], values: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('SiteSelector', () => {
  it('shows a plain label when the user has a single site', () => {
    useAppStore.setState({ sites: [basel, zurich], currentSite: basel, currentUser: makeUser({ role: 'user', site_ids: [1] }) });
    render(<SiteSelector />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Basel')).toBeInTheDocument();
  });

  it('renders nothing without sites or a current site', () => {
    useAppStore.setState({ sites: [], currentSite: null, currentUser: makeUser() });
    const view = render(<SiteSelector />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('offers only the user’s sites; sites.view_all sees all', () => {
    useAppStore.setState({ sites: [basel, zurich, bern], currentSite: basel, currentUser: makeUser({ role: 'superuser', site_ids: [1, 2] }) });
    const view = render(<SiteSelector />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Basel', 'Zurich']);
    view.unmount();
    useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) });
    render(<SiteSelector />);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('switches site and reloads its calendar and custom columns', async () => {
    const holiday = { id: 1, site_id: 2, date: '2026-08-01', name: 'National Day' } as BankHoliday;
    const event = { id: 2, site_id: 2, date: '2026-09-10', name: 'Audit' } as CompanyEvent;
    const column = makeCustomColumn({ site_id: 2 });
    vi.mocked(getBankHolidays).mockResolvedValue([holiday]);
    vi.mocked(getCompanyEvents).mockResolvedValue([event]);
    vi.mocked(getCustomColumnsWithValues).mockResolvedValue({ columns: [column], values: { '1-project-1': 'High' } });
    useAppStore.setState({ sites: [basel, zurich], currentSite: basel, currentUser: makeUser({ role: 'admin' }) });
    useCustomColumnStore.setState({ customColumnFilters: { 1: ['High'] } });
    useUndoStore.getState().saveState([], 'edit');

    render(<SiteSelector />);
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    });

    expect(useAppStore.getState().currentSite?.id).toBe(2);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(useCustomColumnStore.getState().customColumnFilters).toEqual({});
    expect(getBankHolidays).toHaveBeenCalledWith(2);
    expect(useAppStore.getState().bankHolidayDates).toEqual(new Set(['2026-08-01']));
    expect(useAppStore.getState().companyEventDates).toEqual(new Set(['2026-09-10']));
    expect(useCustomColumnStore.getState().customColumns).toEqual([column]);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({ '1-project-1': 'High' });
  });

  it('keeps going when one of the reloads fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getBankHolidays).mockRejectedValue(new Error('h'));
    vi.mocked(getCompanyEvents).mockRejectedValue(new Error('e'));
    vi.mocked(getCustomColumnsWithValues).mockRejectedValue(new Error('c'));
    useAppStore.setState({ sites: [basel, zurich], currentSite: basel, currentUser: makeUser({ role: 'admin' }) });
    render(<SiteSelector />);
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    });
    expect(useAppStore.getState().currentSite?.id).toBe(2);
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith('[DataLoader] Failed to load custom columns:', expect.any(Error));
  });
});

describe('DateNavigation', () => {
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 12);
  const label = () => screen.getByRole('button', { name: 'Previous period' }).nextSibling?.textContent;

  it.each([
    ['week', at(2026, 2, 18), 'Next period', at(2026, 2, 25)],
    ['month', at(2026, 0, 15), 'Previous period', at(2025, 11, 15)],
    ['quarter', at(2026, 4, 10), 'Next period', at(2026, 7, 10)],
    ['year', at(2026, 4, 10), 'Previous period', at(2025, 4, 10)],
  ] as const)('steps a %s by one period', (mode, start, button, expected) => {
    useViewStore.setState({ viewMode: mode, currentDate: start });
    render(<DateNavigation />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(useViewStore.getState().currentDate.toDateString()).toBe(expected.toDateString());
  });

  it('labels quarters and years', () => {
    useViewStore.setState({ viewMode: 'quarter', currentDate: at(2026, 4, 10) });
    const view = render(<DateNavigation />);
    expect(label()).toBe('Q2 2026');
    act(() => useViewStore.setState({ viewMode: 'year' }));
    expect(label()).toBe('2026');
    view.unmount();
  });

  it('uses the long or short month name', () => {
    useViewStore.setState({ viewMode: 'month', currentDate: at(2026, 7, 3) });
    const long = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(at(2026, 7, 3));
    const short = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(at(2026, 7, 3));
    const view = render(<DateNavigation />);
    expect(label()).toBe(long);
    view.rerender(<DateNavigation shortLabel />);
    expect(label()).toBe(short);
  });

  it('labels a week by its Monday', () => {
    useViewStore.setState({ viewMode: 'week', currentDate: at(2026, 2, 19) }); // Thursday
    render(<DateNavigation />);
    const monday = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(at(2026, 2, 16));
    expect(label()).toBe(monday);
  });

  it('jumps to today and asks the timeline to scroll there', () => {
    useViewStore.setState({ currentDate: at(2000, 0, 1) });
    render(<DateNavigation />);
    const before = useUIStore.getState().scrollToTodayTrigger;
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(useViewStore.getState().currentDate.toDateString()).toBe(new Date().toDateString());
    expect(useUIStore.getState().scrollToTodayTrigger).toBe(before + 1);
  });
});

describe('ZoomControls', () => {
  it('zooms in and out in 4px steps and shows the level relative to 36px', () => {
    useViewStore.setState({ cellWidth: 36 });
    render(<ZoomControls />);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useViewStore.getState().cellWidth).toBe(40);
    expect(useUIStore.getState().zoomTrigger).toMatchObject({ direction: 1, newCellWidth: 40 });
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('111%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(useViewStore.getState().cellWidth).toBe(32);
    expect(useUIStore.getState().zoomTrigger).toMatchObject({ direction: -1, newCellWidth: 32 });
  });

  it('resets towards 100% from either side and is a no-op at 100%', () => {
    useViewStore.setState({ cellWidth: 60 });
    render(<ZoomControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(useViewStore.getState().cellWidth).toBe(36);
    expect(useUIStore.getState().zoomTrigger).toMatchObject({ direction: -1, newCellWidth: 36 });

    act(() => useUIStore.getState().clearZoomTrigger());
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(useUIStore.getState().zoomTrigger).toBeNull();

    act(() => useViewStore.setState({ cellWidth: 20 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(useUIStore.getState().zoomTrigger).toMatchObject({ direction: 1, newCellWidth: 36 });
  });

  it('disables the buttons at the limits', () => {
    useViewStore.setState({ cellWidth: 120 });
    const view = render(<ZoomControls />);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    view.unmount();
    useViewStore.setState({ cellWidth: 12 });
    render(<ZoomControls />);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  });

  it('clamps a step that would overshoot a limit', () => {
    useViewStore.setState({ cellWidth: 118 });
    render(<ZoomControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(useViewStore.getState().cellWidth).toBe(120);
  });
});

describe('ThemeToggle', () => {
  it('toggles between dark and light and persists the choice', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to light mode' });
    fireEvent.click(button);
    expect(localStorage.getItem('milestone_theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });

  it('follows a theme change made elsewhere', async () => {
    render(<ThemeToggle />);
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 's-theme-light');
    });
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });
});
