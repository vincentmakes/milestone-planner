/**
 * Shift+hover tooltip on Gantt bars: it appears only while Shift is held and
 * the pointer is over an actual bar (not its row, not a dependency link
 * zone), and summarises the phase / subphase / project under the cursor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ShiftTooltip } from '../ShiftTooltip';
import { resetAllStores, useAppStore } from '@/stores';
import {
  makePhase,
  makeProject,
  makeProjectField,
  makeProjectFieldOption,
  makeSubphase,
  makeTag,
} from '@/test/factories';
import { formatFieldNumber } from '@/utils/projectFields';

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
      makeProject({
        id: 13,
        name: 'Fielded',
        customer: 'Acme Pharma',
        pm_name: 'Pat Manager',
        sales_pm: 'Sam Seller',
        volume: 12.7,
        confirmed: true,
        start_date: '2026-01-05',
        end_date: '2026-01-09',
        field_values: {
          40: '  Pilot plant  ',
          41: 3.25,
          42: false,
          43: 51,
          44: [52, 99, 51],
          45: '   ',
          77: 'orphan value',
        },
      }),
    ],
    bankHolidayDates: new Set(['2026-03-06']),
    tags: [
      makeTag({ id: 1, name: 'Pilot', sort_order: 1 }),
      makeTag({ id: 2, name: 'Urgent', sort_order: 0 }),
    ],
    instanceSettings: null,
    projectFields: [
      // Store order is the server's field order, whatever the ids.
      makeProjectField({ id: 44, name: 'Areas', field_type: 'multiselect', options: [red, blue] }),
      makeProjectField({ id: 40, name: 'Site notes', field_type: 'text' }),
      makeProjectField({ id: 41, name: 'Budget', field_type: 'number', decimals: 1 }),
      makeProjectField({ id: 42, name: 'Regulated', field_type: 'toggle' }),
      makeProjectField({ id: 43, name: 'Kind', field_type: 'select', options: [red, blue] }),
      makeProjectField({ id: 45, name: 'Empty', field_type: 'text' }),
    ],
  });
}

const red = makeProjectFieldOption({ id: 51, name: 'Red', color: '#cc0000', sort_order: 0 });
const blue = makeProjectFieldOption({ id: 52, name: 'Blue', color: '#0000cc', sort_order: 1 });
const ALL_FIELDS = '[40,41,42,43,44,45,77]';

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
      <div data-testid="fielded-project-bar" data-project-id="13" className="projectBar" />
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
    expect(screen.getByText('Confirmed:').nextSibling).toHaveTextContent('No');
    // in tag order; a deleted tag is dropped
    const pills = screen.getByText('Tags:').nextSibling as HTMLElement;
    expect(Array.from(pills.children).map((p) => p.textContent)).toEqual(['Urgent', 'Pilot']);
    expect(screen.getByText('Period:').nextSibling).toHaveTextContent('Mar 2, 2026 - Mar 20, 2026');
    // (70 % x 12 days + 0 % x 5 days) / 17 days
    expect(screen.getByText('49% (calc)')).toBeInTheDocument();
    expect(screen.queryByText('Project:')).not.toBeInTheDocument();
    // The default rows: exactly the rows before Gantt details existed.
    const labels = Array.from(document.querySelectorAll('[class*="label"], [class*="Header"]')).map(
      (el) => el.textContent
    );
    expect(labels).toEqual([
      'Customer:',
      'PM:',
      'Confirmed:',
      'Tags:',
      'Period:',
      'Completion:',
      'Work days:',
      'Total:',
      'Assigned Staff:',
    ]);
  });

  it('shows no Sales PM, Volume or custom field until Gantt details lists them', () => {
    setup();
    holdShift();
    hover('fielded-project-bar');
    expect(screen.getByText('Customer:')).toBeInTheDocument();
    expect(screen.queryByText('Sales PM:')).not.toBeInTheDocument();
    expect(screen.queryByText('Volume:')).not.toBeInTheDocument();
    expect(screen.queryByText('Site notes:')).not.toBeInTheDocument();
  });

  it('names Confirmed, Sales PM and Volume with their renamed labels', () => {
    setup();
    useAppStore.setState({
      instanceSettings: {
        project_field_labels: '{"confirmed":"Won","sales_pm":"Seller","volume":"Budget"}',
        project_tooltip_rows: '["sales_pm","volume","confirmed"]',
      },
    });
    holdShift();
    hover('fielded-project-bar');
    expect(screen.getByText('Won:').nextSibling).toHaveTextContent('Yes');
    expect(screen.getByText('Seller:').nextSibling).toHaveTextContent('Sam Seller');
    expect(screen.getByText('Budget:').nextSibling).toHaveTextContent(formatFieldNumber(12.7, 1));
    expect(screen.queryByText('Confirmed:')).not.toBeInTheDocument();
    expect(screen.queryByText('Status:')).not.toBeInTheDocument();
  });

  it('formats a listed Volume with the Volume decimals; 0 is a value, none is left out', () => {
    setup();
    useAppStore.setState({
      instanceSettings: { project_tooltip_rows: '["volume"]', volume_decimals: '2' },
    });
    holdShift();
    hover('fielded-project-bar');
    expect(screen.getByText('Volume:').nextSibling).toHaveTextContent(formatFieldNumber(12.7, 2));
    expect(formatFieldNumber(12.7, 2)).toMatch(/12.70/);
    releaseShift();

    useAppStore.setState({
      projects: useAppStore.getState().projects.map((p) => (p.id === 13 ? { ...p, volume: 0 } : p)),
    });
    holdShift();
    hover('fielded-project-bar');
    expect(screen.getByText('Volume:').nextSibling).toHaveTextContent(formatFieldNumber(0, 2));
    releaseShift();

    holdShift();
    hover('plain-project-bar');
    expect(screen.queryByText('Volume:')).not.toBeInTheDocument();
  });

  it('shows the listed custom fields in field order: text, number, toggle and dropdown pills', () => {
    setup();
    useAppStore.setState({ instanceSettings: { project_tooltip_rows: ALL_FIELDS } });
    holdShift();
    hover('fielded-project-bar');

    const rows = Array.from(document.querySelectorAll('[class*="fieldSection"] > div')).map(
      (row) => row.firstChild?.textContent
    );
    // An empty field and an unknown id are left out.
    expect(rows).toEqual(['Areas:', 'Site notes:', 'Budget:', 'Regulated:', 'Kind:']);
    expect(screen.getByText('Site notes:').nextSibling).toHaveTextContent(/^Pilot plant$/);
    expect(screen.getByText('Budget:').nextSibling).toHaveTextContent(formatFieldNumber(3.25, 1));
    expect(screen.getByText('Regulated:').nextSibling).toHaveTextContent('No');
    const kind = screen.getByText('Kind:').nextSibling as HTMLElement;
    expect(Array.from(kind.children).map((p) => p.textContent)).toEqual(['Red']);
    // a deleted item is dropped; the value's order is kept
    const areas = screen.getByText('Areas:').nextSibling as HTMLElement;
    expect(Array.from(areas.children).map((p) => p.textContent)).toEqual(['Blue', 'Red']);
    expect((areas.children[0] as HTMLElement).style.backgroundColor).toBe('rgb(0, 0, 204)');
    expect(screen.queryByText('Empty:')).not.toBeInTheDocument();
    expect(screen.queryByText('orphan value')).not.toBeInTheDocument();
    // Nothing else is listed.
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmed:')).not.toBeInTheDocument();
  });

  it('leaves out a listed built-in field that is hidden', () => {
    setup();
    useAppStore.setState({
      instanceSettings: {
        project_tooltip_rows: '["customer","sales_pm","volume","confirmed"]',
        project_fields_hidden: '["customer","volume"]',
      },
    });
    holdShift();
    hover('fielded-project-bar');
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
    expect(screen.queryByText('Volume:')).not.toBeInTheDocument();
    expect(screen.getByText('Sales PM:')).toBeInTheDocument();
    expect(screen.getByText('Confirmed:')).toBeInTheDocument();
  });

  it('drops the rows Gantt details leaves out', () => {
    setup();
    useAppStore.setState({
      instanceSettings: {
        project_tooltip_rows: '["customer","pm","confirmed","completion","work_days","total_days"]',
      },
    });
    holdShift();
    hover('project-bar');
    expect(screen.getByText('Customer:')).toBeInTheDocument();
    expect(screen.getByText('Total:')).toBeInTheDocument();
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
    expect(screen.queryByText('Tags:')).not.toBeInTheDocument();
    expect(screen.queryByText('Assigned Staff:')).not.toBeInTheDocument();
  });

  it('leaves the phase and subphase details untouched by Gantt details', () => {
    setup();
    useAppStore.setState({ instanceSettings: { project_tooltip_rows: '[]' } });
    holdShift();
    hover('phase-bar');
    expect(screen.getByText('Project:')).toBeInTheDocument();
    expect(screen.getByText('Period:')).toBeInTheDocument();
    expect(screen.getByText('Completion:')).toBeInTheDocument();
    expect(screen.getByText('Work days:')).toBeInTheDocument();
    expect(screen.getByText('Total:')).toBeInTheDocument();
    expect(screen.getByText('Assigned Staff:')).toBeInTheDocument();
    hover('project-bar');
    expect(screen.getByText('Bioprocess Scale-Up')).toBeInTheDocument();
    expect(screen.queryByText('Period:')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmed:')).not.toBeInTheDocument();
  });

  it('keeps a tall tooltip inside a short viewport', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    try {
      setup();
      // a tall bar, so the pointer can sit low in the viewport
      screen.getByTestId('phase-bar').getBoundingClientRect = () => ({ ...rect, bottom: 600 }) as DOMRect;
      holdShift();
      hover('phase-bar', 20, 400);
      const tooltip = screen.getByText('Period:').closest('div')!.parentElement as HTMLElement;
      expect(tooltip.style.top).toBe('92px');
      expect(tooltip.style.left).toBe('35px');
      // never above the viewport
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
      hover('phase-label', 20, 200);
      expect(tooltip.style.top).toBe('8px');
    } finally {
      height.mockRestore();
      if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
    }
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
    expect(screen.getByText('Confirmed:').nextSibling).toHaveTextContent('Yes');
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
