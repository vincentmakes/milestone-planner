/**
 * TeamChecklist: a labelled group with one native checkbox per team (inside
 * its label, for the touch target), the team colour, and an "(inactive)"
 * suffix for an inactive team that is still ticked.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TeamChecklist } from '@/components/common';
import { makeTeam } from '@/test/factories';

const analytics = makeTeam({ id: 1, name: 'Analytics', color: '#3b82f6' });
const processTeam = makeTeam({ id: 2, name: 'Process', color: null });
const retired = makeTeam({ id: 3, name: 'Retired', active: false });

describe('TeamChecklist', () => {
  it('renders one labelled checkbox per team inside a named group', () => {
    render(<TeamChecklist teams={[analytics, processTeam]} selected={[2]} onChange={() => {}} label="Project teams" />);
    const group = screen.getByRole('group', { name: 'Project teams' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(within(group).getByRole('checkbox', { name: 'Analytics' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Process' })).toBeChecked();
    // The checkbox sits inside its label
    expect(boxes[0].closest('label')).toHaveTextContent('Analytics');
  });

  it('adds and removes ids on toggle', () => {
    const onChange = vi.fn();
    render(<TeamChecklist teams={[analytics, processTeam]} selected={[2]} onChange={onChange} label="Teams" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(onChange).toHaveBeenLastCalledWith([2, 1]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Process' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('marks an inactive team that is still ticked', () => {
    const { rerender } = render(
      <TeamChecklist teams={[analytics, retired]} selected={[3]} onChange={() => {}} label="Teams" />
    );
    expect(screen.getByRole('checkbox', { name: 'Retired (inactive)' })).toBeChecked();
    rerender(<TeamChecklist teams={[analytics, retired]} selected={[]} onChange={() => {}} label="Teams" />);
    expect(screen.getByRole('checkbox', { name: 'Retired' })).not.toBeChecked();
    expect(screen.queryByText('(inactive)')).not.toBeInTheDocument();
  });

  it('disables every checkbox', () => {
    const onChange = vi.fn();
    render(<TeamChecklist teams={[analytics, processTeam]} selected={[]} onChange={onChange} label="Teams" disabled />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('shows the empty text when there is no team', () => {
    render(<TeamChecklist teams={[]} selected={[]} onChange={() => {}} label="Teams" emptyText="No teams on this site." />);
    expect(screen.getByRole('group', { name: 'Teams' })).toHaveTextContent('No teams on this site.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
