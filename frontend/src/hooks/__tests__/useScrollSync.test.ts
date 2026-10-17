/**
 * useScrollSync: vertical scroll position mirrored between the tree panel and
 * the timeline body without echo, wheel-driven in one frame, with a measured
 * bottom padding that equalises the two scroll ranges.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollSync } from '../useScrollSync';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function pair() {
  const a = document.createElement('div');
  const b = document.createElement('div');
  a.appendChild(document.createElement('div'));
  b.appendChild(document.createElement('div'));
  return { a, b };
}

/** scrollHeight = base() + the inline padding the hook applied; fixed clientHeight. */
function setRange(el: HTMLElement, base: () => number, client: number) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => base() + (parseFloat(el.style.paddingBottom) || 0),
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll'));
}

function wheel(el: HTMLElement, init: WheelEventInit) {
  const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init });
  el.dispatchEvent(e);
  return e;
}

const mount = (a: HTMLElement | null, b: HTMLElement | null) =>
  renderHook(() => useScrollSync({ current: a }, { current: b }));

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
}

afterEach(() => {
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('useScrollSync — scroll path', () => {
  it('mirrors scrollTop both ways', () => {
    const { a, b } = pair();
    mount(a, b);
    scrollTo(a, 120);
    expect(b.scrollTop).toBe(120);
    b.dispatchEvent(new Event('scroll')); // consume the echo
    scrollTo(b, 40);
    expect(a.scrollTop).toBe(40);
  });

  it('swallows its own echo but propagates genuine scrolls', () => {
    const { a, b } = pair();
    mount(a, b);
    scrollTo(a, 120);
    expect(b.scrollTop).toBe(120);

    // echo on b: a was moved meanwhile, and must not be written back to 120
    a.scrollTop = 130;
    b.dispatchEvent(new Event('scroll'));
    expect(a.scrollTop).toBe(130);

    // a genuine b scroll afterwards moves a
    scrollTo(b, 40);
    expect(a.scrollTop).toBe(40);
  });

  it('propagates a different value while an expectation is pending', () => {
    const { a, b } = pair();
    mount(a, b);
    scrollTo(a, 200); // b expects 200
    scrollTo(b, 90); // the user scrolled b before the echo arrived
    expect(a.scrollTop).toBe(90);
  });

  it('treats a fractional echo (< 1 px) as its own', () => {
    const { a, b } = pair();
    mount(a, b);
    scrollTo(a, 120);
    a.scrollTop = 300;
    scrollTo(b, 120.4);
    expect(a.scrollTop).toBe(300);
  });

  it('does not write when the panes differ by less than 1 px', () => {
    const { a, b } = pair();
    mount(a, b);
    b.scrollTop = 50.5;
    const setter = vi.spyOn(b, 'scrollTop', 'set');
    scrollTo(a, 50);
    expect(setter).not.toHaveBeenCalled();
  });
});

describe('useScrollSync — wheel path', () => {
  function laidOut() {
    const { a, b } = pair();
    setRange(a, () => 1000, 400);
    setRange(b, () => 1000, 400);
    mount(a, b);
    return { a, b };
  }

  it('moves both panes synchronously and cancels the native scroll', () => {
    const { a, b } = laidOut();
    const e = wheel(a, { deltaY: 100 });
    expect(a.scrollTop).toBe(100);
    expect(b.scrollTop).toBe(100);
    expect(e.defaultPrevented).toBe(true);
    // the follow-up scroll events are our own echoes
    b.scrollTop = 100;
    a.dispatchEvent(new Event('scroll'));
    b.dispatchEvent(new Event('scroll'));
    expect(a.scrollTop).toBe(100);
  });

  it('works from the other pane too', () => {
    const { a, b } = laidOut();
    wheel(b, { deltaY: 30 });
    expect(a.scrollTop).toBe(30);
    expect(b.scrollTop).toBe(30);
  });

  it('clamps at 0 and at the maximum, and does not cancel at the end', () => {
    const { a, b } = laidOut();
    wheel(a, { deltaY: 50 });
    wheel(a, { deltaY: -500 });
    expect(a.scrollTop).toBe(0);
    expect(b.scrollTop).toBe(0);

    wheel(a, { deltaY: 5000 });
    expect(a.scrollTop).toBe(600);
    expect(b.scrollTop).toBe(600);

    const atEnd = wheel(a, { deltaY: 100 });
    expect(atEnd.defaultPrevented).toBe(false);
    expect(a.scrollTop).toBe(600);

    const atTop = (() => {
      a.scrollTop = 0;
      return wheel(a, { deltaY: -10 });
    })();
    expect(atTop.defaultPrevented).toBe(false);
  });

  it.each([
    ['ctrl (zoom)', { deltaY: 100, ctrlKey: true }],
    ['shift (horizontal)', { deltaY: 100, shiftKey: true }],
    ['horizontal only', { deltaX: 100 }],
    ['diagonal', { deltaX: 3, deltaY: 100 }],
    ['zero delta', { deltaY: 0 }],
  ])('leaves %s wheel events to the browser', (_label, init) => {
    const { a, b } = laidOut();
    const e = wheel(a, init);
    expect(e.defaultPrevented).toBe(false);
    expect(a.scrollTop).toBe(0);
    expect(b.scrollTop).toBe(0);
  });

  it('normalises line and page delta modes', () => {
    const { a, b } = laidOut();
    wheel(a, { deltaY: 3, deltaMode: 1 });
    expect(a.scrollTop).toBe(48);
    expect(b.scrollTop).toBe(48);
    wheel(a, { deltaY: 1, deltaMode: 2 });
    expect(a.scrollTop).toBe(448);
    expect(b.scrollTop).toBe(448);
  });
});

describe('useScrollSync — equal scroll range', () => {
  it('pads the pane with the smaller range, and clears it when the ranges match', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { a, b } = pair();
    let bBase = 992;
    setRange(a, () => 1000, 400); // natural range 600
    setRange(b, () => bBase, 400); // natural range 592
    mount(a, b);

    expect(b.style.paddingBottom).toBe('8px');
    expect(a.style.paddingBottom).toBe('0px');

    const [observer] = FakeResizeObserver.instances;
    expect(observer.observed).toEqual([a, b, a.firstElementChild, b.firstElementChild]);

    // remeasure excludes the 8 px it applied: still 8 px
    observer.callback();
    await nextFrame();
    expect(b.style.paddingBottom).toBe('8px');

    bBase = 1000;
    observer.callback();
    observer.callback(); // coalesced into one frame
    await nextFrame();
    expect(b.style.paddingBottom).toBe('0px');
    expect(a.style.paddingBottom).toBe('0px');

    // the other way round
    bBase = 1010;
    observer.callback();
    await nextFrame();
    expect(a.style.paddingBottom).toBe('10px');
    expect(b.style.paddingBottom).toBe('0px');
  });

  it('observes only the panes when they have no content child', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const a = document.createElement('div');
    const b = document.createElement('div');
    mount(a, b);
    expect(FakeResizeObserver.instances[0].observed).toEqual([a, b]);
  });

  it('falls back to window resize without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { a, b } = pair();
    let aBase = 1000;
    setRange(a, () => aBase, 400);
    setRange(b, () => 1000, 400);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = mount(a, b);
    expect(a.style.paddingBottom).toBe('0px');

    aBase = 995;
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(a.style.paddingBottom).toBe('5px');

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(a.style.paddingBottom).toBe('');
    removeSpy.mockRestore();
  });

  it('leaves panes that are not laid out alone', () => {
    const { a, b } = pair();
    mount(a, b);
    expect(a.style.paddingBottom).toBe('');
    expect(b.style.paddingBottom).toBe('');
  });

  it('cancels a pending re-measure and resets paddings on unmount', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { a, b } = pair();
    let bBase = 992;
    setRange(a, () => 1000, 400);
    setRange(b, () => bBase, 400);
    const { unmount } = mount(a, b);
    expect(b.style.paddingBottom).toBe('8px');

    const [observer] = FakeResizeObserver.instances;
    bBase = 900;
    observer.callback();
    unmount();
    await nextFrame();

    expect(observer.disconnected).toBe(true);
    expect(a.style.paddingBottom).toBe('');
    expect(b.style.paddingBottom).toBe('');
  });
});

describe('useScrollSync — lifecycle', () => {
  it('does nothing without both elements', () => {
    const a = document.createElement('div');
    const { unmount } = mount(a, null);
    scrollTo(a, 10);
    expect(a.scrollTop).toBe(10);
    unmount();
  });

  it('detaches scroll and wheel listeners on unmount', () => {
    const { a, b } = pair();
    setRange(a, () => 1000, 400);
    setRange(b, () => 1000, 400);
    const { unmount } = mount(a, b);
    unmount();

    scrollTo(a, 33);
    expect(b.scrollTop).toBe(0);
    const e = wheel(b, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    expect(a.scrollTop).toBe(33);
    expect(a.style.paddingBottom).toBe('');
  });
});
