/**
 * The Gantt draws the shared holiday / event strip (TimelineMarkers) once, in
 * the header's events row — never in the body, where it would cover the first
 * row's bars. The body keeps the background tints at week and month zoom only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TimelineBody } from '../TimelineBody';
import { Timeline } from '../Timeline';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
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
const project = { id: 1, name: 'P1', phases: [], staffAssignments: [], equipmentAssignments: [] } as unknown as Project;

const cellsFor = (viewMode: ViewMode) =>
  generateTimelineCells(new Date(2026, 3, 8), viewMode, new Set(), [], new Set(['2026-04-08']), EVENTS);

function renderBody(viewMode: ViewMode) {
  const cells = cellsFor(viewMode);
  return render(
    <TimelineBody cells={cells} projects={[project]} cellWidth={30} totalWidth={cells.length * 30} viewMode={viewMode} />
  );
}

beforeEach(() => {
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    currentUser: makeUser({ role: 'user' }),
    teams: [makeTeam({ id: 10, site_id: 1, name: 'Analytical Lab' })],
  });
});

describe('Gantt event strip', () => {
  it.each(['week', 'month', 'quarter', 'year'] as ViewMode[])(
    'draws the strip exactly once, in the header, at %s zoom',
    (mode) => {
      const cells = cellsFor(mode);
      const { container } = render(
        <Timeline
          cells={cells}
          headers={generateTimelineHeaders(cells, mode)}
          projects={[project]}
          cellWidth={30}
          viewMode={mode}
        />
      );
      const layers = container.querySelectorAll('[class*="markerLayer"]');
      expect(layers).toHaveLength(1);
      expect(layers[0].closest('[class*="eventsRow"]')).not.toBeNull();
      const hits = layers[0].querySelectorAll('button[aria-haspopup="dialog"]');
      expect(hits).toHaveLength(1);
      expect(hits[0].getAttribute('aria-label')).toMatch(/2 events: ISO 9001 audit, Instrument calibration day$/);
      expect(container.querySelector('[data-tooltip]')).toBeNull();
    }
  );

  it.each(['week', 'quarter'] as ViewMode[])('leaves the body without a strip at %s zoom', (mode) => {
    const { container } = renderBody(mode);
    expect(container.querySelector('[class*="markerLayer"]')).toBeNull();
    expect(container.querySelector('[class*="markerBadge"]')).toBeNull();
  });

  it('keeps the background tints at week and month zoom only', () => {
    expect(renderBody('month').container.querySelector('[class*="companyEvent"]')).not.toBeNull();
    expect(renderBody('quarter').container.querySelector('[class*="companyEvent"]')).toBeNull();
  });
});
