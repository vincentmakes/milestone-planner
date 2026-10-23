/**
 * Shift+hover tooltip on Gantt bars: it appears only while Shift is held and
 * the pointer is over an actual bar (not its row, not a dependency link
 * zone), and summarises the phase / subphase / project under the cursor.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ShiftTooltip } from '../ShiftTooltip';
import { resetAllStores, useAppStore } from '@/stores';
import { makePhase, makeProject, makeSubphase, makeTag } from '@/test/factories';

const nested = makeSubphase({
  id: 31,
  name: 'Nested run',
  start_date: '2026-03-09',
  end_date: '2026-03-13',
  completion: 40,
});

const phase = makePhase({
  id: 20,
  name: 'Feasibility',
  start_date: '2026-03-02', // Monday
  end_date: '2026-03-13', // Friday of the following week
  staffAssignments: [
    { id: 1, staff_id: 4, staff_name: 'Bob Brown', allocation: 60, start_date: '', end_date: '' },
    { id: 2, staff_id: 9, allocation: 25, start_date: '', end_date: '' },
  ],
  children: [
    makeSubphase({ id: 30, name: 'Screening', start_date: '2026-03-02', end_date: '2026-03-06', completion: 100 }),
    makeSubphase({
      id: 32,
      name: 'Scale trials',
      start_date: '2026-03-09',
      end_date: '2026-03-13',
      completion: null,
      children: [nested],
    }),
  ],
});

const plainPhase = makePhase({
  id: 21,
  name: 'Reporting',
  start_date: '2026-03-16',
  end_date: '2026-03-20',
  completion: null,
});

function seed() {
  useAppStore.setState({
    projects: [
      makeProject({
        id: 10,
        name: 'Bioprocess Scale-Up',
        customer: 'Acme Pharma',
        pm_name: 'Pat Manager',
        confirmed: false,
        start_date: '',
        end_date: '',
        phases: [phase, plainPhase],
        staffAssignments: [{ id: 3, staff_id: 4, staff_name: 'Bob Brown', allocation: 10, start_date: '', end_date: '' }],
        tags: [makeTag({ id: 1 }), makeTag({ id: 2 }), makeTag({ id: 99 })],
      }),
      makeProject({ id: 11, name: 'No dates', start_date: '', end_date: '', phases: [] }),
      makeProject({ id: 12, name: 'Untouched', confirmed: true, start_date: '2026-01-05', end_date: '2026-01-09' }),
    ],
    bankHolidayDates: new Set(['2026-03-06']),
    tags: [
      makeTag({ id: 1, name: 'Pilot', sort_order: 1 }),
      makeTag({ id: 2, name: 'Urgent', sort_order: 0 }),
    ],
    instanceSettings: null,
  });
}

const rect = { left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON: () => ({}) };

function Bars() {
  return (
    <div>
      <div data-testid="phase-bar" data-phase-id="20" style={{ position: 'absolute' }}>
        <span data-testid="phase-label">Feasibility</span>
        <span data-testid="link-zone" className="linkZone" />
      </div>
      <div data-testid="subphase-bar" data-subphase-id="31" className="subphaseBar" />
      <div data-testid="project-bar" data-project-id="10" className="projectBar" />
      <div data-testid="empty-project-bar" data-project-id="11" className="projectBar" />
      <div data-testid="plain-project-bar" data-project-id="12" className="projectBar" />
      <div data-testid="phase-row" data-phase-id="20" className="row" />
      <div data-testid="nowhere" />
    </div>
  );
}

function setup() {
  seed();
  const utils = render(
    <>
      <Bars />
      <ShiftTooltip />
    </>
  );
  for (const el of utils.container.querySelectorAll<HTMLElement>('[data-testid]')) {
    el.getBoundingClientRect = () => rect as DOMRect;
  }
  return utils;
}

const holdShift = () => act(() => { fireEvent.keyDown(window, { key: 'Shift' }); });
const releaseShift = () => act(() => { fireEvent.keyUp(window, { key: 'Shift' }); });
const hover = (testId: string, x = 50, y = 10) =>
  act(() => { fireEvent.mouseMove(screen.getByTestId(testId), { clientX: x, clientY: y }); });

beforeEach(() => {
  resetAllStores();
});

describe('ShiftTooltip', () => {
  it('stays hidden while Shift is not held', () => {
    setup();
    hover('phase-bar');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
  });

  it('summarises a phase: project, period, calculated completion, work days and staff', () => {
    setup();
    holdShift();
    hover('phase-bar');

    expect(screen.getByText('Project:').nextSibling).toHaveTextContent('Bioprocess Scale-Up');
    expect(screen.getByText('Period:').nextSibling).toHaveTextContent('Mar 2, 2026 - Mar 13, 2026');
    // Screening 100 % and Scale trials (40 % from its nested child) weigh 5 days each
    expect(screen.getByText('70% (calc)')).toBeInTheDocument();
    // 10 weekdays, one of them a bank holiday
    expect(screen.getByText('Work days:').nextSibling).toHaveTextContent('9 days (excl. 1 hol.)');
    expect(screen.getByText('Total:').nextSibling).toHaveTextContent('12 days');
    expect(screen.getByText('Assigned Staff:')).toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Staff #9')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.queryByText('Parent:')).not.toBeInTheDocument();
  });

  it('follows the cursor while it stays on the same bar', () => {
    setup();
    holdShift();
    hover('phase-bar', 20, 5);
    const tooltip = screen.getByText('Period:').closest('div')!.parentElement as HTMLElement;
    expect(tooltip.style.left).toBe('35px');
    expect(tooltip.style.top).toBe('20px');

    hover('phase-label', 120, 15);
    expect(tooltip.style.left).toBe('135px');
    expect(tooltip.style.top).toBe('30px');
  });

  it('summarises a nested subphase with its parent phase and own completion', () => {
    setup();
    holdShift();
    hover('subphase-bar');
    expect(screen.getByText('Nested run')).toBeInTheDocument();
    expect(screen.getByText('Parent:').nextSibling).toHaveTextContent('Feasibility');
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('Work days:').nextSibling).toHaveTextContent('5 days');
    expect(screen.queryByText('Assigned Staff:')).not.toBeInTheDocument();
  });

  it('summarises a project: customer, PM, status, tags and dates derived from phases', () => {
    setup();
    holdShift();
    hover('project-bar');

    expect(screen.getByText('Customer:').nextSibling).toHaveTextContent('Acme Pharma');
    expect(screen.getByText('PM:').nextSibling).toHaveTextContent('Pat Manager');
    expect(screen.getByText('Unconfirmed')).toBeInTheDocument();
    // in tag order; a deleted tag is dropped
    const pills = screen.getByText('Tags:').nextSibling as HTMLElement;
    expect(Array.from(pills.children).map((p) => p.textContent)).toEqual(['Urgent', 'Pilot']);
    expect(screen.getByText('Period:').nextSibling).toHaveTextContent('Mar 2, 2026 - Mar 20, 2026');
    // (70 % x 12 days + 0 % x 5 days) / 17 days
    expect(screen.getByText('49% (calc)')).toBeInTheDocument();
    expect(screen.queryByText('Project:')).not.toBeInTheDocument();
  });

  it('names the customer with its label, and leaves it out while hidden', () => {
    setup();
    useAppStore.setState({ instanceSettings: { project_field_labels: '{"customer":"Client"}' } });
    holdShift();
    hover('project-bar');
    expect(screen.getByText('Client:').nextSibling).toHaveTextContent('Acme Pharma');
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
  });

  it('leaves out a hidden customer', () => {
    setup();
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["customer"]' } });
    holdShift();
    hover('project-bar');
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Pharma')).not.toBeInTheDocument();
    expect(screen.getByText('PM:')).toBeInTheDocument();
  });

  it('shows a dash for a confirmed project without completion and no tags', () => {
    setup();
    holdShift();
    hover('plain-project-bar');
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Tags:')).not.toBeInTheDocument();
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
  });

  it('shows nothing for a project without any dates', () => {
    setup();
    holdShift();
    hover('empty-project-bar');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
  });

  it('hides over link zones, rows, empty space and outside the bar bounds', () => {
    setup();
    holdShift();

    hover('phase-bar');
    expect(screen.getByText('Period:')).toBeInTheDocument();
    hover('link-zone');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();

    hover('phase-bar');
    hover('phase-row');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();

    hover('phase-bar');
    hover('nowhere');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();

    hover('phase-bar', 500, 10);
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
  });

  it('disappears when Shift is released and ignores other keys', () => {
    setup();
    holdShift();
    hover('phase-bar');
    act(() => { fireEvent.keyUp(window, { key: 'a' }); });
    expect(screen.getByText('Period:')).toBeInTheDocument();
    releaseShift();
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
    hover('phase-bar');
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
  });
});
