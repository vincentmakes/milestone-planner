/**
 * NumberFieldInput: a number with a format refuses a keystroke adding
 * decimals past it, pads on blur and steps by its last decimal; As typed
 * takes anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumberFieldInput } from '../ProjectFieldInputs';

function Harness({ decimals, initial = '', onChange = vi.fn() }: { decimals: number | null; initial?: string; onChange?: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberFieldInput
      label="Amount"
      decimals={decimals}
      value={value}
      onChange={(text) => {
        onChange(text);
        setValue(text);
      }}
      placeholder="0"
    />
  );
}

describe('NumberFieldInput', () => {
  it('refuses a third decimal at 2 and pads on blur', () => {
    const onChange = vi.fn();
    render(<Harness decimals={2} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    expect(input).toHaveAttribute('step', '0.01');
    expect(input).toHaveAttribute('placeholder', '0');

    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.change(input, { target: { value: '3.141' } });
    expect(input).toHaveDisplayValue('3.14');
    expect(onChange).not.toHaveBeenCalledWith('3.141');

    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    expect(input).toHaveDisplayValue('3.00');
  });

  it('refuses a decimal point at 0', () => {
    render(<Harness decimals={0} initial="12" />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '12.5' } });
    expect(input).toHaveDisplayValue('12');
    expect(input).toHaveAttribute('step', '1');
  });

  it('takes any decimals as typed and leaves them on blur', () => {
    render(<Harness decimals={null} />);
    const input = screen.getByLabelText('Amount');
    expect(input).toHaveAttribute('step', 'any');
    fireEvent.change(input, { target: { value: '3.14159' } });
    fireEvent.blur(input);
    expect(input).toHaveDisplayValue('3.14159');
  });

  it('can be disabled', () => {
    render(<NumberFieldInput label="Amount" decimals={1} value="1.0" onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('Amount')).toBeDisabled();
  });
});
