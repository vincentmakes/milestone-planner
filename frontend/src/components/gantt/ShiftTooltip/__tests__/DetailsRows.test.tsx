/**
 * DetailsRows - the content of the Shift-hover details, outside the floating
 * tooltip: a project's rows follow the `shows` gate (built-in fields with
 * their labels, tags, dates, staff, custom fields), a phase or subphase shows
 * its project, parent, dates and staff. `projectTooltipData` builds a
 * project's data from the store's tags and fields.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DetailsRows } from '../DetailsRows';
import { phaseTooltipData, projectTooltipData, subphaseTooltipData } from '../tooltipData';
import { tooltipRowGate } from '@/utils/instanceSettings';
import {
  makePhase,
  makeProject,
  makeProjectField,
  makeProjectFieldOption,
  makeSubphase,
  makeTag,
} from '@/test/factories';

const red = makeProjectFieldOption({ id: 51, name: 'Red', color: '#cc0000' });
const FIELDS = [
  makeProjectField({ id: 7, name: 'Kind', field_type: 'select', options: [red] }),
  makeProjectField({ id: 8, name: 'Notes', field_type: 'text' }),
];
const TAGS = [makeTag({ id: 1, name: 'Pilot', color: '#00aa00' })];

const project = makeProject({
  id: 1,
  name: 'Scale-Up',
  customer: 'Acme',
  pm_name: 'Pat',
  sales_pm: 'Sam',
  volume: 12.345,
  confirmed: true,
  start_date: '2026-03-02',
  end_date: '2026-03-06',
  tags: [makeTag({ id: 1 })],
  staffAssignments: [{ id: 1, staff_id: 4, staff_name: 'Bob Brown', allocation: 50, start_date: '', end_date: '' }],
  field_values: { 7: 51, 8: 'Pilot plant' },
});

function projectData() {
  const data = projectTooltipData(project, { tags: TAGS, fields: FIELDS, bankHolidayDates: new Set(['2026-03-04']) });
  if (!data) throw new Error('no data');
  return data;
}

describe('DetailsRows', () => {
  it('renders every row of a project the gate lets through, with the labels and Volume decimals', () => {
    const settings = {
      project_tooltip_rows: '["customer","pm","sales_pm","volume","confirmed","tags","period","completion","work_days","total_days","staff",7,8]',
      project_field_labels: '{"confirmed":"Won","volume":"Budget"}',
      volume_decimals: '2',
    };
    render(<DetailsRows data={projectData()} settings={settings} shows={tooltipRowGate(settings)} />);

    expect(screen.getByText('Scale-Up')).toBeInTheDocument();
    expect(screen.getByText('Customer:')).toBeInTheDocument();
    expect(screen.getByText('PM:')).toBeInTheDocument();
    expect(screen.getByText('Sales PM:')).toBeInTheDocument();
    expect(screen.getByText('Budget:').nextSibling).toHaveTextContent('12.35');
    expect(screen.getByText('Won:').nextSibling).toHaveTextContent('Yes');
    expect(screen.getByText('Pilot')).toBeInTheDocument();
    expect(screen.getByText('Period:')).toBeInTheDocument();
    expect(screen.getByText('Completion:').nextSibling).toHaveTextContent('—');
    // 5 days, one a bank holiday
    expect(screen.getByText('Work days:').nextSibling).toHaveTextContent('4 days (excl. 1 hol.)');
    expect(screen.getByText('Total:').nextSibling).toHaveTextContent('5 days');
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Kind:')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Notes:').nextSibling).toHaveTextContent('Pilot plant');
  });

  it('leaves out what the gate refuses, a hidden field included', () => {
    const settings = { project_tooltip_rows: '["customer","pm",8]', project_fields_hidden: '["customer"]' };
    render(<DetailsRows data={projectData()} settings={settings} shows={tooltipRowGate(settings)} />);

    expect(screen.getByText('PM:')).toBeInTheDocument();
    expect(screen.getByText('Notes:')).toBeInTheDocument();
    for (const label of ['Customer:', 'Sales PM:', 'Volume:', 'Confirmed:', 'Period:', 'Total:', 'Kind:']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
    expect(screen.queryByText('Assigned Staff:')).not.toBeInTheDocument();
  });

  it('renders a phase and a subphase with all their rows, the project ones never', () => {
    const sub = makeSubphase({ id: 3, name: 'Screening', start_date: '2026-03-02', end_date: '2026-03-03', completion: 40 });
    const phase = makePhase({
      id: 2,
      name: 'Feasibility',
      start_date: '2026-03-02',
      end_date: '2026-03-06',
      children: [sub],
      staffAssignments: [{ id: 2, staff_id: 9, allocation: 25, start_date: '', end_date: '' }],
    });
    const { unmount } = render(
      <DetailsRows data={phaseTooltipData(phase, project, new Set())} settings={null} shows={() => true} />
    );
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(screen.getByText('Project:').nextSibling).toHaveTextContent('Scale-Up');
    expect(screen.getByText('Completion:').nextSibling).toHaveTextContent('40% (calc)');
    expect(screen.getByText('Staff #9')).toBeInTheDocument();
    expect(screen.queryByText('Customer:')).not.toBeInTheDocument();
    unmount();

    render(
      <DetailsRows data={subphaseTooltipData(sub, project, phase, new Set())} settings={null} shows={() => true} />
    );
    expect(screen.getByText('Parent:').nextSibling).toHaveTextContent('Feasibility');
    expect(screen.getByText('Completion:').nextSibling).toHaveTextContent('40%');
    expect(screen.getByText('Total:').nextSibling).toHaveTextContent('2 days');
  });

  describe('work days through the working-day rule', () => {
    // Thu 5 .. Tue 10 March 2026: a Friday holiday and a Saturday one.
    const span = { start_date: '2026-03-05', end_date: '2026-03-10' };
    const holidays = new Set(['2026-03-06', '2026-03-07']);
    const phase = makePhase({ id: 4, ...span });
    const sub = makeSubphase({ id: 5, ...span });
    const weekProject = makeProject({ id: 6, ...span, phases: [] });

    it('counts Monday to Friday and only the weekday holiday by default', () => {
      for (const data of [
        phaseTooltipData(phase, project, holidays),
        subphaseTooltipData(sub, project, phase, holidays),
        projectTooltipData(weekProject, { tags: [], fields: [], bankHolidayDates: holidays }),
      ]) {
        expect(data).toMatchObject({ totalDays: 6, workDays: 3, holidays: 1 });
      }
    });

    it('counts every day and both holidays when weekends are working days', () => {
      for (const data of [
        phaseTooltipData(phase, project, holidays, true),
        subphaseTooltipData(sub, project, phase, holidays, true),
        projectTooltipData(weekProject, { tags: [], fields: [], bankHolidayDates: holidays, weekendsWorking: true }),
      ]) {
        expect(data).toMatchObject({ totalDays: 6, workDays: 4, holidays: 2 });
      }
    });
  });

  it('builds no project data without dates', () => {
    expect(
      projectTooltipData(makeProject({ start_date: '', end_date: '', phases: [] }), {
        tags: [],
        fields: [],
        bankHolidayDates: new Set(),
      })
    ).toBeNull();
  });
});
