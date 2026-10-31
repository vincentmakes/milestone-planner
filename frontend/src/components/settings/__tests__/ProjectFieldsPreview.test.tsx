/**
 * The preview card of Settings › Project fields: the Gantt details of a
 * sample project by default, the project dialog's field section on the other
 * chip; it follows the settings it is given (labels, hidden fields, Gantt
 * rows) and nothing in its body can take focus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ProjectFieldsPreview } from '../panels/ProjectFieldsPreview';
import { useAppStore } from '@/stores/appStore';
import { makeProjectField, makeProjectFieldOption, makeTag } from '@/test/factories';
import type { InstanceSettings, ProjectField } from '@/types';

const internal = makeProjectFieldOption({ id: 11, name: 'Internal', color: '#6366f1', sort_order: 0 });
const external = makeProjectFieldOption({ id: 12, name: 'External', color: '#0ea5e9', sort_order: 1 });
const qa = makeProjectFieldOption({ id: 21, name: 'QA', color: '#10b981', sort_order: 0 });
const process = makeProjectFieldOption({ id: 22, name: 'Process', color: '#f97316', sort_order: 1 });
const FIELDS: ProjectField[] = [
  makeProjectField({ id: 1, name: 'Project type', field_type: 'select', options: [internal, external] }),
  makeProjectField({ id: 2, name: 'Area', field_type: 'multiselect', options: [qa, process] }),
  makeProjectField({ id: 3, name: 'Budget', field_type: 'number', decimals: 2 }),
  makeProjectField({ id: 4, name: 'Regulated', field_type: 'toggle' }),
  makeProjectField({ id: 5, name: 'Reference', field_type: 'text' }),
];

const ALL_ROWS =
  '["customer","pm","sales_pm","volume","confirmed","tags","period","completion","work_days","total_days","staff",1,2,3,4,5]';

beforeEach(() => {
  useAppStore.setState({
    tags: [
      makeTag({ id: 1, name: 'Pilot', color: '#22c55e', sort_order: 0 }),
      makeTag({ id: 2, name: 'Urgent', color: '#ef4444', sort_order: 1 }),
      makeTag({ id: 3, name: 'Third', sort_order: 2 }),
    ],
    bankHolidayDates: new Set(),
  });
});

function renderPreview(settings: InstanceSettings | null, fields = FIELDS) {
  return render(<ProjectFieldsPreview settings={settings} fields={fields} />);
}

const body = () => within(screen.getByTestId('pf-preview-body'));
const chip = (name: string) => within(screen.getByRole('group', { name: 'Preview of' })).getByRole('button', { name });

describe('ProjectFieldsPreview', () => {
  it('shows the Gantt details of the sample project by default', () => {
    renderPreview(null);
    expect(chip('Gantt details')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Project dialog')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pf-preview-body')).toHaveAttribute('aria-hidden', 'true');

    // The default rows
    expect(body().getByText('Sample project')).toBeInTheDocument();
    expect(body().getByText('Customer:').nextSibling).toHaveTextContent('Example Ltd');
    expect(body().getByText('PM:').nextSibling).toHaveTextContent('A. Manager');
    expect(body().getByText('Confirmed:').nextSibling).toHaveTextContent('Yes');
    expect(body().getByText('Pilot')).toBeInTheDocument();
    expect(body().getByText('Urgent')).toBeInTheDocument();
    expect(body().queryByText('Third')).not.toBeInTheDocument();
    expect(body().getByText('Completion:').nextSibling).toHaveTextContent('42% (calc)');
    expect(body().getByText('Total:').nextSibling).toHaveTextContent('90 days');
    expect(body().getByText('A. Researcher')).toBeInTheDocument();
    expect(body().queryByText('Sales PM:')).not.toBeInTheDocument();
    expect(body().queryByText('Volume:')).not.toBeInTheDocument();
    expect(body().queryByText('Budget:')).not.toBeInTheDocument();
  });

  it('shows a sample value of each type in the Gantt details, with the labels and Volume format', () => {
    renderPreview({
      project_tooltip_rows: ALL_ROWS,
      project_field_labels: '{"volume":"Litres","confirmed":"Won"}',
      volume_decimals: '0',
    });
    expect(body().getByText('Sales PM:').nextSibling).toHaveTextContent('S. Contact');
    expect(body().getByText('Litres:').nextSibling).toHaveTextContent('13');
    expect(body().getByText('Won:').nextSibling).toHaveTextContent('Yes');
    expect(body().getByText('Project type:')).toBeInTheDocument();
    expect(body().getByText('Internal')).toBeInTheDocument();
    expect(body().getByText('QA')).toBeInTheDocument();
    expect(body().getByText('Process')).toBeInTheDocument();
    expect(body().getByText('Budget:').nextSibling).toHaveTextContent('12.50');
    expect(body().getByText('Regulated:').nextSibling).toHaveTextContent('Yes');
    expect(body().getByText('Reference:').nextSibling).toHaveTextContent('Sample text');
  });

  it('drops a row whose Gantt switch is off, and a hidden field from both cards', () => {
    renderPreview({
      project_tooltip_rows: '["customer","pm","tags",3]',
      project_fields_hidden: '["customer","sales_pm"]',
    });
    expect(body().queryByText('Customer:')).not.toBeInTheDocument();
    expect(body().queryByText('Confirmed:')).not.toBeInTheDocument();
    expect(body().queryByText('Period:')).not.toBeInTheDocument();
    expect(body().getByText('PM:')).toBeInTheDocument();
    expect(body().getByText('Budget:')).toBeInTheDocument();

    fireEvent.click(chip('Project dialog'));
    expect(chip('Project dialog')).toHaveAttribute('aria-pressed', 'true');
    expect(body().queryByLabelText('Customer')).not.toBeInTheDocument();
    expect(body().queryByLabelText('Sales PM')).not.toBeInTheDocument();
    expect(body().getByLabelText('Volume')).toBeInTheDocument();
  });

  it('shows the dialog fields with the live labels and sample values per type', () => {
    renderPreview({ project_field_labels: '{"customer":"Client","confirmed":"Won"}', volume_decimals: 'any' });
    fireEvent.click(chip('Project dialog'));

    expect(body().getByLabelText('Project Manager')).toHaveValue('A. Manager');
    expect(body().getByLabelText('Client')).toHaveValue('Example Ltd');
    expect(body().getByLabelText('Sales PM')).toHaveValue('S. Contact');
    expect(body().getByLabelText('Volume')).toHaveValue(12.5);
    expect(body().getByLabelText('Project type')).toHaveValue('11');
    expect(body().getByText('QA, Process')).toBeInTheDocument();
    expect(body().getByLabelText('Budget')).toHaveValue(12.5);
    expect(body().getByLabelText('Regulated')).toBeChecked();
    expect(body().getByLabelText('Reference')).toHaveValue('Sample text');
    expect(body().getByLabelText('Won')).toBeChecked();
    expect(body().getByText('Pilot')).toBeInTheDocument();
    // No "Manage fields…" in a preview
    expect(body().queryByText('Manage fields…')).not.toBeInTheDocument();

    fireEvent.click(chip('Gantt details'));
    expect(body().getByText('Client:')).toBeInTheDocument();
  });

  it('says so when there is no tag to show', () => {
    useAppStore.setState({ tags: [] });
    renderPreview(null);
    fireEvent.click(chip('Project dialog'));
    expect(body().getByText('No tags')).toBeInTheDocument();
  });

  it('has nothing focusable in its body, in either card', () => {
    renderPreview({ project_tooltip_rows: ALL_ROWS });
    const focusable = () =>
      [...screen.getByTestId('pf-preview-body').querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.tabIndex !== -1
      );
    expect(focusable()).toEqual([]);
    fireEvent.click(chip('Project dialog'));
    expect(screen.getByTestId('pf-preview-body').querySelectorAll('input, select, button').length).toBeGreaterThan(5);
    expect(focusable()).toEqual([]);
  });
});
