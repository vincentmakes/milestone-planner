/**
 * The Gantt body draws the shared holiday / event strip (TimelineMarkers) at
 * every zoom, for the current site; the old CSS tooltip cells are gone. The
 * background tints stay at week and month zoom only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TimelineBody } from '../TimelineBody';
import { generateTimelineCells } from '../../utils';
import { useAppStore } from '@/stores/appStore';
import { makeSite, makeTeam, makeUser } from '@/test/factories';
import type { Project, ViewMode } from '@/types';

vi.mock('../ProjectTimeline', () => ({
  ProjectTimeline: ({ project }: { project: Project }) => <div data-project-id={project.id} />,
}));
vi.mock('../DependencyLayer', () => ({ DependencyLayer: () => null }));

const EVENTS = [
  { id: 1, date: '2026-04-08', name: 'ISO 9001 audit', color: '#f59e0b' },
  { id: 2, date: '2026-04-08', name: 'Instrument calibration day', color: '#a855f7', team_ids: [10] },
];

function renderBody(viewMode: ViewMode) {
  const cells = generateTimelineCells(
    new Date(2026, 3, 8),
    viewMode,
    new Set(),
    [],
    new Set(['2026-04-08']),
    EVENTS
  );
  const project = { id: 1, name: 'P1', phases: [], staffAssignments: [], equipmentAssignments: [] } as unknown as Project;
  return render(
    <TimelineBody
      cells={cells}
      projects={[project]}
      cellWidth={30}
      totalWidth={cells.length * 30}
      viewMode={viewMode}
    />
  );
}

beforeEach(() => {
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    currentUser: makeUser({ role: 'user' }),
    teams: [makeTeam({ id: 10, site_id: 1, name: 'Analytical Lab' })],
  });
});

describe('TimelineBody event strip', () => {
  it.each(['week', 'month', 'quarter', 'year'] as ViewMode[])('draws the strip at %s zoom', (mode) => {
    const { container } = renderBody(mode);
    const layer = container.querySelector('[class*="markerLayer"]');
    expect(layer).not.toBeNull();
    const hits = layer!.querySelectorAll('button[aria-haspopup="dialog"]');
    expect(hits).toHaveLength(1);
    expect(hits[0].getAttribute('aria-label')).toMatch(/2 events: ISO 9001 audit, Instrument calibration day$/);
    expect(container.querySelector('[data-tooltip]')).toBeNull();
    expect(container.querySelector('[class*="tooltip"]')).toBeNull();
  });

  it('names the teams of the current site in the panel', () => {
    const { container } = renderBody('quarter');
    fireEvent.click(container.querySelector('[class*="markerBadge"]')!);
    expect(within(screen.getByRole('dialog')).getByText('Teams: Analytical Lab')).toBeInTheDocument();
  });

  it('keeps the background tints at week and month zoom only', () => {
    expect(renderBody('month').container.querySelector('[class*="companyEvent"]')).not.toBeNull();
    expect(renderBody('quarter').container.querySelector('[class*="companyEvent"]')).toBeNull();
  });
});
