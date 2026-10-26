/**
 * FieldChoiceDropdown: the shared "pick one" shell of Group by / Colour by —
 * radios in the order given (numeric and string ids), nothing rendered
 * without choices, the footer slot, and the close rules (Escape captured with
 * focus back on the trigger, focus-out, outside mousedown).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FieldChoiceDropdown } from '../FieldChoiceDropdown';
import type { FieldChoice, FieldChoiceDropdownProps } from '../FieldChoiceDropdown';

const choices: FieldChoice<number | 'tags'>[] = [
  { id: 2, name: 'Zeta' },
  { id: 1, name: 'Alpha' },
  { id: 'tags', name: 'Tags' },
];

function renderShell(props: Partial<FieldChoiceDropdownProps<number | 'tags'>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <>
      <FieldChoiceDropdown<number | 'tags'>
        triggerLabel="Pick"
        activeLabel={(c) => `Picked ${c.name}`}
        idleTitle="Pick something"
        headerLabel="Pick one"
        dialogLabel="Pick dialog"
        radioGroupLabel="Pick choices"
        noneLabel="Nothing"
        icon={<span data-testid="icon" />}
        value={null}
        choices={choices}
        onChange={onChange}
        {...props}
      />
      <button type="button">Elsewhere</button>
    </>
  );
  return { ...utils, onChange };
}

function open(name: RegExp | string = 'Pick') {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('dialog', { name: 'Pick dialog' });
}

describe('FieldChoiceDropdown', () => {
  it('renders nothing without choices', () => {
    const { container } = render(
      <FieldChoiceDropdown
        triggerLabel="Pick"
        activeLabel={(c) => c.name}
        idleTitle=""
        headerLabel=""
        dialogLabel=""
        radioGroupLabel=""
        noneLabel=""
        icon={null}
        value={null}
        choices={[]}
        onChange={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists "none" then the choices in the order given and reports picks by id', () => {
    const { onChange } = renderShell();
    const trigger = screen.getByRole('button', { name: 'Pick' });
    expect(trigger).toHaveAttribute('title', 'Pick something');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).not.toHaveAttribute('aria-controls');
    const dialog = open();
    expect(trigger).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).getByText('Pick one')).toBeInTheDocument();

    const radios = within(within(dialog).getByRole('radiogroup', { name: 'Pick choices' })).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['Nothing', 'Zeta', 'Alpha', 'Tags']);
    expect(radios[0]).toBeChecked();

    fireEvent.click(radios[2]);
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(radios[3]);
    expect(onChange).toHaveBeenLastCalledWith('tags');
  });

  it('checks the current value by id, names the trigger after it and reports "none" as null', () => {
    const { onChange } = renderShell({ value: { id: 'tags', name: 'Tags' }, footer: <p>Footer</p> });
    const trigger = screen.getByRole('button', { name: 'Picked Tags' });
    expect(trigger).toHaveAttribute('title', 'Picked Tags');
    expect(trigger.className).toMatch(/active/);
    const dialog = open('Picked Tags');
    expect(within(dialog).getByRole('radio', { name: 'Tags' })).toBeChecked();
    expect(within(dialog).getByText('Footer')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Nothing' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('toggles from its trigger and is disabled on request', () => {
    const { rerender } = renderShell();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <FieldChoiceDropdown
        triggerLabel="Pick"
        activeLabel={(c) => c.name}
        idleTitle=""
        headerLabel=""
        dialogLabel="Pick dialog"
        radioGroupLabel=""
        noneLabel=""
        icon={null}
        value={null}
        choices={[{ id: 1, name: 'One' }]}
        onChange={() => {}}
        disabled
      />
    );
    expect(screen.getByRole('button', { name: 'Pick' })).toBeDisabled();
  });

  it('closes on Escape without letting it reach the app shortcuts, and returns focus', () => {
    renderShell();
    const dialog = open();
    const listener = vi.fn();
    document.addEventListener('keydown', listener);
    try {
      fireEvent.keyDown(within(dialog).getByRole('radio', { name: 'Alpha' }), { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', listener);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(listener).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pick' })).toHaveFocus();
  });

  it('portals the panel right-aligned to the trigger; a mousedown in it keeps it open', () => {
    renderShell();
    const dialog = open();
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('data-align', 'end');
    fireEvent.mouseDown(within(dialog).getByRole('radio', { name: 'Alpha' }));
    expect(screen.getByRole('dialog', { name: 'Pick dialog' })).toBeInTheDocument();
  });

  it('closes when focus leaves it, and on an outside mousedown', () => {
    renderShell();
    const dialog = open();
    fireEvent.blur(within(dialog).getByRole('radio', { name: 'Alpha' }), {
      relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }),
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    open();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
