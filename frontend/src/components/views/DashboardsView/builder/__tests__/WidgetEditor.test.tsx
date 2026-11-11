/**
 * WidgetEditor: the kind rules (KPI ≤ 1 dimension as a share, pie exactly
 * one), the dimension choices from the measure matrix (with the
 * views.staff / views.archived gates and one choice per dropdown or toggle
 * field), a measure change dropping a refused dimension, the debounced
 * preview (stale answers ignored, 422 → Notice + Save disabled, a network
 * failure → "Preview unavailable"), the custom period, the KPI bucket from
 * the preview, the filters, and the widget handed to the builder. The measure
 * families: the grouped picker gated by views.staff / views.equipment, the
 * hints, the dimensions and filters per family, no percentage (and a
 * dimensionless KPI) on utilisation and available days, the twelve periods.
 * The gauge, heatmap, treemap and sankey: the nine kinds, their dimension
 * fields (no Period on a treemap or a sankey), the gauge's hidden Percent of /
 * Top N row and its Target, the ratio refusal, and the widgets saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import {
  makeEquipment,
  makeProject,
  makeProjectField,
  makeProjectFieldOption,
  makeSite,
  makeStaff,
  makeTag,
  makeTeam,
  makeUser,
} from '@/test/factories';
import { optionLabel, pickerOptions, pickerTrigger, pickOption } from '@/test/searchableSelect';
import { dateValue, pickRange } from '@/test/datePicker';
import type { MetricQuery, MetricResult } from '@/types';
import { formatMetric } from '@/utils/metrics';
import type { PermissionKey } from '@/types/permissions';
import {
  CAPACITY_HINT,
  FIX_FORMULA,
  LEAVE_CALCULATION,
  STALE_PREVIEW,
  EQUIPMENT_AVAILABILITY_HINT,
  KPI_BUCKET_REQUIRED,
  PREVIEW_DELAY_MS,
  PREVIEW_UNAVAILABLE,
  TITLE_REQUIRED,
  WidgetEditor,
  WORKING_DAYS_HINT,
} from '../WidgetEditor';
import { NEGATIVE_PIE_PROBLEM, RATIO_HIERARCHY_PROBLEM } from '../widgetDraft';
import type { DraftWidget } from '../widgetDraft';
import { CAPACITY_EXAMPLE_HINT, MAX_TERMS_HINT } from '../CalculationSection';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api/endpoints/dashboards', () => ({
  dashboardsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
    data: vi.fn(),
  },
}));

vi.mock('../../charts/EChart', () => ({
  EChart: ({ kind }: { kind: string }) => <div data-testid="echart" data-kind={kind} />,
}));

const api = vi.mocked(dashboardsApi);

const BASE: PermissionKey[] = ['projects.view', 'views.dashboards', 'dashboards.manage'];

const result = (rows: MetricResult['rows'] = [{ keys: [], value: 4 }], extra: Partial<MetricResult> = {}): MetricResult => ({
  unit: 'weeks',
  dimensions: [],
  rows,
  total: rows.reduce((sum, r) => sum + (r.value ?? 0), 0),
  truncated: false,
  warnings: [],
  ...extra,
});

function signIn(permissions: PermissionKey[]) {
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'custom', permissions, site_ids: [1, 2] }) });
}

function renderEditor(props: { widget?: DraftWidget | null; widgets?: DraftWidget[] } = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<WidgetEditor widget={props.widget ?? null} widgets={props.widgets ?? []} onClose={onClose} onSave={onSave} />);
  return { onSave, onClose };
}

/** Let the 400 ms debounce run and the answer land. */
async function flushPreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS);
  });
}

const dimension1 = () => pickerTrigger(/^Dimension 1/);
const dimensionLabels = (n: 1 | 2) => pickerOptions(new RegExp(`^Dimension ${n}`)).map(optionLabel);
const periodSelect = () => screen.getByRole('combobox', { name: 'Period' });
const saveButton = (name = 'Add widget') => screen.getByRole('button', { name });
/** The switches of the display options (the Calculation switch left out). */
const displaySwitches = () =>
  screen.queryAllByRole('switch').filter((el) => el !== screen.queryByRole('switch', { name: 'Calculation' }));
const lastQuery = (): MetricQuery => api.query.mock.calls[api.query.mock.calls.length - 1][0];
const measureSelect = () => screen.getByLabelText('Measure') as HTMLSelectElement;
const setMeasure = (value: string) => fireEvent.change(measureSelect(), { target: { value } });
/** The measure picker's groups: `[family label, [measure labels]]`. */
const measureGroups = () =>
  Array.from(measureSelect().querySelectorAll('optgroup')).map((g) => [
    g.label,
    Array.from(g.querySelectorAll('option')).map((o) => o.textContent),
  ]);
