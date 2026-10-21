/**
 * Cross-site overview: every site with its active projects, the current
 * site's projects shown in full and other sites' masked as confidential,
 * bars on the shared timeline with calendar highlighting, and today on open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CrossSiteView } from '../CrossSiteView';
import { CrossSiteTimelineBody } from '../CrossSiteTimelineBody';
import type { CrossSiteRow } from '../CrossSiteView';
import { generateTimelineCells } from '@/components/gantt/utils';
import { resetAllStores, useAppStore, useUIStore, useViewStore } from '@/stores';
import { formatDateISO } from '@/utils/date';
import { makeProject, makeSite, makeTeam, makeUser } from '@/test/factories';
import { tagFilterKey } from '@/utils/tags';
import { buildEventDateSet } from '@/api';
import type { CompanyEvent } from '@/types';

const basel = makeSite({ id: 1, name: 'Basel' });
const zurich = makeSite({ id: 2, name: 'Zurich' });

function iso(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return formatDateISO(d);
}

beforeEach(() => {
  resetAllStores();
  useViewStore.setState({ viewMode: 'month', cellWidth: 30, currentDate: new Date() });
  useAppStore.setState({
    currentUser: makeUser({ role: 'admin' }),
    sites: [basel, zurich],
    currentSite: basel,
    projects: [
      makeProject({ id: 1, name: 'Zeta Upgrade', site_id: 1, customer: 'Acme', start_date: iso(-5), end_date: iso(5) }),
      makeProject({ id: 2, name: 'Alpha Study', site_id: 1, customer: null, confirmed: false, start_date: iso(1), end_date: iso(9) }),
      makeProject({ id: 3, name: 'Secret Pilot', site_id: 2, customer: 'Rival', start_date: iso(-2), end_date: iso(3) }),
      makeProject({ id: 4, name: 'Archived One', site_id: 1, archived: true }),
      makeProject({ id: 5, name: 'Undated', site_id: 2, start_date: '', end_date: '' }),
    ],
  });
});

describe('CrossSiteView', () => {
  it('lists each site with its active projects, masking other sites', () => {
    const { container } = render(<CrossSiteView />);
    expect(screen.getByText('Cross-Site Overview')).toBeInTheDocument();
    expect(screen.getByText('Basel')).toBeInTheDocument();
    expect(screen.getAllByText('2 projects')).toHaveLength(2);

    // current site: real names, sorted, with customer
    const panel = container.querySelector('[class*="panelBody"]')!;
    expect(panel.textContent).toMatch(/Alpha Study.*Zeta Upgrade.*Acme/);
    expect(screen.queryByText('Archived One')).not.toBeInTheDocument();
    // other site: masked
    expect(screen.queryByText('Secret Pilot')).not.toBeInTheDocument();
    expect(screen.queryByText('Rival')).not.toBeInTheDocument();
    expect(screen.getAllByText('Confidential Project')).toHaveLength(2);
    expect(screen.getAllByText('***')).toHaveLength(2);
  });

  it('lists only the sites the user can see', () => {
    const bern = makeSite({ id: 3, name: 'Bern' });
    useAppStore.setState({ sites: [basel, zurich, bern], currentUser: makeUser({ role: 'user', site_ids: [1, 3] }) });
    render(<CrossSiteView />);
    expect(screen.getByText('Basel')).toBeInTheDocument();
    expect(screen.getByText('Bern')).toBeInTheDocument();
    expect(screen.queryByText('Zurich')).not.toBeInTheDocument();
  });

  it('draws bars, labelled only for the current site', () => {
    render(<CrossSiteView />);
    expect(screen.getByTitle('Zeta Upgrade')).toHaveTextContent('Zeta Upgrade');
    expect(screen.getByTitle('Alpha Study').className).toMatch(/unconfirmed/);
    const masked = screen.getByTitle('Confidential');
    expect(masked).toHaveTextContent('Project');
    expect(masked.className).toMatch(/masked/);
    // the undated project has no bar
    expect(screen.getAllByTitle(/Confidential|Zeta|Alpha/)).toHaveLength(3);
  });

  it('opens on today and scrolls back to it on request', async () => {
    const { container } = render(<CrossSiteView />);
    const scroller = container.querySelector('[class*="timelineScroll"]') as HTMLDivElement;
    scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo;
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(scroller.scrollLeft).toBeGreaterThan(0);

    act(() => useUIStore.getState().triggerScrollToToday());
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  it('with an active team filter, narrows only the current site\'s lane', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 2, name: 'Zurich lab' })],
      projects: useAppStore.getState().projects.map((p) => ({ ...p, team_ids: p.id === 1 ? [1] : [] })),
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<CrossSiteView />);
    expect(screen.getByTitle('Zeta Upgrade')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Study')).not.toBeInTheDocument();
    expect(screen.getByText('1 projects')).toBeInTheDocument();
    // The other site's lane is unchanged
    expect(screen.getByText('2 projects')).toBeInTheDocument();
    expect(screen.getAllByText('Confidential Project')).toHaveLength(2);
  });

  it('with an active team filter, drops company events of other teams from the timeline', () => {
    const teamEvents: CompanyEvent[] = [
      { id: 81, site_id: 1, site_ids: [1], date: iso(2), end_date: null, name: 'Team B review', team_ids: [2] },
      { id: 82, site_id: 1, site_ids: [1], date: iso(3), end_date: null, name: 'Site audit', team_ids: [] },
    ];
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
      companyEvents: teamEvents,
      companyEventDates: buildEventDateSet(teamEvents),
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<CrossSiteView />);
    expect(screen.getAllByTitle('Site audit').length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle('Team B review')).toHaveLength(0);

    act(() => useViewStore.setState({ teamFilters: {} }));
    expect(screen.getAllByTitle('Team B review').length).toBeGreaterThan(0);
  });
});

describe('CrossSiteTimelineBody', () => {
  const cells = generateTimelineCells(
    new Date(2026, 7, 1),
    'month',
    new Set(['2026-08-01']),
    [{ date: '2026-08-01', name: 'National Day' }],
    new Set(['2026-08-05', '2026-08-06']),
    [
      { date: '2026-08-05', name: 'Audit', color: '#ff0000' },
      { date: '2026-08-06', name: 'Shutdown', counts_as_unavailable: true },
    ]
  );
  const rows: CrossSiteRow[] = [{ type: 'site', site: basel, isCurrentSite: false, projectCount: 0 }];

  it('highlights weekends, holidays and events with tooltips in day views', () => {
    const { container } = render(
      <CrossSiteTimelineBody rows={rows} cells={cells} cellWidth={20} totalWidth={cells.length * 20} viewMode="month" />
    );
    expect(container.querySelectorAll('[class*="weekend"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-tooltip="National Day"]')).not.toBeNull();
    expect(container.querySelector('[data-tooltip="Audit"]')).not.toBeNull();
    expect(container.querySelector('[data-tooltip="Site closed: Shutdown"]')).not.toBeNull();
    expect(container.querySelector('[class*="siteClosure"]')).not.toBeNull();
  });

  it('hides weekends when the instance does, and highlighting in coarse views', () => {
    useAppStore.setState({ instanceSettings: { show_weekends: 'false' } as never });
    const { container, rerender } = render(
      <CrossSiteTimelineBody rows={rows} cells={cells} cellWidth={20} totalWidth={cells.length * 20} viewMode="month" />
    );
    expect(container.querySelector('[class*="weekend"]')).toBeNull();
    expect(container.querySelector('[data-tooltip="National Day"]')).not.toBeNull();

    rerender(
      <CrossSiteTimelineBody rows={rows} cells={cells} cellWidth={20} totalWidth={cells.length * 20} viewMode="quarter" />
    );
    expect(container.querySelector('[data-tooltip]')).toBeNull();
  });
});
