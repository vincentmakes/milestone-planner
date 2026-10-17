/**
 * useScrollSync Hook
 *
 * Keeps the vertical scroll position (scrollTop) of two panes — the left tree
 * panel and the timeline body — identical, in both directions.
 *
 * No echo. Every scrollTop the hook writes is remembered as the value expected
 * for that element; the element's next `scroll` event reporting that value
 * (within 1 px, for fractional scrolls) is our own write coming back and is
 * consumed. Any other value is a genuine scroll and is mirrored. (A rAF flag
 * used to do this, but the follower's scroll event arrives a frame later, after
 * the flag reset, and copied its older position back onto the leading pane.)
 *
 * Wheel. A vertical wheel over either pane moves both panes synchronously in
 * the same frame and cancels the native scroll, so the follower never lags a
 * frame behind. Ctrl+wheel (zoom, `useCtrlScrollZoom`), Shift+wheel and any
 * event with a horizontal component are left to the browser; they still sync
 * through the scroll path. At the end of the range the event is not cancelled,
 * so the page can scroll.
 *
 * Equal scroll range. The timeline's horizontal scrollbar takes 8 px of layout
 * with classic scrollbars and 0 with overlay ones, so a fixed CSS padding can't
 * match the two ranges. The hook measures each pane's natural range (excluding
 * the padding it applied itself) and gives the pane with the smaller range a
 * bottom padding equal to the difference — on mount, then one frame after any
 * resize of the panes or their content.
 */

import { useEffect, RefObject } from 'react';

const LINE_HEIGHT_PX = 16;

export function useScrollSync(
  ref1: RefObject<HTMLElement>,
  ref2: RefObject<HTMLElement>
) {
  useEffect(() => {
    const el1 = ref1.current;
    const el2 = ref2.current;

    if (!el1 || !el2) return;

    const expected = new Map<HTMLElement, number>();
    const pads = new Map<HTMLElement, number>();
    let frame: number | null = null;

    const write = (el: HTMLElement, value: number) => {
      const before = el.scrollTop;
      el.scrollTop = value;
      if (el.scrollTop !== before) expected.set(el, el.scrollTop);
    };

    const onScroll = (source: HTMLElement, target: HTMLElement) => {
      const pending = expected.get(source);
      expected.delete(source);
      if (pending !== undefined && Math.abs(source.scrollTop - pending) < 1) return;
      if (Math.abs(target.scrollTop - source.scrollTop) >= 1) {
        write(target, source.scrollTop);
      }
    };

    const onWheel = (source: HTMLElement, target: HTMLElement, e: WheelEvent) => {
      if (e.ctrlKey || e.shiftKey || e.deltaY === 0 || e.deltaX !== 0) return;
      const unit =
        e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? source.clientHeight : 1;
      const max = Math.max(0, source.scrollHeight - source.clientHeight);
      const next = Math.min(max, Math.max(0, source.scrollTop + e.deltaY * unit));
      if (next === source.scrollTop) return;
      write(source, next);
      write(target, next);
      e.preventDefault();
    };

    const applyPad = (el: HTMLElement, px: number) => {
      if (pads.get(el) === px) return;
      pads.set(el, px);
      el.style.paddingBottom = `${px}px`;
    };

    const equalise = () => {
      frame = null;
      if (el1.scrollHeight === 0 && el2.scrollHeight === 0) return;
      const range = (el: HTMLElement) =>
        Math.max(0, el.scrollHeight - el.clientHeight - (pads.get(el) ?? 0));
      const diff = range(el1) - range(el2);
      applyPad(el1, diff < 0 ? -diff : 0);
      applyPad(el2, diff > 0 ? diff : 0);
    };

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(equalise);
    };

    const scroll1 = () => onScroll(el1, el2);
    const scroll2 = () => onScroll(el2, el1);
    const wheel1 = (e: WheelEvent) => onWheel(el1, el2, e);
    const wheel2 = (e: WheelEvent) => onWheel(el2, el1, e);

    el1.addEventListener('scroll', scroll1, { passive: true });
    el2.addEventListener('scroll', scroll2, { passive: true });
    el1.addEventListener('wheel', wheel1, { passive: false });
    el2.addEventListener('wheel', wheel2, { passive: false });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', schedule);
    } else {
      observer = new ResizeObserver(schedule);
      for (const el of [el1, el2, el1.firstElementChild, el2.firstElementChild]) {
        if (el) observer.observe(el);
      }
    }

    equalise();

    return () => {
      el1.removeEventListener('scroll', scroll1);
      el2.removeEventListener('scroll', scroll2);
      el1.removeEventListener('wheel', wheel1);
      el2.removeEventListener('wheel', wheel2);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      for (const el of pads.keys()) el.style.paddingBottom = '';
    };
  }, [ref1, ref2]);
}
