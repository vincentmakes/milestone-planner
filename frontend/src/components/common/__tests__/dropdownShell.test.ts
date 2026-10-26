/**
 * dropdownShell: `revealPanel` scrolls the open panel into view only when it
 * ends below the visible bottom of its scroll container (or the window) — its
 * bottom, or its top when it is taller than the visible area — and the row styles let the hint and the note give way before the
 * name in a narrow row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealPanel } from '../dropdownShell';

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

/** A panel inside a scrolling dialog body showing 100–300 (client height 200). */
function mount(panelBottom: number, panelHeight = 150) {
  const body = document.createElement('div');
  body.style.overflowY = 'auto';
  Object.defineProperty(body, 'clientHeight', { value: 200 });
  body.getBoundingClientRect = () => rect(100, 320); // 20 px of horizontal scrollbar under the client area
  const wrapper = document.createElement('div');
  const panel = document.createElement('div');
  panel.getBoundingClientRect = () => rect(panelBottom - panelHeight, panelBottom);
  const scrollIntoView = vi.fn();
  panel.scrollIntoView = scrollIntoView;
  wrapper.appendChild(panel);
  body.appendChild(wrapper);
  document.body.appendChild(body);
  return { panel, scrollIntoView };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('revealPanel', () => {
  it('aligns the panel bottom with the scroll container when it ends below its visible bottom', () => {
    const { panel, scrollIntoView } = mount(315);
    revealPanel(panel);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', inline: 'nearest' });
  });

  it('aligns the top of a panel taller than the visible area, so the search box stays whole', () => {
    const { panel, scrollIntoView } = mount(420, 201);
    revealPanel(panel);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' });
  });

  it('aligns the bottom of a panel exactly as tall as the visible area', () => {
    const { panel, scrollIntoView } = mount(420, 200);
    revealPanel(panel);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', inline: 'nearest' });
  });

  it('leaves a panel that already fits where it is', () => {
    const { panel, scrollIntoView } = mount(300);
    revealPanel(panel);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('measures against the window without a scroll container, and ignores a missing panel', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const scrollIntoView = vi.fn();
    panel.scrollIntoView = scrollIntoView;
    panel.getBoundingClientRect = () => rect(0, window.innerHeight);
    revealPanel(panel);
    expect(scrollIntoView).not.toHaveBeenCalled();
    panel.getBoundingClientRect = () => rect(10, window.innerHeight + 1);
    revealPanel(panel);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'end', inline: 'nearest' });
    panel.getBoundingClientRect = () => rect(-10, window.innerHeight + 1);
    revealPanel(panel);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start', inline: 'nearest' });
    expect(() => revealPanel(null)).not.toThrow();
  });
});

describe('dropdown row styles', () => {
  const css = readFileSync(join(__dirname, '..', 'dropdownShell.module.css'), 'utf8');
  const rule = (selector: RegExp) => css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  it('keeps the name readable first: the hint and the note shrink and ellipsise', () => {
    expect(rule(/\n\.name/)).toMatch(/flex-shrink: 0;/);
    expect(rule(/\n\.name/)).toMatch(/max-width: 65%;/);
    const muted = rule(/\.hint,\s*\.note/);
    expect(muted).toMatch(/flex-shrink: 1;/);
    expect(muted).toMatch(/min-width: 0;/);
    expect(muted).toMatch(/text-overflow: ellipsis;/);
  });
});
