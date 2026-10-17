/**
 * Shared form controls (Input, Select) and the right-click ContextMenu:
 * labels wired to the control, error vs hint text, icons, placeholder option,
 * ref forwarding, and the menu's click/Escape/outside-click closing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Input } from '../Input';
import { Select } from '../Select';
import { ContextMenu } from '../ContextMenu';

describe('Input', () => {
  it('links the label, forwards the ref and passes props through', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Input ref={ref} label="Project name" defaultValue="x" onChange={onChange} hint="Shown in the Gantt" />);
    const input = screen.getByLabelText('Project name');
    expect(ref.current).toBe(input);
    expect(input.id).toMatch(/^input-/);
    expect(screen.getByText('Shown in the Gantt')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'y' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('shows the error instead of the hint, with icons and a custom id', () => {
    const { container } = render(
      <Input
        id="email"
        label="Email"
        error="Required"
        hint="hidden"
        leftIcon={<i data-testid="left" />}
        rightIcon={<i data-testid="right" />}
        fullWidth
        className="extra"
      />
    );
    expect(screen.getByLabelText('Email').id).toBe('email');
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.getByTestId('left')).toBeInTheDocument();
    expect(screen.getByTestId('right')).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain('extra');
  });

  it('renders without a label', () => {
    render(<Input placeholder="Search" />);
    expect(screen.getByPlaceholderText('Search')).toBeInTheDocument();
    expect(screen.queryByText(/./, { selector: 'label' })).not.toBeInTheDocument();
  });
});

describe('Select', () => {
  const options = [
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'year', label: 'Year', disabled: true },
  ];

  it('renders the options with a placeholder and reports changes', () => {
    const ref = createRef<HTMLSelectElement>();
    const onChange = vi.fn();
    render(<Select ref={ref} label="Zoom" options={options} placeholder="Choose…" defaultValue="" onChange={onChange} hint="Timeline scale" />);
    const select = screen.getByLabelText('Zoom');
    expect(ref.current).toBe(select);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose…', 'Week', 'Month', 'Year']);
    expect(screen.getByRole('option', { name: 'Year' })).toBeDisabled();
    expect(screen.getByText('Timeline scale')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'month' } });
    expect(onChange).toHaveBeenCalled();
    expect(select).toHaveValue('month');
  });

  it('shows an error and an icon', () => {
    render(<Select id="mode" label="Mode" options={options} error="Pick one" hint="hidden" icon={<i data-testid="icon" />} fullWidth />);
    expect(screen.getByLabelText('Mode').id).toBe('mode');
    expect(screen.getByText('Pick one')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});

describe('ContextMenu', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function menu(onClose = vi.fn()) {
    const edit = vi.fn();
    const remove = vi.fn();
    const locked = vi.fn();
    render(
      <div>
        <span>outside</span>
        <ContextMenu
          x={100}
          y={50}
          onClose={onClose}
          items={[
            { label: 'Edit', onClick: edit, icon: <i data-testid="edit-icon" /> },
            { label: '', onClick: vi.fn(), divider: true },
            { label: 'Locked', onClick: locked, disabled: true, title: 'Read-only' },
            { label: 'Delete', onClick: remove, danger: true },
          ]}
        />
      </div>
    );
    return { onClose, edit, remove, locked };
  }

  it('runs an item and closes', () => {
    const { onClose, edit } = menu();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit', 'Locked', 'Delete']);
    expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(edit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores disabled items', () => {
    const { onClose, locked } = menu();
    const item = screen.getByRole('button', { name: 'Locked' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'Read-only');
    fireEvent.click(item);
    expect(locked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and on an outside click, not on an inside click', () => {
    const { onClose } = menu();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Delete' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves back inside the viewport when it would overflow', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 150,
      top: 0,
      left: 0,
      right: 200,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    render(
      <ContextMenu
        x={window.innerWidth - 50}
        y={window.innerHeight - 20}
        onClose={vi.fn()}
        items={[{ label: 'Edit', onClick: vi.fn() }]}
      />
    );
    const el = screen.getByRole('button', { name: 'Edit' }).parentElement as HTMLElement;
    expect(el.style.left).toBe(`${window.innerWidth - 208}px`);
    expect(el.style.top).toBe(`${window.innerHeight - 158}px`);
  });
});
