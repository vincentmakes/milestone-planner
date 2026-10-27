/**
 * The app's icons are Material icons drawn through `Icon`: decorative
 * (`aria-hidden`) unless given a title, sized in compact px times the
 * stylesheet's `--icon-scale`, coloured by the text.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Icon } from '../Icon';
import * as icons from '../icons';
import { IconStyles } from '../IconStyles';
import { iconStyleCache } from '../iconStyleCache';

const names = Object.keys(icons) as Array<keyof typeof icons>;

describe('Icon', () => {
  it('renders a decorative svg at 16 px times the icon scale by default', () => {
    const { container } = render(<Icon icon={icons.EditIcon} />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg.style.fontSize).toBe('calc(16px * var(--icon-scale))');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  });

  it('takes a size and a class name', () => {
    const { container } = render(<Icon icon={icons.CheckIcon} size={12} className="tick" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.style.fontSize).toBe('calc(12px * var(--icon-scale))');
    expect(svg).toHaveClass('tick');
  });

  it('becomes an image with an accessible name when given a title', () => {
    render(<Icon icon={icons.WarningIcon} title="Booking conflict" />);
    const img = screen.getByRole('img', { name: 'Booking conflict' });
    expect(img).not.toHaveAttribute('aria-hidden');
  });

  it.each(names)('%s is a Material icon component', (name) => {
    const { container } = render(<Icon icon={icons[name]} size={11} />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('exports the names the Settings panels and the Button callers use', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'EditIcon',
        'TrashIcon',
        'UnlinkIcon',
        'PlusIcon',
        'DownloadIcon',
        'UploadIcon',
        'RefreshIcon',
        'BackIcon',
        'GearIcon',
        'LogoutIcon',
        'DragHandleIcon',
        'CheckIcon',
        'CloseIcon',
        'CheckCircleIcon',
        'CircleIcon',
        'PinIcon',
        'PinOffIcon',
      ])
    );
  });
});

describe('IconStyles', () => {
  it('prepends the icon rules so app stylesheets win a tie', () => {
    expect(iconStyleCache.key).toBe('mui');
    expect(iconStyleCache.sheet.prepend).toBe(true);
  });

  it('renders its children with the icon style cache', () => {
    render(
      <IconStyles>
        <Icon icon={icons.BellIcon} title="Notifications" />
      </IconStyles>
    );
    const svg = screen.getByRole('img', { name: 'Notifications' });
    expect(svg.getAttribute('class')).toMatch(/\bmui-/);
  });
});
