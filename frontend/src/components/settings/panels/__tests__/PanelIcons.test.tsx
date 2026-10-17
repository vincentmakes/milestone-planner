/**
 * PanelIcons are decorative: every icon is `aria-hidden`, sized by its
 * `size` prop and coloured with `currentColor`, so a button's accessible
 * name is its label alone (UI_GUIDELINES §3 icon-only buttons).
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import * as icons from '../PanelIcons';

const names = Object.keys(icons) as Array<keyof typeof icons>;

describe('PanelIcons', () => {
  it('exports the row-action icons the Settings panels use', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'EditIcon',
        'TrashIcon',
        'CheckIcon',
        'CloseIcon',
        'CheckCircleIcon',
        'CircleIcon',
        'DownloadIcon',
        'PlusIcon',
        'BackIcon',
      ])
    );
  });

  it.each(names)('%s renders a hidden currentColor svg at the requested size', (name) => {
    const Icon = icons[name];
    const { container } = render(<Icon size={11} />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '11');
    expect(svg).toHaveAttribute('height', '11');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg.getAttribute('stroke') ?? svg.getAttribute('fill')).toBe('currentColor');
  });
});
