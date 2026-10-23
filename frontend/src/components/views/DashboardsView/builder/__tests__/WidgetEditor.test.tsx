/**
 * WidgetEditor: the kind rules (KPI ≤ 1 dimension as a share, pie exactly
 * one), the dimension choices from the measure matrix (with the
 * views.staff / views.archived gates and one choice per dropdown or toggle
 * field), a measure change dropping a refused dimension, the debounced
 * preview (stale answers ignored, 422 → Notice + Save disabled, a network
 * failure → "Preview unavailable"), the custom period, the KPI bucket from
 * the preview, the filters, and the widget handed to the builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import {
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
import { PREVIEW_DELAY_MS, PREVIEW_UNAVAILABLE, TITLE_REQUIRED, WidgetEditor } from '../WidgetEditor';
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
  total: rows.reduce((sum, r) => sum + r.value, 0),
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

  it('moves through the kinds with the arrow keys, as one radio group', () => {
    renderEditor();
    const group = screen.getByRole('radiogroup', { name: 'Kind' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['KPI', 'Bar', 'Line', 'Pie', 'Table']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Line' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Line' }));
    fireEvent.keyDown(radios[2], { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[4], { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'KPI' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[0], { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[4], { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'KPI' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[0], { key: 'ArrowUp' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radios[4], { key: 'a' });
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
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
    expect(dimensionLabels(1)).not.toContain('Lab work');
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
