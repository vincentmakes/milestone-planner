/**
 * The allocation slider is shared by the Gantt's assignment dialog and the
 * Kanban card, which use it in opposite ways: one is a controlled form field
 * saved on submit, the other persists each change. Both contracts are here.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AllocationSlider } from '../AllocationSlider';

const slider = () => screen.getByLabelText('Allocation') as HTMLInputElement;

describe('AllocationSlider', () => {
  it('is a 5-to-100 range in steps of 5', () => {
    render(<AllocationSlider value={50} aria-label="Allocation" />);
    expect(slider()).toHaveAttribute('type', 'range');
    expect(slider()).toHaveAttribute('min', '5');
    expect(slider()).toHaveAttribute('max', '100');
    expect(slider()).toHaveAttribute('step', '5');
  });

  it('reports every step to onChange, for a form that saves on submit', () => {
    const onChange = vi.fn();
    render(<AllocationSlider value={50} onChange={onChange} aria-label="Allocation" />);
    fireEvent.change(slider(), { target: { value: '60' } });
    fireEvent.change(slider(), { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(70);
  });

  it('reports only the released value to onCommit, for a caller that persists', async () => {
    const onCommit = vi.fn();
    render(<AllocationSlider value={50} onCommit={onCommit} aria-label="Allocation" />);
    const input = slider();
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.pointerUp(input);

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(75);
  });

  it('commits once when the caller disables it mid-save', async () => {
    // Disabling a focused slider blurs it, and blur is also a commit trigger.
    // Without a re-entrancy guard that writes the same value twice.
    const onCommit = vi.fn();
    render(<AllocationSlider value={50} onCommit={onCommit} aria-label="Allocation" />);
    const input = slider();
    fireEvent.change(input, { target: { value: '65' } });
    fireEvent.pointerUp(input);
    fireEvent.blur(input);

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
  });

  it('does not commit a value the user landed back on', async () => {
    const onCommit = vi.fn();
    render(<AllocationSlider value={50} onCommit={onCommit} aria-label="Allocation" />);
    const input = slider();
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.pointerUp(input);

    await act(async () => {
      await Promise.resolve();
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits on keyboard use as well as dragging', async () => {
    const onCommit = vi.fn();
    render(<AllocationSlider value={50} onCommit={onCommit} aria-label="Allocation" />);
    const input = slider();
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.keyUp(input, { key: 'ArrowRight' });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(55));
  });

  it('holds the chosen value until the caller has saved and refreshed it', async () => {
    // Clearing the draft on release would snap the thumb back to the old
    // number and jump forward again when the reload lands.
    let resolveSave: () => void = () => {};
    const onCommit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveSave = r;
        })
    );
    render(<AllocationSlider value={50} onCommit={onCommit} aria-label="Allocation" compact />);
    fireEvent.change(slider(), { target: { value: '75' } });
    fireEvent.pointerUp(slider());

    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(screen.getByText('75%')).toBeInTheDocument(); // still 75 mid-save
    await act(async () => {
      resolveSave();
    });
  });

  it('warns when the booking exceeds the person capacity', () => {
    render(<AllocationSlider value={80} maxCapacity={60} aria-label="Allocation" />);
    expect(screen.getByText(/exceeds staff's max capacity of 60%/)).toBeInTheDocument();
  });

  it('says nothing about capacity when it is unknown', () => {
    render(<AllocationSlider value={80} aria-label="Allocation" />);
    expect(screen.queryByText(/exceeds staff/)).not.toBeInTheDocument();
    expect(slider()).not.toHaveAttribute('title');
  });

  it('drops the tick marks and warning box in compact mode', () => {
    render(<AllocationSlider value={80} maxCapacity={60} compact aria-label="Allocation" />);
    // A list row shows the number and the track, nothing else.
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.queryByText(/exceeds staff/)).not.toBeInTheDocument();
    expect(screen.queryByText('50%')).not.toBeInTheDocument();
    // The over-capacity signal survives as the tooltip.
    expect(slider()).toHaveAttribute('title', "Above this person's maximum capacity of 60%");
  });
});
