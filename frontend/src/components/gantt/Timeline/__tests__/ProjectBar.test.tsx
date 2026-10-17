/**
 * ProjectBar tag colour: a `color` paints the bar solid with a contrasting
 * label; unconfirmed projects keep their stripe class (the stripes are a
 * ::before layer, so they combine with the inline colour).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type React from 'react';
import { ProjectBar } from '../ProjectBar';

const base = {
  left: 10,
  width: 200,
  name: 'Bioprocess Scale-Up',
  projectId: 1,
  startDate: '2026-03-01',
  endDate: '2026-03-31',
};

function bar(container: HTMLElement) {
  return container.querySelector('[data-project-id="1"]') as HTMLDivElement;
}

describe('ProjectBar colour', () => {
  it('uses the default gradient classes without a colour', () => {
    const { container } = render(<ProjectBar {...base} confirmed />);
    const el = bar(container);
    expect(el.style.background).toBe('');
    expect(el.className).toMatch(/confirmed/);
    expect(el.dataset.tagColor).toBeUndefined();
  });

  it('paints a dark tag colour with white text', () => {
    const { container } = render(<ProjectBar {...base} confirmed color="#1e3a8a" />);
    const el = bar(container);
    expect(el.style.background).toMatch(/rgb\(30, 58, 138\)|#1e3a8a/);
    expect(el.style.color).toMatch(/rgb\(255, 255, 255\)|#ffffff/);
    expect(el.className).not.toMatch(/darkText/);
    expect(el.dataset.tagColor).toBe('#1e3a8a');
  });

  it('uses dark text on a light colour and keeps the unconfirmed stripes', () => {
    const { container } = render(<ProjectBar {...base} confirmed={false} color="#fde047" />);
    const el = bar(container);
    expect(el.style.color).toMatch(/rgb\(17, 24, 39\)|#111827/);
    expect(el.className).toMatch(/unconfirmed/);
    expect(el.className).toMatch(/darkText/);
    expect(el).toHaveAttribute('data-tag-color', '#fde047');
  });
});

describe('ProjectBar touch', () => {
  it('starts a project drag from a touch with a mouse-like event', () => {
    let seen: { clientX: number; target: EventTarget; currentTarget: EventTarget; stopped: boolean } | null = null;
    const onDragStart = vi.fn((e: React.MouseEvent) => {
      // The drag hook calls these; the converted event must carry them
      e.stopPropagation();
      e.preventDefault();
      seen = { clientX: e.clientX, target: e.target, currentTarget: e.currentTarget, stopped: e.isPropagationStopped() };
    });
    const { container } = render(<ProjectBar {...base} confirmed onDragStart={onDragStart} />);
    const el = bar(container);

    fireEvent.touchStart(el, { touches: [{ clientX: 42, clientY: 7 }] });

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0][0]).toMatchObject({ type: 'mousedown', button: 0, buttons: 1 });
    expect(seen).toEqual({ clientX: 42, target: el, currentTarget: el, stopped: true });
    expect(el.className).toMatch(/interactive/);
  });

  it('ignores touches on a read-only bar', () => {
    const { container } = render(<ProjectBar {...base} confirmed />);
    const el = bar(container);
    expect(() => fireEvent.touchStart(el, { touches: [{ clientX: 1, clientY: 1 }] })).not.toThrow();
    expect(el.className).not.toMatch(/interactive/);
  });
});
