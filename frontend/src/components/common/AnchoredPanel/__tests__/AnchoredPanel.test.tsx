/**
 * AnchoredPanel — the portaled, fixed dropdown panel. jsdom has no layout, so
 * the trigger's rect, the panel's natural size and the viewport are mocked;
 * the cases check the coordinates written from them (below / above flip,
 * start / end alignment, viewport clamp, measured max-height), the
 * re-measuring (render, resize, outside scroll — not the panel's own scroll)
 * and the keyboard order through the focus sentinels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createRef, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnchoredPanel } from '../AnchoredPanel';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

let triggerBox: Box;
let panelSize: { width: number; height: number };

function rect({ top, left, width, height }: Box): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

beforeEach(() => {
  setViewport(1000, 800);
  triggerBox = { top: 100, left: 300, width: 28, height: 28 };
  panelSize = { width: 220, height: 200 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'trigger') return rect(triggerBox);
    if (this.dataset.align !== undefined) {
      // A real browser clamps inner scroll positions while the panel is unbounded
      if (this.style.maxHeight === 'none') this.querySelectorAll('*').forEach((el) => (el.scrollTop = 0));
      return rect({ top: 0, left: 0, ...panelSize });
    }
    return rect({ top: 0, left: 0, width: 0, height: 0 });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewport(originalWidth, originalHeight);
});

function Harness({
  align = 'start',
  initiallyOpen = true,
  children,
}: {
  align?: 'start' | 'end';
  initiallyOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="host">
      <button type="button">Before</button>
      <button ref={triggerRef} type="button" data-testid="trigger" onClick={() => setOpen((o) => !o)}>
        Trigger
      </button>
      <button type="button">After</button>
      <AnchoredPanel open={open} triggerRef={triggerRef} align={align} role="dialog" aria-label="Panel" id="panel-1" className="custom">
        {children ?? (
          <>
            <button type="button">First</button>
            <button type="button">Last</button>
          </>
        )}
      </AnchoredPanel>
    </div>
  );
}

const panel = () => screen.getByRole('dialog', { name: 'Panel' });

describe('AnchoredPanel rendering', () => {
  it('renders nothing while closed', () => {
    render(<Harness initiallyOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('portals into document.body with the given attributes and class', () => {
    render(<Harness />);
    const el = panel();
    expect(el.parentElement).toBe(document.body);
    expect(screen.getByTestId('host')).not.toContainElement(el);
    expect(el).toHaveAttribute('id', 'panel-1');
    expect(el).toHaveAttribute('data-align', 'start');
    expect(el.className).toMatch(/panel/);
    expect(el.className).toMatch(/custom/);
  });

  it('forwards its ref, as an object or a callback', () => {
    const objectRef = createRef<HTMLDivElement>();
    const callbackRef = vi.fn();
    function Both() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" data-testid="trigger">T</button>
          <AnchoredPanel ref={objectRef} open triggerRef={triggerRef} align="start" aria-label="A">a</AnchoredPanel>
          <AnchoredPanel ref={callbackRef} open triggerRef={triggerRef} align="start" aria-label="B">b</AnchoredPanel>
        </>
      );
    }
    render(<Both />);
    expect(objectRef.current).toHaveAttribute('aria-label', 'A');
    expect(callbackRef).toHaveBeenCalledWith(screen.getByLabelText('B'));
  });
});

describe('AnchoredPanel placement', () => {
  it('opens below the trigger, left edges aligned, max-height = the room below minus the margin', () => {
    render(<Harness />);
    const el = panel();
    // trigger bottom 128 + 4 px gap
    expect(el.style.top).toBe('132px');
    expect(el.style.bottom).toBe('auto');
    expect(el.style.left).toBe('300px');
    // 800 - 128 - 4 - 16
    expect(el.style.maxHeight).toBe('652px');
    expect(el).toHaveAttribute('data-placement', 'below');
  });

  it('aligns its right edge on the trigger\'s with align="end"', () => {
    triggerBox = { top: 100, left: 600, width: 28, height: 28 };
    render(<Harness align="end" />);
    // 628 - 220
    expect(panel().style.left).toBe('408px');
    expect(panel()).toHaveAttribute('data-align', 'end');
  });

  it('stays 16 px inside the viewport horizontally', () => {
    triggerBox = { top: 100, left: 900, width: 28, height: 28 };
    const { unmount } = render(<Harness />);
    // 1000 - 220 - 16
    expect(panel().style.left).toBe('764px');
    unmount();

    triggerBox = { top: 100, left: 4, width: 28, height: 28 };
    render(<Harness align="end" />);
    expect(panel().style.left).toBe('16px');
  });

  it('flips above when the room below is short and the room above is larger', () => {
    triggerBox = { top: 700, left: 300, width: 28, height: 28 };
    panelSize = { width: 220, height: 300 };
    render(<Harness />);
    const el = panel();
    expect(el).toHaveAttribute('data-placement', 'above');
    expect(el.style.top).toBe('auto');
    // its bottom 4 px above the trigger's top: 800 - 700 + 4
    expect(el.style.bottom).toBe('104px');
    // 700 - 4 - 16
    expect(el.style.maxHeight).toBe('680px');
  });

  it('stays below, shrunk, when the room above is smaller still', () => {
    setViewport(1000, 200);
    triggerBox = { top: 40, left: 300, width: 28, height: 28 };
    panelSize = { width: 220, height: 300 };
    render(<Harness />);
    const el = panel();
    expect(el).toHaveAttribute('data-placement', 'below');
    // 200 - 68 - 4 - 16
    expect(el.style.maxHeight).toBe('112px');
  });

  it('stays below when the panel fits there, however much room is above', () => {
    triggerBox = { top: 500, left: 300, width: 28, height: 28 };
    panelSize = { width: 220, height: 200 };
    render(<Harness />);
    // room below 800 - 528 - 20 = 252 >= 200
    expect(panel()).toHaveAttribute('data-placement', 'below');
    expect(panel().style.maxHeight).toBe('252px');
  });

  it('never writes a negative max-height', () => {
    // A trigger taller than the viewport leaves no room on either side
    triggerBox = { top: 10, left: 300, width: 28, height: 900 };
    render(<Harness />);
    expect(panel().style.maxHeight).toBe('0px');
  });

  it('measures the natural height without losing an inner scroll position', () => {
    render(
      <Harness>
        <div data-testid="list">items</div>
      </Harness>
    );
    const list = screen.getByTestId('list');
    list.scrollTop = 40;
    // A re-measure (resize) unbounds the panel for a moment
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(list.scrollTop).toBe(40);
    expect(panel().style.maxHeight).toBe('652px');
  });

  it('re-measures on window resize', () => {
    render(<Harness />);
    expect(panel().style.maxHeight).toBe('652px');
    setViewport(1000, 600);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().style.maxHeight).toBe('452px');
  });

  it('re-measures on a scroll anywhere outside the panel, not on its own scroll', () => {
    render(
      <>
        <div data-testid="pane">pane</div>
        <Harness>
          <div data-testid="list">items</div>
        </Harness>
      </>
    );
    triggerBox = { top: 60, left: 300, width: 28, height: 28 };
    fireEvent.scroll(screen.getByTestId('list'));
    expect(panel().style.top).toBe('132px');

    fireEvent.scroll(screen.getByTestId('pane'));
    expect(panel().style.top).toBe('92px');
  });

  it('re-measures after a re-render (content changed)', () => {
    function Growing() {
      const [extra, setExtra] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" data-testid="trigger">T</button>
          <AnchoredPanel open triggerRef={triggerRef} align="start" aria-label="Grow">
            <button type="button" onClick={() => setExtra(true)}>More</button>
            {extra && <p>extra</p>}
          </AnchoredPanel>
        </>
      );
    }
    triggerBox = { top: 700, left: 300, width: 28, height: 28 };
    panelSize = { width: 220, height: 50 };
    render(<Growing />);
    expect(screen.getByLabelText('Grow')).toHaveAttribute('data-placement', 'below');
    panelSize = { width: 220, height: 400 };
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByLabelText('Grow')).toHaveAttribute('data-placement', 'above');
  });

  it('removes its window listeners on close', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    render(<Harness />);
    const added = add.mock.calls.filter(([type]) => type === 'resize' || type === 'scroll');
    expect(added).toHaveLength(2);
    expect(added.find(([type]) => type === 'scroll')?.[2]).toBe(true); // capture

    fireEvent.click(screen.getByTestId('trigger')); // closes
    const removed = remove.mock.calls.map(([type]) => type).filter((t) => t === 'resize' || t === 'scroll');
    expect(removed.sort()).toEqual(['resize', 'scroll']);
  });
});

describe('AnchoredPanel keyboard order', () => {
  it('Tab on the trigger enters the panel at its first stop', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    const tab = fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(tab).toBe(false); // default prevented
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('enters a radio group at its checked radio', () => {
    render(
      <Harness>
        <input type="radio" name="g" aria-label="None" />
        <input type="radio" name="g" aria-label="Alpha" defaultChecked />
        <input type="radio" name="h" aria-label="H1" />
        <input type="radio" name="h" aria-label="H2" />
      </Harness>
    );
    fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'Tab' });
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
  });

  it('leaves Shift+Tab on the trigger, and Tab into an empty panel, to the browser', () => {
    const { unmount } = render(<Harness />);
    expect(fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'Tab', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'Enter' })).toBe(true);
    unmount();

    render(<Harness><p>Nothing to focus</p></Harness>);
    expect(fireEvent.keyDown(screen.getByTestId('trigger'), { key: 'Tab' })).toBe(true);
  });

  it('Shift+Tab out of the first stop returns to the trigger', () => {
    render(<Harness />);
    const start = panel().querySelector<HTMLElement>('[data-focus-sentinel="start"]')!;
    fireEvent.focus(start, { relatedTarget: screen.getByRole('button', { name: 'First' }) });
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });

  it('Tab out of the last stop goes on to the element after the trigger', () => {
    render(<Harness />);
    const end = panel().querySelector<HTMLElement>('[data-focus-sentinel="end"]')!;
    fireEvent.focus(end, { relatedTarget: screen.getByRole('button', { name: 'Last' }) });
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('falls back to the trigger when nothing follows it', () => {
    function Alone() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" data-testid="trigger">T</button>
          <AnchoredPanel open triggerRef={triggerRef} align="start" aria-label="Alone">
            <button type="button">Only</button>
          </AnchoredPanel>
        </>
      );
    }
    render(<Alone />);
    const end = screen.getByLabelText('Alone').querySelector<HTMLElement>('[data-focus-sentinel="end"]')!;
    fireEvent.focus(end, { relatedTarget: screen.getByRole('button', { name: 'Only' }) });
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });

  it('a sentinel reached from outside the panel moves into it instead', () => {
    render(<Harness />);
    const outside = screen.getByRole('button', { name: 'Before' });
    fireEvent.focus(panel().querySelector<HTMLElement>('[data-focus-sentinel="start"]')!, { relatedTarget: outside });
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    fireEvent.focus(panel().querySelector<HTMLElement>('[data-focus-sentinel="end"]')!, { relatedTarget: null });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });
});
