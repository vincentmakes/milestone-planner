/**
 * A phase bar's label must stay readable on any bar colour: dark bars get
 * white text, light ones dark text (barTextColor), on every bar — not only
 * when the Gantt is coloured by a tag group.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PhaseBar } from '../PhaseBar';

function renderBar(color: string) {
  const { container } = render(<PhaseBar left={0} width={120} color={color} name="Design" phaseId={1} projectId={1} />);
  return container.firstChild as HTMLElement;
}

describe('PhaseBar text colour', () => {
  it('uses white text on a dark bar', () => {
    const bar = renderBar('#1e3a8a');
    expect(bar.style.backgroundColor).toMatch(/rgb\(30, 58, 138\)|#1e3a8a/);
    expect(bar.style.color).toMatch(/rgb\(255, 255, 255\)|#ffffff/);
    expect(bar.className).not.toMatch(/darkText/);
  });

  it('uses dark text, without the shadow class, on a light bar', () => {
    const bar = renderBar('#fde047');
    expect(bar.style.color).toMatch(/rgb\(17, 24, 39\)|#111827/);
    expect(bar.className).toMatch(/darkText/);
  });

  it('falls back to white text on an unparsable colour', () => {
    const bar = renderBar('var(--phase-color-1)');
    expect(bar.style.color).toMatch(/rgb\(255, 255, 255\)|#ffffff/);
  });
});
