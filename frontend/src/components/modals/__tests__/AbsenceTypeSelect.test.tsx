/**
 * AbsenceTypeSelect is the shared Select with the type's colour dot in its
 * icon slot: the dot is decorative (aria-hidden), the control keeps its own
 * id / aria-label and maps the value to a number or null.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AbsenceTypeSelect } from '../AbsenceTypeSelect';
import type { AbsenceType } from '@/types';

const TYPES: AbsenceType[] = [
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 0, is_active: true },
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 1, is_active: true },
  { id: 5, name: 'Sabbatical', color: '#22c55e', counts_as_unavailable: true, sort_order: 2, is_active: false },
];

describe('AbsenceTypeSelect', () => {
  it('puts an aria-hidden colour dot in the Select icon slot and is reachable by its aria-label', () => {
    render(<AbsenceTypeSelect value={1} onChange={() => {}} types={TYPES} aria-label="Absence type" />);

    const select = screen.getByLabelText('Absence type') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('1');

    // The icon slot is the select's previous sibling; the dot inside it is decorative
    const slot = select.previousElementSibling as HTMLElement;
    expect(slot).not.toBeNull();
    const dot = slot.firstElementChild as HTMLElement;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.getAttribute('style')).toContain('#8b5cf6');
  });

  it('keeps the id for an external label and lists active types, "(available)" and no "No type"', () => {
    render(
      <>
        <label htmlFor="absence-type">Type</label>
        <AbsenceTypeSelect id="absence-type" value={2} onChange={() => {}} types={TYPES} />
      </>
    );
    const select = screen.getByLabelText('Type') as HTMLSelectElement;
    expect(select.id).toBe('absence-type');
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['Home Office (available)', 'Holidays']);
  });

  it('offers "No type" for an untyped value and maps changes to a number or null', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AbsenceTypeSelect value={null} onChange={onChange} types={TYPES} aria-label="Absence type" />
    );
    const select = screen.getByLabelText('Absence type') as HTMLSelectElement;
    expect(select.options[0].text).toBe('No type');
    expect(select.options[0].disabled).toBe(false);
    fireEvent.change(select, { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith(1);

    // An inactive current type stays selectable, labelled as such
    rerender(<AbsenceTypeSelect value={5} onChange={onChange} types={TYPES} aria-label="Absence type" />);
    expect(Array.from(select.options).map((o) => o.text)).toContain('Sabbatical (inactive)');
    expect(select.value).toBe('5');

    rerender(<AbsenceTypeSelect value={null} onChange={onChange} types={TYPES} aria-label="Absence type" />);
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
