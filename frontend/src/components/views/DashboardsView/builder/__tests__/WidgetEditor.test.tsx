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
import type { PermissionKey } from '@/types/permissions';
import {
  CAPACITY_HINT,
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
    expect(filterButtons()).toEqual(['Sites', 'Teams']);
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
      ['Capacity', ['Capacity (days)', 'Available days', 'Utilisation', 'People over capacity']],
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

  it('offers a Target only on a gauge: a number of zero or more is saved, other text ignored, an empty field clears it', async () => {
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
    // Text that is not a number keeps the last target.
    setTarget('85x');
    expect(target()).toHaveValue('85x');
    fireEvent.click(saveButton());
    expect(saved().options).toEqual({ target: 85 });
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
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
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
