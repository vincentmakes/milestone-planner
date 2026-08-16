/**
 * Where the mention list opens.
 *
 * The regression this guards: on a tablet the software keyboard covers the
 * bottom of the screen without shrinking `window.innerHeight`, so the list
 * opened into space that was really behind the keyboard and the user had to
 * dismiss the keyboard to read their own suggestions.
 */

import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MentionTextarea } from '../MentionTextarea';
import type { MentionAnchor, MentionCandidate } from '@/utils/mentions';

const CANDIDATES: MentionCandidate[] = [
  { id: 7, name: 'Alice Anderson', onCard: true },
  { id: 8, name: 'Bob Brown', onCard: false },
];

/** The composer sits low in a modal — 60px tall, ending 640px down the page. */
const COMPOSER = { top: 580, bottom: 640, left: 100, width: 400 };

function Harness() {
  const [value, setValue] = useState('');
  const [anchors, setAnchors] = useState<MentionAnchor[]>([]);
  return (
    <MentionTextarea
      value={value}
      anchors={anchors}
      onChange={(v, a) => {
        setValue(v);
        setAnchors(a);
      }}
      candidates={CANDIDATES}
      aria-label="Comment"
    />
  );
}

/** Open the list and read back the inline styles the component computed. */
function openList(): CSSStyleDeclaration {
  render(<Harness />);
  const textarea = screen.getByRole('textbox', { name: 'Comment' });
  fireEvent.change(textarea, { target: { value: '@A' } });
  return (screen.getByRole('listbox') as HTMLElement).style;
}

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.tagName !== 'TEXTAREA') return originalRect.call(this);
    return {
      ...COMPOSER,
      right: COMPOSER.left + COMPOSER.width,
      height: COMPOSER.bottom - COMPOSER.top,
      x: COMPOSER.left,
      y: COMPOSER.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  window.innerHeight = 1024;
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  // @ts-expect-error -- jsdom has no visualViewport; tests add one.
  delete window.visualViewport;
});

/** Stand in for iPadOS: the layout viewport is untouched, the visual one shrinks. */
function openKeyboard(height: number) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      height,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

describe('MentionTextarea dropdown placement', () => {
  it('opens below the field when there is room', () => {
    const style = openList();
    expect(style.top).toBe('644px'); // rect.bottom + gap
    expect(style.bottom).toBe('');
  });

  it('flips above the field when the software keyboard covers the space below', () => {
    // 1024px tall page, ~350px of keyboard: the composer's bottom edge is only
    // 34px above the keyboard, but window.innerHeight still says 1024.
    openKeyboard(674);
    const style = openList();
    expect(style.top).toBe('');
    expect(style.bottom).toBe('448px'); // innerHeight - rect.top + gap
  });

  it('does not flip when the keyboard is closed even though nothing else changed', () => {
    openKeyboard(1024);
    expect(openList().top).toBe('644px');
  });

  it('caps its height when the space it flipped into is generous', () => {
    openKeyboard(700);
    // 576px of room above the field, so the cap decides, not the room.
    expect(openList().maxHeight).toBe('240px');
  });

  it('shrinks to the room available when that is less than the cap', () => {
    // Visible band ends 860px down: 216px below the composer — enough to stay
    // put, not enough for a full-height list.
    openKeyboard(860);
    const style = openList();
    expect(style.top).toBe('644px');
    expect(style.maxHeight).toBe('216px');
  });
});