/** The list filters shown, by their labels, in order. */
const filterButtons = () => {
  const region = document.getElementById(screen.getByRole('button', { name: /^Filters/ }).getAttribute('aria-controls') ?? '');
  return within(region as HTMLElement)
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-haspopup') === 'listbox')
    .map((b) => document.getElementById((b.getAttribute('aria-labelledby') ?? '').split(' ')[0])?.textContent);
};
const HPLC = makeEquipment({ id: 70, name: 'HPLC 1', type: 'HPLC', site_id: 1, site_ids: [1, 2] });
const MS = makeEquipment({ id: 71, name: 'Mass spec', type: 'MS', site_id: 2, site_ids: [2] });

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  signIn([...BASE, 'views.staff', 'views.archived', 'sites.view_all']);
  useAppStore.setState({
    sites: [makeSite({ id: 1, name: 'Basel' }), makeSite({ id: 2, name: 'Berlin' })],
    teams: [makeTeam({ id: 5, site_id: 1, name: 'Analytics', color: '#123456' }), makeTeam({ id: 6, site_id: 2, name: 'Process' })],
    staff: [makeStaff({ id: 8, name: 'Bob Brown', site_id: 1 }), makeStaff({ id: 8, name: 'Bob Brown', site_id: 2 })],
    projects: [
      makeProject({ id: 30, name: 'Zeta', site_id: 1 }),
      makeProject({ id: 31, name: 'Alpha', site_id: 2 }),
      makeProject({ id: 32, name: 'Old one', site_id: 1, archived: true }),
    ],
    tags: [makeTag({ id: 40, name: 'Urgent' })],
    projectFields: [
      makeProjectField({
        id: 3,
        name: 'Project type',
        field_type: 'select',
        options: [makeProjectFieldOption({ id: 31, name: 'Internal' }), makeProjectFieldOption({ id: 32, name: 'Customer' })],
      }),
      makeProjectField({ id: 4, name: 'Lab work', field_type: 'toggle' }),
      makeProjectField({ id: 7, name: 'Notes', field_type: 'text' }),
    ],
  });
  api.query.mockResolvedValue(result());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WidgetEditor — form', () => {
  it('opens as "Add widget" on a bar chart of booked weeks this year', async () => {
    renderEditor();
    expect(screen.getByRole('dialog', { name: 'Add widget' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Bar' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Measure')).toHaveValue('booked_weeks');
    expect(periodSelect()).toHaveValue('this_year');
    expect(screen.getByLabelText('Measure')).toHaveAccessibleDescription(/Monday to Friday/);
    await flushPreview();
    expect(api.query).toHaveBeenCalledWith({ measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } });
  });

  it('opens in the extra-wide dialog, the preview beside the form', async () => {
    renderEditor();
    const box = screen.getByRole('dialog', { name: 'Add widget' }).firstElementChild as HTMLElement;
    expect(box.className).toMatch(/xxl/);
    expect(box.className).not.toMatch(/(^|\s)_?lg/);
    await flushPreview();
  });

  it('moves through the kinds with the arrow keys, as one radio group', () => {
    renderEditor();
    const group = screen.getByRole('radiogroup', { name: 'Kind' });
    const radios = within(group).getAllByRole('radio');
    const kinds = ['KPI', 'Gauge', 'Bar', 'Line', 'Pie', 'Heatmap', 'Treemap', 'Sankey', 'Table'];
    expect(radios.map((r) => r.textContent)).toEqual(kinds);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1, -1, -1]);
    fireEvent.keyDown(radios[2], { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Line' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Line' }));
    fireEvent.keyDown(radios[3], { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[8], { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'KPI' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[0], { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[8], { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'KPI' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[0], { key: 'ArrowUp' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[8], { key: 'a' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    // The arrows walk every kind in order, one tab stop at a time.
    fireEvent.keyDown(radios[8], { key: 'Home' });
    const walked = ['KPI'];
    for (let i = 0; i < kinds.length - 1; i += 1) {
      fireEvent.keyDown(radios[i], { key: 'ArrowRight' });
      walked.push(within(group).getByRole('radio', { checked: true }).textContent ?? '');
      expect(radios.filter((r) => r.tabIndex === 0)).toEqual([radios[i + 1]]);
    }
    expect(walked).toEqual(kinds);
  });

  it('offers the dimensions the measure accepts, a field per dropdown or toggle field, Person only with views.staff', () => {
    renderEditor();
    expect(dimensionLabels(1)).toEqual([
      'None',
      'Site',
      'Team',
      'Project team',
      'Person',
      'Project',
      'Project manager',
      'Customer',
      'Confirmed',
      'Tag',
      'Phase',
      'Project type',
      'Lab work',
      'Period',
    ]);
    fireEvent.change(screen.getByLabelText('Measure'), { target: { value: 'project_count' } });
    expect(dimensionLabels(1)).toEqual([
      'None',
      'Site',
      'Project team',
      'Project',
      'Project manager',
      'Customer',
      'Confirmed',
      'Tag',
      'Project type',
      'Lab work',
      'Period',
    ]);
  });

  it('leaves Person out without views.staff, and its people filter too', () => {
    signIn(BASE);
    renderEditor();
    expect(dimensionLabels(1)).not.toContain('Person');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('button', { name: /^People/ })).not.toBeInTheDocument();
  });

  it('leaves Person and People out of a capacity measure without absences.view_others, and drops them on the switch', async () => {
    signIn([...BASE, 'views.staff']);
    renderEditor();
    pickOption(/^Dimension 1/, 'Person');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    pickOption(/^People/, 'Bob Brown');
    setMeasure('utilisation');
    // Per person, a capacity shows the person's absence days: aggregates only.
    expect(dimensionLabels(1)).toEqual(['None', 'Site', 'Team', 'Period']);
    expect(dimension1()).toHaveTextContent('None');
    // Utilisation's project filters stay (they narrow its booked side); People goes.
    expect(filterButtons()).toEqual(['Sites', 'Teams', 'Project teams', 'Projects', 'Tags', 'Project type']);
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'utilisation', filters: { period: { relative: 'this_year' } } });
    // A booking measure by person needs views.staff only.
    setMeasure('booked_days');
    expect(dimensionLabels(1)).toContain('Person');
    expect(filterButtons()).toContain('People');
  });

  it('names built-in dimensions by their instance labels and hides a hidden Customer', () => {
    useAppStore.setState({
      instanceSettings: { project_field_labels: '{"confirmed":"Signed"}', project_fields_hidden: '["customer"]' },
    });
    renderEditor();
    const labels = dimensionLabels(1);
    expect(labels).toContain('Signed');
    expect(labels).not.toContain('Customer');
  });

  it('offers a second dimension of another kind once the first is chosen, with a grain for a period', async () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
    pickOption(/^Dimension 1/, 'Period');
    expect(screen.getByLabelText('Grain of dimension 1')).toHaveValue('month');
    fireEvent.change(screen.getByLabelText('Grain of dimension 1'), { target: { value: 'quarter' } });
    expect(dimensionLabels(2)).not.toContain('Period');
    pickOption(/^Dimension 2/, 'Project type');
    // Only the exact same choice is excluded: another project field still crosses.
    expect(dimensionLabels(1)).not.toContain('Project type');
    expect(dimensionLabels(1)).toContain('Lab work');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([
      { kind: 'period', grain: 'quarter' },
      { kind: 'field', field_id: 3 },
    ]);
    // Clearing the first dimension moves the second up
    pickOption(/^Dimension 1/, 'None');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([{ kind: 'field', field_id: 3 }]);
  });

  it('crosses two different project fields, never the same one twice', async () => {
    renderEditor();
    pickOption(/^Dimension 1/, 'Project type');
    const second = dimensionLabels(2);
    expect(second).toContain('Lab work');
    expect(second).not.toContain('Project type');
    pickOption(/^Dimension 2/, 'Lab work');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([
      { kind: 'field', field_id: 3 },
      { kind: 'field', field_id: 4 },
    ]);
  });

  it('drops a dimension the new measure refuses', async () => {
    renderEditor();
    pickOption(/^Dimension 1/, 'Team');
    expect(dimension1()).toHaveTextContent('Team');
    fireEvent.change(screen.getByLabelText('Measure'), { target: { value: 'project_count' } });
    expect(dimension1()).toHaveTextContent('None');
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'project_count', filters: { period: { relative: 'this_year' } } });
  });

  it('gives a KPI at most one dimension, as a share of the total', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    expect(screen.getByLabelText('Percent of')).toBeDisabled();
    pickOption(/^Dimension 1/, 'Confirmed');
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Percent of')).toHaveValue('total');
    expect(within(screen.getByLabelText('Percent of')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'None',
      'Total',
    ]);
    // No share: no dimension
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: '' } });
    expect(dimension1()).toHaveTextContent('None');
  });

  it('turns a two-dimension chart into a KPI share of the first', () => {
    renderEditor();
    pickOption(/^Dimension 1/, 'Site');
    pickOption(/^Dimension 2/, 'Confirmed');
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'first_dimension' } });
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Percent of')).toHaveValue('total');
  });

  it('needs one dimension for a pie: no preview, and Save says why', async () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Split' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Pie' }));
    await flushPreview();
    api.query.mockClear();
    await flushPreview();
    expect(api.query).not.toHaveBeenCalled();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toHaveTextContent('A pie chart needs one dimension.');
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent('A pie chart needs one dimension.');
    expect(onSave).not.toHaveBeenCalled();
    pickOption(/^Dimension 1/, 'Site');
    await flushPreview();
    expect(api.query).toHaveBeenCalledTimes(1);
  });

  it('offers Percent of the first dimension only with two dimensions, and Top N unless the first is a period', async () => {
    renderEditor();
    const percentOptions = () =>
      within(screen.getByLabelText('Percent of')).getAllByRole('option').map((o) => o.textContent);
    expect(screen.getByLabelText('Top N')).toBeDisabled();
    pickOption(/^Dimension 1/, 'Project');
    expect(percentOptions()).toEqual(['None', 'Total']);
    fireEvent.change(screen.getByLabelText('Top N'), { target: { value: '80' } });
    pickOption(/^Dimension 2/, 'Team');
    expect(percentOptions()).toEqual(['None', 'Total', 'First dimension']);
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'first_dimension' } });
    await flushPreview();
    expect(lastQuery()).toMatchObject({ percent_of: 'first_dimension', top_n: 50 });
    fireEvent.change(screen.getByLabelText('Top N'), { target: { value: '' } });
    await flushPreview();
    expect(lastQuery().top_n).toBeUndefined();
    pickOption(/^Dimension 1/, 'Period');
    expect(screen.getByLabelText('Top N')).toBeDisabled();
  });
});

describe('WidgetEditor — filters and period', () => {
  it('keeps the filters closed when none is set, and builds them into the query', async () => {
    renderEditor();
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    expect(pickerOptions(/^Teams/).map((o) => o.textContent)).toEqual(['Analytics Basel', 'Process Berlin']);
    expect(pickerOptions(/^People/).map(optionLabel)).toEqual(['Bob Brown']);
    expect(pickerOptions(/^Projects/).map(optionLabel)).toEqual(['Alpha', 'Zeta']);

    pickOption(/^Sites/, 'Berlin');
    pickOption(/^Teams/, 'Analytics');
    pickOption(/^Project teams/, 'Process');
    pickOption(/^People/, 'Bob Brown');
    pickOption(/^Projects/, 'Zeta');
    pickOption(/^Tags/, 'Urgent');
    pickOption(/^Project type/, 'Customer');
    fireEvent.change(screen.getByLabelText('Confirmed'), { target: { value: 'false' } });
    fireEvent.change(screen.getByLabelText('Archived projects'), { target: { value: 'include' } });
    expect(pickerOptions(/^Projects/).map(optionLabel)).toEqual(['Alpha', 'Old one', 'Zeta']);
    await flushPreview();
    expect(lastQuery().filters).toEqual({
      site_ids: [2],
      team_ids: [5],
      project_team_ids: [6],
      person_ids: [8],
      project_ids: [30],
      tag_ids: [40],
      field_options: { '3': [32] },
      confirmed: false,
      archived: 'include',
      period: { relative: 'this_year' },
    });
    expect(screen.getByRole('button', { name: 'Filters (9)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Archived projects'), { target: { value: 'only' } });
    expect(pickerOptions(/^Projects/).map(optionLabel)).toEqual(['Old one']);
    fireEvent.change(screen.getByLabelText('Confirmed'), { target: { value: 'any' } });
    await flushPreview();
    expect(lastQuery().filters?.confirmed).toBeUndefined();
  });

  it('offers the Teams and People filters on booked time only, and drops them off it', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    pickOption(/^Teams/, 'Analytics');
    pickOption(/^People/, 'Bob Brown');
    pickOption(/^Tags/, 'Urgent');
    await flushPreview();
    expect(lastQuery().filters).toMatchObject({ team_ids: [5], person_ids: [8] });

    fireEvent.change(screen.getByLabelText('Measure'), { target: { value: 'project_count' } });
    expect(screen.queryByRole('button', { name: /^Teams/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^People/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Project teams/ })).toBeInTheDocument();
    await flushPreview();
    expect(lastQuery().filters).toEqual({ tag_ids: [40], period: { relative: 'this_year' } });
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
  });

  it('drops the Teams and People filters a stored project widget still carries', async () => {
    const { onSave } = renderEditor({
      widget: {
        clientId: 'w4',
        id: 4,
        kind: 'kpi',
        title: 'Projects',
        query: { measure: 'phase_count', filters: { team_ids: [5], person_ids: [8] } },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('button', { name: /^Teams/ })).not.toBeInTheDocument();
    await flushPreview();
    expect(lastQuery().filters).toEqual({ period: { relative: 'this_year' } });
    fireEvent.click(saveButton('Save Changes'));
    expect(onSave.mock.calls[0][0].query.filters).toEqual({ period: { relative: 'this_year' } });
  });

  it('offers archived projects only with views.archived', () => {
    signIn([...BASE, 'views.staff']);
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(within(screen.getByLabelText('Archived projects')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Exclude',
    ]);
  });

  it('opens the filters of a widget that has some', () => {
    renderEditor({
      widget: {
        clientId: 'w3',
        id: 3,
        kind: 'bar',
        title: 'Filtered',
        query: { measure: 'booked_days', filters: { tag_ids: [40], archived: 'only' } },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('takes a custom period from the date range, and asks for both ends first', async () => {
    renderEditor();
    fireEvent.change(periodSelect(), { target: { value: 'custom' } });
    expect(screen.getByRole('complementary', { name: 'Preview' })).toHaveTextContent(
      'Choose the start and end of the period.'
    );
    pickRange('From', '2026-03-02', '2026-04-30');
    expect(dateValue('To')).toBe('2026-04-30');
    await flushPreview();
    expect(lastQuery().filters?.period).toEqual({ from: '2026-03-02', to: '2026-04-30' });
    fireEvent.change(periodSelect(), { target: { value: 'custom' } });
    fireEvent.change(periodSelect(), { target: { value: 'last_12_months' } });
    await flushPreview();
    expect(lastQuery().filters?.period).toEqual({ relative: 'last_12_months' });
  });
});

describe('WidgetEditor — measure families', () => {
  const ALL = [
    ...BASE,
    'views.staff',
    'views.equipment',
    'views.archived',
    'absences.view_others',
    'sites.view_all',
  ] as PermissionKey[];

  it('groups the measures by family, in the server order', () => {
    signIn(ALL);
    renderEditor();
    expect(Array.from(measureSelect().children).filter((c) => c.tagName === 'OPTION')).toHaveLength(0);
    expect(measureGroups()).toEqual([
      ['Bookings', ['Booked days', 'Booked weeks', 'Bookings', 'People booked']],
      ['Projects', ['Projects', 'Project weeks', 'Project volume']],
      ['Phases', ['Phases', 'Phase weeks', 'Phases due', 'Phases overdue']],
      ['Capacity', ['Capacity (days)', 'Capacity (weeks)', 'Available days', 'Utilisation', 'People over capacity']],
      [
        'Equipment',
        ['Equipment booked days', 'Equipment bookings', 'Equipment booked', 'Equipment utilisation'],
      ],
    ]);
  });

  it('leaves out the capacity measures without views.staff and the equipment ones without views.equipment', () => {
    signIn(BASE);
    renderEditor();
    expect(measureGroups().map(([label]) => label)).toEqual(['Bookings', 'Projects', 'Phases']);
  });

  it('keeps a stored measure listed when its key was lost, and lets the server refuse it', async () => {
    signIn(BASE);
    api.query.mockRejectedValue(new ApiError('Utilisation needs the Staff view', 422));
    renderEditor({
      widget: {
        clientId: 'w9',
        id: 9,
        kind: 'bar',
        title: 'Load',
        query: { measure: 'utilisation', filters: { period: { relative: 'this_month' } } },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(measureSelect()).toHaveValue('utilisation');
    expect(measureGroups().map(([label]) => label)).toEqual(['Bookings', 'Projects', 'Phases', 'Capacity']);
    expect(measureGroups()[3][1]).toEqual(['Utilisation']);
    expect(periodSelect()).toHaveValue('this_month');
    await flushPreview();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toHaveTextContent('Utilisation needs the Staff view');
  });

  it('names how each measure counts its days under the picker', () => {
    signIn(ALL);
    renderEditor();
    expect(measureSelect()).toHaveAccessibleDescription(WORKING_DAYS_HINT);
    setMeasure('equipment_booked_days');
    expect(measureSelect()).toHaveAccessibleDescription(WORKING_DAYS_HINT);
    setMeasure('people_over_capacity');
    expect(measureSelect()).toHaveAccessibleDescription(CAPACITY_HINT);
    setMeasure('equipment_utilisation');
    expect(measureSelect()).toHaveAccessibleDescription(EQUIPMENT_AVAILABILITY_HINT);
    // Each hint names the Weekends are working days setting.
    for (const hint of [WORKING_DAYS_HINT, CAPACITY_HINT, EQUIPMENT_AVAILABILITY_HINT]) {
      expect(hint).toContain('Monday to Friday, or every day when Weekends are working days is on');
    }
    setMeasure('project_count');
    expect(measureSelect()).not.toHaveAccessibleDescription();
  });

  it('offers the dimensions of each family, the equipment kinds only with views.equipment', () => {
    signIn(ALL);
    renderEditor();
    setMeasure('utilisation');
    expect(dimensionLabels(1)).toEqual(['None', 'Site', 'Team', 'Person', 'Period']);
    setMeasure('phases_due');
    expect(dimensionLabels(1)).toContain('Status');
    setMeasure('equipment_utilisation');
    expect(dimensionLabels(1)).toEqual(['None', 'Site', 'Equipment', 'Equipment type', 'Period']);
    setMeasure('equipment_booked');
    expect(dimensionLabels(1)).toContain('Equipment type');
    expect(dimensionLabels(1)).not.toContain('Period');
    cleanup();
    signIn([...BASE, 'views.staff']);
    // A stored equipment widget without the key: its measure stays, its equipment kinds go.
    renderEditor({
      widget: {
        clientId: 'w2',
        id: 2,
        kind: 'bar',
        title: 'Bookings',
        query: { measure: 'equipment_booking_count' },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(dimensionLabels(1)).not.toContain('Equipment');
    expect(dimensionLabels(1)).not.toContain('Equipment type');
    expect(dimensionLabels(1)).toContain('Project');
  });

  it('hides Percent of on the measures that take no percentage, and drops a percentage on the switch', async () => {
    signIn(ALL);
    renderEditor();
    pickOption(/^Dimension 1/, 'Team');
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'total' } });
    setMeasure('utilisation');
    expect(screen.queryByLabelText('Percent of')).not.toBeInTheDocument();
    expect(dimension1()).toHaveTextContent('Team');
    await flushPreview();
    expect(lastQuery()).toEqual({
      measure: 'utilisation',
      dimensions: [{ kind: 'team' }],
      filters: { period: { relative: 'this_year' } },
    });
    setMeasure('capacity_days');
    expect(screen.getByLabelText('Percent of')).toBeInTheDocument();
  });

  it('gives people over capacity no percentage, and a KPI of it no dimension', async () => {
    signIn(ALL);
    renderEditor();
    setMeasure('people_over_capacity');
    pickOption(/^Dimension 1/, 'Team');
    // Counted again in each bucket: the buckets are not parts of the total.
    expect(screen.queryByLabelText('Percent of')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    expect(screen.queryByRole('button', { name: /^Dimension 1/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'people_over_capacity', filters: { period: { relative: 'this_year' } } });
  });

  it('gives a KPI of utilisation no dimension controls, its total in the preview body', async () => {
    signIn(ALL);
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    pickOption(/^Dimension 1/, 'Site');
    expect(screen.getByLabelText('Percent of')).toHaveValue('total');
    setMeasure('utilisation');
    expect(screen.queryByRole('button', { name: /^Dimension 1/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Percent of')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();
    // Nothing to rank without a dimension: no Top N either.
    expect(screen.queryByLabelText('Top N')).not.toBeInTheDocument();
    api.query.mockResolvedValue(result([{ keys: [], value: 87.5 }], { unit: 'percent', total: 87.5 }));
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'utilisation', filters: { period: { relative: 'this_year' } } });
    // A bar chart of it gets its dimension controls back.
    fireEvent.click(screen.getByRole('radio', { name: 'Bar' }));
    expect(screen.getByRole('button', { name: /^Dimension 1/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Top N')).toBeDisabled();
  });

  it('refuses a pie of available days, before asking the server', async () => {
    signIn(ALL);
    renderEditor();
    setMeasure('available_days');
    fireEvent.click(screen.getByRole('radio', { name: 'Pie' }));
    pickOption(/^Dimension 1/, 'Team');
    await flushPreview();
    api.query.mockClear();
    await flushPreview();
    expect(api.query).not.toHaveBeenCalled();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toHaveTextContent(NEGATIVE_PIE_PROBLEM);
  });

  it('sends a utilisation widget by person over next quarter, cut to some people', async () => {
    signIn(ALL);
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Load' } });
    setMeasure('utilisation');
    pickOption(/^Dimension 1/, 'Person');
    fireEvent.change(periodSelect(), { target: { value: 'next_quarter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    pickOption(/^People/, 'Bob Brown');
    pickOption(/^Teams/, 'Analytics');
    await flushPreview();
    const sent = {
      measure: 'utilisation',
      dimensions: [{ kind: 'person' }],
      filters: { team_ids: [5], person_ids: [8], period: { relative: 'next_quarter' } },
    };
    expect(lastQuery()).toEqual(sent);
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].query).toEqual(sent);
  });
});

describe('WidgetEditor — filters per family', () => {
  const ALL = [
    ...BASE,
    'views.staff',
    'views.equipment',
    'views.archived',
    'absences.view_others',
    'sites.view_all',
  ] as PermissionKey[];

  beforeEach(() => {
    signIn(ALL);
    useAppStore.setState({
      equipment: [HPLC, { ...HPLC, site_id: 2 }, MS, makeEquipment({ id: 72, name: 'Rig', type: '  ', site_ids: [] })],
    });
  });

  it('shows Sites, Teams and People only on a capacity measure', () => {
    renderEditor();
    setMeasure('capacity_days');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(filterButtons()).toEqual(['Sites', 'Teams', 'People']);
    expect(screen.getByLabelText('Archived projects')).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirmed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Milestones')).not.toBeInTheDocument();
  });

  it('adds the Milestones mode on a phase measure, sent only when not Include', async () => {
    renderEditor();
    setMeasure('phases_overdue');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('button', { name: /^Teams/ })).not.toBeInTheDocument();
    const milestones = screen.getByLabelText('Milestones');
    expect(milestones).toHaveValue('include');
    expect(within(milestones).getAllByRole('option').map((o) => o.textContent)).toEqual(['Include', 'Only', 'Exclude']);
    fireEvent.change(milestones, { target: { value: 'exclude' } });
    await flushPreview();
    expect(lastQuery().filters).toEqual({ milestones: 'exclude', period: { relative: 'this_year' } });
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Milestones'), { target: { value: 'include' } });
    await flushPreview();
    expect(lastQuery().filters).toEqual({ period: { relative: 'this_year' } });
    // Off a phase measure the mode is dropped.
    fireEvent.change(screen.getByLabelText('Milestones'), { target: { value: 'only' } });
    setMeasure('project_count');
    expect(screen.queryByLabelText('Milestones')).not.toBeInTheDocument();
    await flushPreview();
    expect(lastQuery().filters).toEqual({ period: { relative: 'this_year' } });
  });

  it('adds Equipment (each once, with its sites) and Equipment types on an equipment measure', async () => {
    renderEditor();
    setMeasure('equipment_booked_days');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(filterButtons()).toEqual([
      'Sites',
      'Project teams',
      'Projects',
      'Tags',
      'Equipment',
      'Equipment types',
      'Project type',
    ]);
    expect(pickerOptions(/^Equipment(?! types)/).map((o) => o.textContent)).toEqual([
      'HPLC 1 Basel, Berlin',
      'Mass spec Berlin',
      'Rig',
    ]);
    expect(pickerOptions(/^Equipment types/).map(optionLabel)).toEqual(['HPLC', 'MS']);
    pickOption(/^Equipment(?! types)/, 'Mass spec');
    pickOption(/^Equipment types/, 'MS');
    pickOption(/^Equipment types/, 'HPLC');
    await flushPreview();
    expect(lastQuery().filters).toEqual({
      equipment_ids: [71],
      equipment_types: ['HPLC', 'MS'],
      period: { relative: 'this_year' },
    });
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeInTheDocument();
    pickOption(/^Equipment types/, 'HPLC');
    await flushPreview();
    expect(lastQuery().filters?.equipment_types).toEqual(['MS']);
    // Equipment utilisation filters the equipment and its sites only.
    setMeasure('equipment_utilisation');
    expect(filterButtons()).toEqual(['Sites', 'Equipment', 'Equipment types']);
    expect(screen.queryByLabelText('Confirmed')).not.toBeInTheDocument();
  });

  it('keeps a stored equipment type no equipment has any more, so it can be removed', async () => {
    renderEditor({
      widget: {
        clientId: 'w5',
        id: 5,
        kind: 'bar',
        title: 'Types',
        query: { measure: 'equipment_booking_count', filters: { equipment_types: ['Oven'] } },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(pickerOptions(/^Equipment types/).map(optionLabel)).toEqual(['HPLC', 'MS', 'Oven']);
    pickOption(/^Equipment types/, 'Oven');
    await flushPreview();
    expect(lastQuery().filters).toEqual({ period: { relative: 'this_year' } });
  });

  it('shows the equipment filters only with views.equipment, People only with views.staff', () => {
    signIn([...BASE, 'views.archived']);
    renderEditor({
      widget: {
        clientId: 'w6',
        id: 6,
        kind: 'bar',
        title: 'Bookings',
        query: { measure: 'equipment_booked' },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('button', { name: /^Equipment/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Projects/ })).toBeInTheDocument();
  });

  it('offers the twelve relative periods, then a custom range', () => {
    renderEditor();
    expect(within(periodSelect()).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'This year',
      'Last year',
      'Next year',
      'This quarter',
      'Last quarter',
      'Next quarter',
      'This month',
      'Last month',
      'Next month',
      'Last 12 months',
      'Next 12 months',
      'All time',
      'Custom…',
    ]);
  });
});

describe('WidgetEditor — preview', () => {
  it('waits 400 ms after the last change, and ignores an answer a newer request superseded', async () => {
    // Fake time only: real time passing (a loaded machine) must not move the clock
    vi.useRealTimers();
    vi.useFakeTimers();
    let releaseFirst!: (r: MetricResult) => void;
    api.query.mockReturnValueOnce(new Promise<MetricResult>((r) => (releaseFirst = r)));
    renderEditor();
    // A KPI shows the number itself
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS - 1);
    });
    expect(api.query).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.query).toHaveBeenCalledTimes(1);
    // A change while the first is in flight
    api.query.mockResolvedValueOnce(result([{ keys: [], value: 12 }]));
    fireEvent.change(screen.getByLabelText('Measure'), { target: { value: 'booked_days' } });
    await flushPreview();
    expect(api.query).toHaveBeenCalledTimes(2);
    expect(screen.getByText('12.0')).toBeInTheDocument();
    // The first answer lands late: ignored
    await act(async () => releaseFirst(result([{ keys: [], value: 99 }])));
    expect(screen.queryByText('99.0')).not.toBeInTheDocument();
    expect(screen.getByText('12.0')).toBeInTheDocument();
  });

  it('drops an answer that lands after the dialog closed', async () => {
    let release!: (r: MetricResult) => void;
    api.query.mockReturnValueOnce(new Promise<MetricResult>((r) => (release = r)));
    const onSave = vi.fn();
    const { unmount } = render(<WidgetEditor widget={null} widgets={[]} onClose={vi.fn()} onSave={onSave} />);
    await flushPreview();
    unmount();
    await act(async () => release(result()));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a refusal in the preview and disables Save until the query changes', async () => {
    api.query.mockRejectedValueOnce(new ApiError('body: A period can cover at most five years', 422));
    renderEditor();
    await flushPreview();
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(preview).getByRole('alert')).toHaveTextContent(/^A period can cover at most five years$/);
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Measure'), { target: { value: 'booked_days' } });
    await flushPreview();
    expect(within(preview).queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('says the preview is unavailable on a network failure, and still saves', async () => {
    api.query.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { onSave } = renderEditor();
    await flushPreview();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toHaveTextContent(PREVIEW_UNAVAILABLE);
    expect(PREVIEW_UNAVAILABLE).toBe('Preview unavailable');
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Weeks' } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Weeks' }), null);
  });

  it('draws the chart kind chosen, titled by the title typed', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'By site' } });
    pickOption(/^Dimension 1/, 'Site');
    api.query.mockResolvedValue(result([{ keys: [{ key: 1, label: 'Basel' }], value: 3 }]));
    await flushPreview();
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(preview).getByRole('heading', { name: 'By site' })).toBeInTheDocument();
    expect(within(preview).getByTestId('echart')).toHaveAttribute('data-kind', 'bar');
  });
});

describe('WidgetEditor — gauge, heatmap, treemap and sankey', () => {
  const PREVIEW = () => screen.getByRole('complementary', { name: 'Preview' });
  const chooseKind = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const setTitle = (value: string) => fireEvent.change(screen.getByLabelText('Title *'), { target: { value } });
  const target = () => screen.getByLabelText('Target') as HTMLInputElement;
  const setTarget = (value: string) => fireEvent.change(target(), { target: { value } });

  it('gives a gauge no dimension field and no Percent of / Top N row, and drops the dimensions chosen', async () => {
    renderEditor();
    pickOption(/^Dimension 1/, 'Project');
    pickOption(/^Dimension 2/, 'Team');
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'first_dimension' } });
    chooseKind('Gauge');
    expect(screen.queryByRole('button', { name: /^Dimension 1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Percent of')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Top N')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Number format')).toBeInTheDocument();
    api.query.mockResolvedValue(result([{ keys: [], value: 40 }]));
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } });
    expect(within(PREVIEW()).getByTestId('echart')).toHaveAttribute('data-kind', 'gauge');
    // Back on a bar the dimensions stay dropped.
    chooseKind('Bar');
    expect(dimension1()).toHaveTextContent('None');
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
  });

  it('shows both dimension fields of a heatmap at once, the second waiting for the first, and previews the two', async () => {
    renderEditor();
    chooseKind('Heatmap');
    expect(dimension1()).toBeEnabled();
    expect(pickerTrigger(/^Dimension 2/)).toBeDisabled();
    expect(PREVIEW()).toHaveTextContent('A heatmap needs two dimensions.');
    pickOption(/^Dimension 1/, 'Team');
    expect(pickerTrigger(/^Dimension 2/)).toBeEnabled();
    expect(PREVIEW()).toHaveTextContent('A heatmap needs two dimensions.');
    // A heatmap takes a period (its x axis).
    expect(dimensionLabels(2)).toContain('Period');
    pickOption(/^Dimension 2/, 'Period');
    api.query.mockResolvedValue(
      result([{ keys: [{ key: 5, label: 'Analytics' }, { key: '2026-01', label: 'Jan 2026' }], value: 3 }])
    );
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([{ kind: 'team' }, { kind: 'period', grain: 'month' }]);
    expect(within(PREVIEW()).getByTestId('echart')).toHaveAttribute('data-kind', 'heatmap');
  });

  it('shows both dimension fields of a sankey, without Period, and refuses one of a ratio', async () => {
    renderEditor();
    pickOption(/^Dimension 1/, 'Period');
    chooseKind('Sankey');
    // The period chosen on the bar is dropped, and offered on neither field.
    expect(dimension1()).toHaveTextContent('None');
    expect(dimensionLabels(1)).not.toContain('Period');
    expect(PREVIEW()).toHaveTextContent('A sankey needs two dimensions.');
    pickOption(/^Dimension 1/, 'Team');
    expect(dimensionLabels(2)).not.toContain('Period');
    pickOption(/^Dimension 2/, 'Project');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([{ kind: 'team' }, { kind: 'project' }]);
    setMeasure('utilisation');
    expect(PREVIEW()).toHaveTextContent(RATIO_HIERARCHY_PROBLEM);
  });

  it('gives a treemap one or two dimensions, without Period, and refuses one of a ratio', async () => {
    renderEditor();
    chooseKind('Treemap');
    expect(screen.queryByRole('button', { name: /^Dimension 2/ })).not.toBeInTheDocument();
    expect(dimensionLabels(1)).not.toContain('Period');
    expect(PREVIEW()).toHaveTextContent('A treemap needs one or two dimensions.');
    pickOption(/^Dimension 1/, 'Site');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([{ kind: 'site' }]);
    expect(dimensionLabels(2)).not.toContain('Period');
    pickOption(/^Dimension 2/, 'Project');
    await flushPreview();
    expect(lastQuery().dimensions).toEqual([{ kind: 'site' }, { kind: 'project' }]);
    setMeasure('available_days');
    expect(PREVIEW()).toHaveTextContent(RATIO_HIERARCHY_PROBLEM);
    setTitle('Boxes');
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent(RATIO_HIERARCHY_PROBLEM);
  });

  it('offers no Percent of the first dimension on a treemap or a sankey, and drops one chosen on a bar', async () => {
    const choices = () => within(screen.getByLabelText('Percent of')).getAllByRole('option').map((o) => o.textContent);
    renderEditor();
    pickOption(/^Dimension 1/, 'Site');
    pickOption(/^Dimension 2/, 'Project');
    expect(choices()).toEqual(['None', 'Total', 'First dimension']);
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'first_dimension' } });
    for (const kind of ['Treemap', 'Sankey']) {
      chooseKind(kind);
      expect(choices()).toEqual(['None', 'Total']);
      expect(screen.getByLabelText('Percent of')).toHaveValue('');
      await flushPreview();
      expect(lastQuery()).not.toHaveProperty('percent_of');
      // A share of the total stays.
      fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'total' } });
      await flushPreview();
      expect(lastQuery()).toMatchObject({ percent_of: 'total' });
      chooseKind('Bar');
      fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'first_dimension' } });
    }
    // The heatmap keeps it.
    chooseKind('Heatmap');
    expect(choices()).toEqual(['None', 'Total', 'First dimension']);
    expect(screen.getByLabelText('Percent of')).toHaveValue('first_dimension');
  });

  it('offers a Target only on a gauge: a number from 0 to 1e9 is saved, any other text or an empty field clears it', async () => {
    const { onSave } = renderEditor();
    setTitle('Load');
    expect(screen.queryByLabelText('Target')).not.toBeInTheDocument();
    chooseKind('Gauge');
    expect(target()).toHaveAttribute('placeholder', 'No target');
    expect(target()).toHaveAttribute('inputmode', 'decimal');
    expect(target()).toHaveAttribute('type', 'text');
    expect(target()).toHaveAccessibleDescription('In weeks');
    await flushPreview();
    const saved = () => onSave.mock.calls[onSave.mock.calls.length - 1][0];

    setTarget('abc');
    expect(target()).toHaveValue('abc');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    setTarget('-5');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    setTarget('85');
    fireEvent.click(saveButton());
    expect(saved()).toMatchObject({ kind: 'gauge', options: { target: 85 } });
    // Text that is not a valid target clears the last one: the field never shows
    // one value while another is saved.
    setTarget('-5');
    expect(target()).toHaveValue('-5');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    setTarget('85');
    setTarget('85x');
    expect(target()).toHaveValue('85x');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    setTarget('85');
    setTarget('abc');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    // Past the server's cap (1e9): no target, rather than a 422 on save.
    setTarget('85');
    setTarget('2000000000');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    setTarget('1000000000');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({ target: 1_000_000_000 });
    setTarget('12,5');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({ target: 12.5 });
    setTarget('0');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({ target: 0 });
    setTarget('');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
    // A percentage measure reads its target in %; another kind drops it.
    setMeasure('utilisation');
    expect(target()).toHaveAccessibleDescription('In %');
    setTarget('90');
    chooseKind('Bar');
    expect(screen.queryByLabelText('Target')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({});
  });

  it('opens a stored gauge with its target, and saves it at the gauge size', async () => {
    const gauge: DraftWidget = {
      clientId: 'w9',
      id: 9,
      kind: 'gauge',
      title: 'Load',
      query: { measure: 'utilisation', filters: { period: { relative: 'this_quarter' } } },
      options: { target: 85, number_format: 'integer' },
      layout: { lg: { x: 0, y: 0, w: 3, h: 4 }, md: { x: 0, y: 0, w: 4, h: 4 }, sm: { x: 0, y: 0, w: 4, h: 4 } },
    };
    const { onSave } = renderEditor({ widget: gauge });
    expect(target()).toHaveValue('85');
    expect(screen.getByLabelText('Number format')).toHaveValue('integer');
    fireEvent.click(saveButton('Save Changes'));
    expect(onSave.mock.calls[0][0]).toEqual({ ...gauge, query: { measure: 'utilisation', filters: { period: { relative: 'this_quarter' } } } });
    cleanup();

    // A new gauge lands at 3 × 4 under the others.
    const { onSave: onAdd } = renderEditor({ widgets: [gauge] });
    setTitle('New gauge');
    chooseKind('Gauge');
    fireEvent.click(saveButton());
    expect(onAdd.mock.calls[0][0].layout).toEqual({
      lg: { x: 0, y: 4, w: 3, h: 4 },
      md: { x: 0, y: 4, w: 4, h: 4 },
      sm: { x: 0, y: 4, w: 4, h: 4 },
    });
    cleanup();

    // A stored target the gauge would not draw (sent through the API) is neither shown nor kept.
    const { onSave: onFix } = renderEditor({ widget: { ...gauge, options: { target: -3 } } });
    expect(target()).toHaveValue('');
    fireEvent.click(saveButton('Save Changes'));
    expect(onFix.mock.calls[0][0].options).toEqual({});
  });

  it('saves a heatmap, a treemap and a sankey with their dimensions and number format', () => {
    const cases = [
      { kind: 'Heatmap', dims: ['Team', 'Period'], sent: [{ kind: 'team' }, { kind: 'period', grain: 'month' }] },
      { kind: 'Treemap', dims: ['Site'], sent: [{ kind: 'site' }] },
      { kind: 'Sankey', dims: ['Team', 'Project'], sent: [{ kind: 'team' }, { kind: 'project' }] },
    ];
    for (const c of cases) {
      const { onSave } = renderEditor();
      setTitle(c.kind);
      chooseKind(c.kind);
      // Saving before the dimensions are chosen says why.
      fireEvent.click(saveButton());
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/needs (one or )?two dimensions/);
      c.dims.forEach((label, i) => pickOption(new RegExp(`^Dimension ${i + 1}`), label));
      expect(screen.queryByLabelText('Target')).not.toBeInTheDocument();
      expect(displaySwitches()).toEqual([]);
      fireEvent.change(screen.getByLabelText('Number format'), { target: { value: 'decimal' } });
      fireEvent.click(saveButton());
      expect(onSave.mock.calls[0][0]).toMatchObject({
        kind: c.kind.toLowerCase(),
        title: c.kind,
        query: { measure: 'booked_weeks', dimensions: c.sent },
        options: { number_format: 'decimal' },
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 } },
      });
      cleanup();
    }
  });
});

describe('WidgetEditor — options and save', () => {
  it('offers the KPI buckets the preview returns, and stores the key', async () => {
    api.query.mockResolvedValue(
      result([
        { keys: [{ key: true, label: 'Confirmed' }], value: 60 },
        { keys: [{ key: false, label: 'Not confirmed' }], value: 40 },
        { keys: [{ key: null, label: 'Not set' }], value: 0 },
      ], { unit: 'percent' })
    );
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    pickOption(/^Dimension 1/, 'Confirmed');
    await flushPreview();
    const bucket = screen.getByLabelText('Bucket');
    expect(within(bucket).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a value',
      'Confirmed',
      'Not confirmed',
    ]);
    fireEvent.change(bucket, { target: { value: 'true' } });
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Confirmed share' } });
    fireEvent.click(saveButton());
    const [saved, preview] = onSave.mock.calls[0];
    expect(saved).toMatchObject({
      kind: 'kpi',
      title: 'Confirmed share',
      query: {
        measure: 'booked_weeks',
        dimensions: [{ kind: 'confirmed' }],
        percent_of: 'total',
        filters: { period: { relative: 'this_year' } },
      },
      options: { kpi_bucket: true },
      layout: { lg: { x: 0, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } },
    });
    expect(saved.id).toBeUndefined();
    expect(saved.clientId).toMatch(/^n\d+$/);
    expect(preview?.total).toBe(100);
    // Back to no bucket
    fireEvent.change(bucket, { target: { value: '' } });
  });

  it('requires a bucket for a KPI share, then saves once one is chosen', async () => {
    api.query.mockResolvedValue(
      result(
        [
          { keys: [{ key: true, label: 'Confirmed' }], value: 60 },
          { keys: [{ key: false, label: 'Not confirmed' }], value: 40 },
        ],
        { unit: 'percent' }
      )
    );
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'KPI' }));
    pickOption(/^Dimension 1/, 'Confirmed');
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Confirmed share' } });
    await flushPreview();
    expect(api.query).toHaveBeenCalled();
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent(KPI_BUCKET_REQUIRED);
    expect(KPI_BUCKET_REQUIRED).toBe('A KPI share needs a bucket: choose the value whose share it shows.');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'true' } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].options).toEqual({ kpi_bucket: true });
  });

  it('keeps a stored bucket the preview does not hold yet', () => {
    renderEditor({
      widget: {
        clientId: 'w9',
        id: 9,
        kind: 'kpi',
        title: 'Share',
        query: { measure: 'project_count', dimensions: [{ kind: 'site' }], percent_of: 'total' },
        options: { kpi_bucket: 2 },
        layout: { lg: { x: 3, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } },
      },
    });
    expect(screen.getByLabelText('Bucket')).toHaveValue('2');
  });

  it('sets the bar options: stacked, 100 % (stacked too), orientation, number format', async () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Bars' } });
    const stacked = screen.getByRole('switch', { name: 'Stacked' });
    fireEvent.click(stacked);
    expect(stacked).toBeChecked();
    fireEvent.click(screen.getByRole('switch', { name: '100 %' }));
    expect(stacked).toBeChecked();
    expect(stacked).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Orientation'), { target: { value: 'horizontal' } });
    fireEvent.change(screen.getByLabelText('Number format'), { target: { value: 'decimal' } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].options).toEqual({
      percent: true,
      stacked: true,
      orientation: 'horizontal',
      number_format: 'decimal',
    });
    fireEvent.click(screen.getByRole('switch', { name: '100 %' }));
    fireEvent.change(screen.getByLabelText('Number format'), { target: { value: '' } });
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[1][0].options).toEqual({ stacked: true, orientation: 'horizontal' });
  });

  it('offers no Stacked or 100 % on a measure that takes no percentage, and drops a stored stack', () => {
    const { onSave } = renderEditor({
      widget: {
        clientId: 'w4',
        id: 4,
        kind: 'bar',
        title: 'Load',
        query: { measure: 'booked_weeks', dimensions: [{ kind: 'team' }, { kind: 'site' }] },
        options: { stacked: true, percent: true, orientation: 'horizontal' },
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(screen.getByRole('switch', { name: 'Stacked' })).toBeChecked();
    for (const measure of ['utilisation', 'available_days', 'people_over_capacity']) {
      setMeasure(measure);
      // A stack of percentages or of signed days adds up to nothing.
      expect(screen.queryByRole('switch', { name: 'Stacked' })).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: '100 %' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Orientation')).toHaveValue('horizontal');
    }
    fireEvent.click(saveButton('Save Changes'));
    expect(onSave.mock.calls[0][0].options).toEqual({ orientation: 'horizontal' });
    setMeasure('capacity_days');
    expect(screen.getByRole('switch', { name: '100 %' })).toBeChecked();
  });

  it('sets the legend of a line (on by default) and of a pie (off by default); a table has only the number format', () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Legend' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Line' }));
    const lineLegend = screen.getByRole('switch', { name: 'Show legend' });
    expect(lineLegend).toBeChecked();
    fireEvent.click(lineLegend);
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].options).toEqual({ show_legend: false });

    fireEvent.click(screen.getByRole('radio', { name: 'Pie' }));
    pickOption(/^Dimension 1/, 'Site');
    const pieLegend = screen.getByRole('switch', { name: 'Show legend' });
    expect(pieLegend).not.toBeChecked();
    fireEvent.click(pieLegend);
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[1][0].options).toEqual({ show_legend: true });

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(displaySwitches()).toEqual([]);
    expect(screen.getByLabelText('Number format')).toBeInTheDocument();
  });

  it('offers the Percent number format only on a percentage', () => {
    renderEditor();
    const formats = () =>
      within(screen.getByLabelText('Number format'))
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(formats()).toEqual(['Auto', 'Integer', 'Decimal']);
    pickOption(/^Dimension 1/, 'Site');
    fireEvent.change(screen.getByLabelText('Percent of'), { target: { value: 'total' } });
    expect(formats()).toEqual(['Auto', 'Integer', 'Decimal', 'Percent']);
  });

  it('requires a title', () => {
    const { onSave } = renderEditor();
    fireEvent.click(saveButton());
    expect(screen.getByText(TITLE_REQUIRED)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'x' } });
    expect(screen.queryByText(TITLE_REQUIRED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title *')).toHaveAttribute('maxLength', '120');
  });

  it('places a new widget under the others, and hands over the matching preview', async () => {
    const other: DraftWidget = {
      clientId: 'w1',
      id: 1,
      kind: 'bar',
      title: 'Above',
      query: { measure: 'booked_weeks' },
      options: {},
      layout: { lg: { x: 0, y: 0, w: 12, h: 4 }, md: { x: 0, y: 0, w: 8, h: 3 }, sm: { x: 0, y: 0, w: 4, h: 6 } },
    };
    const { onSave } = renderEditor({ widgets: [other] });
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: '  Weeks  ' } });
    await flushPreview();
    // Submitting the form (Enter in the title) saves too
    fireEvent.submit(screen.getByLabelText('Title *').closest('form')!);
    const [saved, preview] = onSave.mock.calls[0];
    expect(saved).toEqual({
      clientId: expect.stringMatching(/^n\d+$/),
      kind: 'bar',
      title: 'Weeks',
      query: { measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } },
      options: {},
      layout: { lg: { x: 0, y: 4, w: 6, h: 5 }, md: { x: 0, y: 3, w: 4, h: 5 }, sm: { x: 0, y: 6, w: 4, h: 5 } },
    });
    expect(preview).toEqual(result());
  });

  it('edits a widget in place: its id, client id and position are kept', async () => {
    const widget: DraftWidget = {
      clientId: 'w12',
      id: 12,
      kind: 'line',
      title: 'Per month',
      query: { measure: 'booked_weeks', dimensions: [{ kind: 'period', grain: 'month' }], filters: { period: { relative: 'last_12_months' } } },
      options: { show_legend: false },
      layout: { lg: { x: 6, y: 2, w: 6, h: 5 }, md: { x: 0, y: 2, w: 8, h: 5 }, sm: { x: 0, y: 7, w: 4, h: 5 } },
    };
    const { onSave, onClose } = renderEditor({ widget });
    expect(screen.getByRole('dialog', { name: 'Edit widget' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title *')).toHaveValue('Per month');
    expect(screen.getByLabelText('Grain of dimension 1')).toHaveValue('month');
    expect(periodSelect()).toHaveValue('last_12_months');
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Monthly' } });
    // The preview has not answered for this query yet: none is handed over
    fireEvent.click(saveButton('Save Changes'));
    expect(onSave).toHaveBeenCalledWith(
      {
        ...widget,
        title: 'Monthly',
        query: {
          measure: 'booked_weeks',
          dimensions: [{ kind: 'period', grain: 'month' }],
          filters: { period: { relative: 'last_12_months' } },
        },
      },
      null
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('WidgetEditor — calculated widgets, % of target, Has a customer (2.6.0)', () => {
  const chooseKind = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const setTitle = (value: string) => fireEvent.change(screen.getByLabelText('Title *'), { target: { value } });
  const target = () => screen.getByLabelText('Target') as HTMLInputElement;
  const percentSwitch = () => screen.getByRole('switch', { name: 'Show as % of target' });
  const calculation = () => screen.getByRole('switch', { name: 'Calculation' });
  const section = () => within(screen.getByRole('region', { name: 'Calculation' }));
  const formulaField = () => screen.getByLabelText('Formula') as HTMLInputElement;
  const typeFormula = (value: string) => fireEvent.change(formulaField(), { target: { value } });
  const termMeasure = (name: string) => screen.getByRole('combobox', { name: `Measure of term ${name}` });
  const termName = (name: string) => screen.getByRole('textbox', { name: `Name of term ${name}` });
  const calcResult = (extra: Partial<MetricResult> = {}): MetricResult =>
    result([{ keys: [], value: 50 }], {
      unit: 'percent',
      total: 50,
      terms: [
        { name: 'a', value: 412, unit: 'weeks' },
        { name: 'b', value: 824, unit: 'weeks' },
      ],
      ...extra,
    });

  it('offers Calculation on a KPI, a gauge, a bar, a line, a table and a heatmap only', () => {
    renderEditor();
    for (const kind of ['KPI', 'Gauge', 'Line', 'Table', 'Heatmap', 'Bar']) {
      chooseKind(kind);
      expect(calculation()).not.toBeChecked();
    }
    for (const kind of ['Pie', 'Treemap', 'Sankey']) {
      chooseKind(kind);
      expect(screen.queryByRole('switch', { name: 'Calculation' })).not.toBeInTheDocument();
    }
  });

  it('starts with nothing to type: term a is the widget, b its capacity, a / b as a percentage', async () => {
    api.query.mockResolvedValue(calcResult());
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    pickOption(/^Teams/, 'Analytics');
    fireEvent.click(calculation());
    // The top measure and filters give way to the terms.
    expect(screen.queryByRole('combobox', { name: 'Measure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Filters( \(|$)/ })).not.toBeInTheDocument();
    expect(termMeasure('a')).toHaveValue('booked_weeks');
    expect(termMeasure('b')).toHaveValue('capacity_weeks');
    expect(formulaField()).toHaveValue('a / b');
    expect(screen.getByLabelText('Result')).toHaveValue('percent');
    expect(section().getByRole('button', { name: /^Filters of term a: 1 filter: Team Analytics$/ })).toBeInTheDocument();
    expect(section().getByText('Booked weeks (team Analytics) ÷ Capacity (weeks)')).toBeInTheDocument();
    await flushPreview();
    expect(lastQuery()).toEqual({
      measure: 'booked_weeks',
      filters: { period: { relative: 'this_year' } },
      formula: {
        expression: 'a / b',
        terms: [
          { name: 'a', measure: 'booked_weeks', filters: { team_ids: [5] } },
          { name: 'b', measure: 'capacity_weeks' },
        ],
      },
    });
    // The live values of each term and of the result, and the result's examples.
    expect(section().getByText('a = 412.0 weeks')).toBeInTheDocument();
    expect(section().getByText('b = 824.0 weeks')).toBeInTheDocument();
    const fifty = formatMetric(50, 'percent');
    expect(section().getByRole('status').textContent).toBe(`= ${fifty}`);
    const resultOptions = Array.from((screen.getByLabelText('Result') as HTMLSelectElement).options).map((o) => o.text);
    expect(resultOptions).toEqual([`Percentage (${fifty})`, 'Number (0.50)']);
  });

  it('pairs booked weeks with themselves without Staff & Calendar, and lists only term measures', () => {
    signIn([...BASE]);
    renderEditor();
    fireEvent.click(calculation());
    expect(termMeasure('b')).toHaveValue('booked_weeks');
    const values = Array.from(termMeasure('a').querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('project_count');
    expect(values).not.toContain('utilisation');
    expect(values).not.toContain('capacity_weeks');
  });

  it('renames a term and its references, refusing a bad or a repeated name', async () => {
    renderEditor();
    fireEvent.click(calculation());
    typeFormula('a / (b + A)');
    fireEvent.change(termName('a'), { target: { value: 'Customer_Weeks' } });
    expect(formulaField()).toHaveValue('customer_weeks / (b + customer_weeks)');
    expect(termName('customer_weeks')).toHaveValue('Customer_Weeks');
    fireEvent.change(termName('customer_weeks'), { target: { value: '1x' } });
    expect(screen.getByText(/A term name is a lowercase word/)).toBeInTheDocument();
    expect(formulaField()).toHaveValue('customer_weeks / (b + customer_weeks)');
    fireEvent.change(termName('customer_weeks'), { target: { value: 'b' } });
    expect(screen.getByText('Two terms are named "b"')).toBeInTheDocument();
    // Leaving the field shows the name in use again.
    fireEvent.blur(termName('customer_weeks'));
    expect(termName('customer_weeks')).toHaveValue('customer_weeks');
    await flushPreview();
    expect(lastQuery().formula?.terms.map((t) => t.name)).toEqual(['customer_weeks', 'b']);
  });

  it('inserts a term or an operator at the cursor and keeps the focus in the field', () => {
    renderEditor();
    fireEvent.click(calculation());
    const field = formulaField();
    field.focus();
    field.setSelectionRange(1, 1);
    fireEvent.select(field);
    const bar = within(screen.getByRole('toolbar', { name: 'Insert into the formula' }));
    fireEvent.mouseDown(bar.getByRole('button', { name: 'Insert times' }));
    fireEvent.click(bar.getByRole('button', { name: 'Insert times' }));
    // No doubled space beside the one already there.
    expect(field).toHaveValue('a × / b');
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(3);
    fireEvent.click(bar.getByRole('button', { name: 'Insert term b (Capacity (weeks))' }));
    expect(field).toHaveValue('a × b / b');
    for (const name of ['plus', 'minus', 'divided by', 'opening bracket', 'closing bracket', 'percent']) {
      fireEvent.click(bar.getByRole('button', { name: `Insert ${name}` }));
    }
    expect(field).toHaveValue('a × b + - ÷()% / b');
    // At the end of a name, a name is glued with a space.
    typeFormula('a');
    field.setSelectionRange(1, 1);
    fireEvent.keyUp(field);
    fireEvent.click(bar.getByRole('button', { name: 'Insert term b (Capacity (weeks))' }));
    expect(field).toHaveValue('a b');
  });

  it('opens a term’s filters in place and sums them up on its row', async () => {
    renderEditor();
    fireEvent.click(calculation());
    const opener = section().getByRole('button', { name: 'Filters of term b: No filters' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Filters of term b' })).toBeInTheDocument();
    pickOption(/^Teams/, 'Process');
    expect(section().getByRole('button', { name: 'Filters of term b: 1 filter: Team Process' })).toBeInTheDocument();
    fireEvent.click(section().getByRole('button', { name: /^Filters of term b/ }));
    expect(screen.queryByRole('group', { name: 'Filters of term b' })).not.toBeInTheDocument();
    await flushPreview();
    expect(lastQuery().formula?.terms[1]).toEqual({ name: 'b', measure: 'capacity_weeks', filters: { team_ids: [6] } });
  });

  it('names the problem under the formula, keeps the last result dimmed and blocks Save', async () => {
    api.query.mockResolvedValue(calcResult());
    renderEditor();
    setTitle('Absorption');
    fireEvent.click(calculation());
    await flushPreview();
    const calls = api.query.mock.calls.length;
    typeFormula('a / capcity');
    expect(formulaField()).toHaveAccessibleDescription('"capcity" is not one of your terms: a, b');
    expect(formulaField()).toHaveValue('a / capcity');
    expect(screen.getByText(STALE_PREVIEW)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute('title', '"capcity" is not one of your terms: a, b');
    await flushPreview();
    expect(api.query.mock.calls.length).toBe(calls);
    typeFormula('(a');
    expect(formulaField()).toHaveAccessibleDescription('Missing closing bracket )');
    typeFormula('a * 0,7');
    expect(formulaField()).toHaveAccessibleDescription('Use a point for decimals: 0.7');
    typeFormula('a');
    expect(formulaField()).toHaveAccessibleDescription('Term b is not used in the formula: use it or remove it');
    typeFormula('a ÷ b');
    expect(formulaField()).toHaveAccessibleDescription(/Term names, numbers/);
    expect(screen.queryByText(STALE_PREVIEW)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('asks to fix the formula when no result came yet', () => {
    renderEditor();
    fireEvent.click(calculation());
    typeFormula('a /');
    expect(screen.getByText(FIX_FORMULA)).toBeInTheDocument();
  });

  it('shows "–" with the reason when the result has no value', async () => {
    api.query.mockResolvedValue(
      calcResult({
        total: null,
        terms: [
          { name: 'a', value: 5, unit: 'weeks' },
          { name: 'b', value: 0, unit: 'weeks' },
        ],
      })
    );
    renderEditor();
    fireEvent.click(calculation());
    await flushPreview();
    expect(section().getByRole('status')).toHaveTextContent('= – (Capacity (weeks) is 0 in this period)');
    expect(section().getByText('b = 0.0 weeks')).toBeInTheDocument();
  });

  it('adds terms up to six, removes them, and offers Use its total with a breakdown', async () => {
    const { onSave } = renderEditor();
    setTitle('Mix');
    fireEvent.click(calculation());
    const add = section().getByRole('button', { name: 'Add term' });
    for (let i = 0; i < 4; i += 1) fireEvent.click(add);
    expect(termMeasure('f')).toHaveValue('booked_weeks');
    expect(add).toBeDisabled();
    expect(section().getByText(MAX_TERMS_HINT)).toBeInTheDocument();
    expect(formulaField()).toHaveAccessibleDescription('Term c is not used in the formula: use it or remove it');
    for (const name of ['f', 'e', 'd', 'c']) fireEvent.click(section().getByRole('button', { name: `Remove term ${name}` }));
    expect(add).toBeEnabled();
    // No total switch without a breakdown beyond the period.
    expect(screen.queryByRole('switch', { name: /Use the total/ })).not.toBeInTheDocument();
    pickOption(/^Dimension 1/, 'Project');
    // Capacity has no project: term b uses its total, and must.
    const totalB = () => screen.getByRole('switch', { name: 'Use the total of term b' });
    expect(totalB()).toBeChecked();
    expect(totalB()).toBeDisabled();
    expect(screen.getByText('Capacity (weeks) has no Project: it uses its total')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use the total of term a' })).not.toBeChecked();
    pickOption(/^Dimension 1/, 'Team');
    // Capacity has a team: the switch is free again, starting from its total.
    expect(totalB()).toBeEnabled();
    fireEvent.click(totalB());
    expect(totalB()).not.toBeChecked();
    fireEvent.click(totalB());
    expect(totalB()).toBeChecked();
    // The bar is never stacked; Top N ranks the formula's values, no Percent of.
    expect(screen.queryByRole('switch', { name: 'Stacked' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Percent of')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Top N'), { target: { value: '3' } });
    fireEvent.change(termMeasure('a'), { target: { value: 'booked_days' } });
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'number' } });
    await flushPreview();
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].query).toEqual({
      measure: 'booked_days',
      dimensions: [{ kind: 'team' }],
      filters: { period: { relative: 'this_year' } },
      top_n: 3,
      formula: {
        expression: 'a / b',
        result: 'number',
        terms: [
          { name: 'a', measure: 'booked_days' },
          { name: 'b', measure: 'capacity_weeks', total: true },
        ],
      },
    });
    // A single term cannot be removed.
    fireEvent.click(section().getByRole('button', { name: 'Remove term b' }));
    expect(section().getByRole('button', { name: 'Remove term a' })).toBeDisabled();
  });

  it('offers a dimension one term accepts, and the period only when every term does', () => {
    renderEditor();
    fireEvent.click(calculation());
    expect(dimensionLabels(1)).toContain('Project');
    expect(dimensionLabels(1)).toContain('Period');
    expect(dimensionLabels(1)).not.toContain('Equipment');
    fireEvent.change(termMeasure('b'), { target: { value: 'project_volume' } });
    expect(dimensionLabels(1)).not.toContain('Period');
  });

  it('replaces the calculation by an example, asking first only when it was customised', async () => {
    const confirm = stubConfirm(false);
    renderEditor();
    fireEvent.click(calculation());
    const trigger = section().getByRole('button', { name: 'Examples' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = within(screen.getByRole('menu', { name: 'Formula examples' }));
    expect(menu.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Ratio of two measuresa / b',
      'Share of capacitya / b',
      'Against a goala / (b * 70%)',
      'Differencea - b',
      'Suma + b',
    ]);
    await act(async () => {
      fireEvent.click(menu.getByRole('menuitem', { name: /Against a goal/ }));
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(formulaField()).toHaveValue('a / (b * 70%)');
    expect(section().getByText('Booked weeks (has a customer) ÷ (Capacity (weeks) × 70 %)')).toBeInTheDocument();
    // Now customised: a cancelled confirmation keeps it.
    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /^Sum/ }));
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('“Sum”') }));
    expect(formulaField()).toHaveValue('a / (b * 70%)');
    stubConfirm(true);
    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /^Difference/ }));
    });
    expect(formulaField()).toHaveValue('a - b');
    expect(screen.getByLabelText('Result')).toHaveValue('number');
    // Escape closes the menu.
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('greys out the capacity examples without Staff & Calendar', () => {
    signIn([...BASE]);
    renderEditor();
    fireEvent.click(calculation());
    fireEvent.click(section().getByRole('button', { name: 'Examples' }));
    expect(screen.getByRole('menuitem', { name: /Share of capacity/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Against a goal/ })).toHaveAttribute('title', CAPACITY_EXAMPLE_HINT);
    expect(screen.getByRole('menuitem', { name: /^Sum/ })).toBeEnabled();
  });

  it('turns off back to term a, asking first only when the calculation was customised', async () => {
    const confirm = stubConfirm(false);
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    pickOption(/^Teams/, 'Analytics');
    fireEvent.click(calculation());
    await act(async () => {
      fireEvent.click(calculation());
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Measure')).toHaveValue('booked_weeks');
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
    fireEvent.click(calculation());
    typeFormula('a / b * 2');
    await act(async () => {
      fireEvent.click(calculation());
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: LEAVE_CALCULATION }));
    expect(calculation()).toBeChecked();
    stubConfirm(true);
    await act(async () => {
      fireEvent.click(calculation());
    });
    expect(calculation()).not.toBeChecked();
    await flushPreview();
    expect(lastQuery()).toEqual({
      measure: 'booked_weeks',
      filters: { team_ids: [5], period: { relative: 'this_year' } },
    });
  });

  it('drops the calculation on a pie, keeping term a, and gives a calculated KPI no dimension', async () => {
    renderEditor();
    fireEvent.click(calculation());
    chooseKind('KPI');
    expect(screen.queryByRole('button', { name: /^Dimension 1/ })).not.toBeInTheDocument();
    chooseKind('Pie');
    expect(screen.queryByRole('switch', { name: 'Calculation' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Measure')).toHaveValue('booked_weeks');
    chooseKind('Bar');
    expect(calculation()).not.toBeChecked();
    await flushPreview();
    expect(lastQuery().formula).toBeUndefined();
  });

  it('opens a stored calculated widget with its terms', async () => {
    const stored: DraftWidget = {
      id: 9,
      clientId: 'w9',
      kind: 'gauge',
      title: 'Customer absorption this year',
      query: {
        measure: 'booked_weeks',
        filters: { period: { relative: 'this_year' } },
        formula: {
          expression: 'customer_weeks / (capacity_weeks * 70%)',
          terms: [
            { name: 'customer_weeks', measure: 'booked_weeks', filters: { has_customer: true } },
            { name: 'capacity_weeks', measure: 'capacity_weeks' },
          ],
        },
      },
      options: { target: 100, target_is_goal: true },
      layout: { lg: { x: 0, y: 0, w: 3, h: 4 }, md: { x: 0, y: 0, w: 4, h: 4 }, sm: { x: 0, y: 0, w: 4, h: 4 } },
    };
    renderEditor({ widget: stored });
    expect(calculation()).toBeChecked();
    expect(termMeasure('customer_weeks')).toHaveValue('booked_weeks');
    expect(
      section().getByText('Booked weeks (has a customer) ÷ (Capacity (weeks) × 70 %)')
    ).toBeInTheDocument();
    await flushPreview();
    expect(lastQuery().formula?.expression).toBe('customer_weeks / (capacity_weeks * 70%)');
  });

  it('keeps a target on a KPI and shows it as a percentage of the target only with one above 0', async () => {
    const { onSave } = renderEditor();
    setTitle('Absorption');
    chooseKind('KPI');
    expect(target()).toHaveValue('');
    expect(percentSwitch()).toBeDisabled();
    fireEvent.change(target(), { target: { value: '70' } });
    expect(percentSwitch()).not.toBeDisabled();
    fireEvent.click(percentSwitch());
    expect(percentSwitch()).toBeChecked();
    // The value then reads in %: the Percent number format is offered.
    fireEvent.change(screen.getByLabelText('Number format'), { target: { value: 'percent' } });
    await flushPreview();
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].options).toEqual({ target: 70, percent_of_target: true, number_format: 'percent' });
    // A target of 0 drops the flag.
    fireEvent.change(target(), { target: { value: '0' } });
    expect(percentSwitch()).toBeDisabled();
    expect(percentSwitch()).not.toBeChecked();
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[1][0].options).toEqual({ target: 0 });
  });

  it('offers Has a customer on project-backed measures and Utilisation, with its hint', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const hasCustomer = () => screen.getByLabelText('Has a customer');
    fireEvent.change(hasCustomer(), { target: { value: 'true' } });
    await flushPreview();
    expect(lastQuery().filters).toEqual({ has_customer: true, period: { relative: 'this_year' } });
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
    setMeasure('utilisation');
    expect(
      screen.getByText('Project filters narrow the booked time only; the capacity stays that of the people in scope.')
    ).toBeInTheDocument();
    fireEvent.change(hasCustomer(), { target: { value: 'false' } });
    await flushPreview();
    expect(lastQuery()).toEqual({ measure: 'utilisation', filters: { has_customer: false, period: { relative: 'this_year' } } });
    fireEvent.change(hasCustomer(), { target: { value: 'any' } });
    await flushPreview();
    expect(lastQuery().filters).toEqual({ period: { relative: 'this_year' } });
    setMeasure('capacity_days');
    expect(screen.queryByLabelText('Has a customer')).not.toBeInTheDocument();
  });

  it('hides Has a customer with a hidden Customer field, unless a stored widget sets it', () => {
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["customer"]' } });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByLabelText('Has a customer')).not.toBeInTheDocument();
    cleanup();
    renderEditor({
      widget: {
        clientId: 'w9',
        id: 9,
        kind: 'bar',
        title: 'Stored',
        query: { measure: 'booked_days', filters: { has_customer: true, period: { relative: 'this_year' } } },
        options: {},
        layout: { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 4, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } },
      },
    });
    expect(screen.getByLabelText('Has a customer')).toHaveValue('true');
  });
});


describe('WidgetEditor — target is a goal (2.6.0)', () => {
  const chooseKind = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const goalSwitch = () => screen.getByRole('switch', { name: 'Target is a goal' });

  it('offers the switch on a gauge once the target is above 0, and saves it', async () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Absorption' } });
    chooseKind('Gauge');
    expect(goalSwitch()).toBeDisabled();
    expect(screen.getByText('Green from the target up, amber within 15 % below it')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '70' } });
    expect(goalSwitch()).not.toBeDisabled();
    fireEvent.click(goalSwitch());
    expect(goalSwitch()).toBeChecked();
    await flushPreview();
    fireEvent.click(saveButton());
    expect(onSave.mock.calls[0][0].options).toEqual({ target: 70, target_is_goal: true });
    // A KPI has no bands: no switch.
    chooseKind('KPI');
    expect(screen.queryByRole('switch', { name: 'Target is a goal' })).not.toBeInTheDocument();
  });
});
