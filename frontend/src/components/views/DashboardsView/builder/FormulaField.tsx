/**
 * FormulaField — the formula of a calculated widget as one text field
 * (2.6.0), on the @-mention field's technique (`common/MentionTextarea`).
 *
 * It stays a real `<textarea>`, so caret, undo, paste and IME behave
 * natively; a mirror behind it paints a pill behind each picked measure. Text
 * and pills are controlled together (`utils/formulaField.ts`) and carried
 * through every edit. Typing letters opens the measures matching them under
 * the field (a listbox: arrows, Enter or Tab to insert, Escape to close; a
 * click inserts too); so does focusing the empty field and the caller's
 * *Insert measure* (`ref.openSuggestions()`). The field grows with its text.
 * A measure's full name typed by hand becomes a pill once the user moves on.
 * Clicking a pill, or Enter with the caret on it, opens its panel under the
 * field (the caller's filters and switches) with the focus on its first
 * control; its header — the title, *Clear filters* and *Done* — stays in view
 * while the dialog scrolls; *Done* or Escape closes it with the focus back in
 * the field; a change of filters rewrites the pill's text
 * (`label`); a pill under the pointer shows a pointer cursor, a hover
 * shade and "<pill>: click to filter". Enter never adds a line.
 *
 * Nothing is portaled: the list and the panel render inline, inside the
 * widget editor's dialog. The list opens above the field when there is no
 * room below.
 */

import { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { Button } from '@/components/common/Button';
import {
  activeWord,
  insertPill,
  matchMeasures,
  pillAt,
  recogniseMeasures,
  reconcilePills,
  relabelPill,
  segmentField,
} from '@/utils/formulaField';
import { clickToFilter } from '@/utils/formulaField';
import type { ActiveWord, FieldPill, FieldState, MeasureOption, TermFilters } from '@/utils/formulaField';
import type { Measure } from '@/types';
import styles from './FormulaField.module.css';

/** Below this much room under the field, the list opens above it. */
const FLIP_THRESHOLD_PX = 200;

export interface FormulaFieldProps {
  id: string;
  state: FieldState;
  onChange: (state: FieldState) => void;
  /** The measures offered (those the viewer may use) */
  options: readonly MeasureOption[];
  /** A pill's text for a measure and its filters ("Booked weeks · Has a customer") */
  label: (measure: Measure, filters: TermFilters | undefined) => string;
  /** The panel of a pill: `update` changes it (its text follows its filters) */
  renderPanel: (pill: FieldPill, update: (patch: Partial<Pick<FieldPill, 'filters' | 'total'>>) => void) => ReactNode;
  /** Ids of the texts that describe the field (its message) */
  describedBy?: string;
  invalid?: boolean;
  /** A pill's panel was opened (the caller drops its "click a measure" hint) */
  onPanelOpen?: () => void;
}

/** What the caller may do with the field. */
export interface FormulaFieldHandle {
  /** Open the measures at the caret (the *Insert measure* button) */
  openSuggestions: () => void;
}

export const FormulaField = forwardRef<FormulaFieldHandle, FormulaFieldProps>(function FormulaField(
  { id, state, onChange, options, label, renderPanel, describedBy, invalid = false, onPanelOpen },
  ref
) {
  const listId = useId();
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [word, setWord] = useState<ActiveWord | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [flip, setFlip] = useState(false);
  const [panelKey, setPanelKey] = useState<number | null>(null);
  // Bumped to put the focus back in the field without changing its text.
  const [focusTick, setFocusTick] = useState(0);
  const [hoverKey, setHoverKey] = useState<number | null>(null);

  const matches = useMemo(() => (word ? matchMeasures(options, word.query) : []), [options, word]);
  const open = word !== null && matches.length > 0 && !dismissed;
  const segments = useMemo(() => segmentField(state), [state]);
  const panelPill = panelKey === null ? null : state.pills.find((p) => p.key === panelKey) ?? null;
  const panelRef = useRef<HTMLDivElement>(null);
  const panelOpen = panelPill !== null;
  // Into the panel when it opens: its first control (the header's buttons otherwise).
  useLayoutEffect(() => {
    if (!panelOpen) return;
    const panel = panelRef.current;
    const body = panel?.querySelector<HTMLElement>('[data-panel-body] button, [data-panel-body] select, [data-panel-body] input');
    (body ?? panel?.querySelector<HTMLElement>('button'))?.focus();
  }, [panelOpen, panelKey]);

  // --- Mirror alignment and the caret after a programmatic change -------------------
  const syncScroll = useCallback(() => {
    const mirror = mirrorRef.current;
    const textarea = textareaRef.current;
    if (!mirror || !textarea) return;
    mirror.scrollTop = textarea.scrollTop;
  }, []);

  useLayoutEffect(() => {
    // Grow with the text: one row, more only once it wraps.
    const box = textareaRef.current;
    if (box) {
      box.style.height = 'auto';
      if (box.scrollHeight > 0) box.style.height = `${box.scrollHeight}px`;
    }
    syncScroll();
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [state, focusTick, syncScroll]);

  // Open the list above the field when the room below is short.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
    const below = bottom - rect.bottom;
    setFlip(below < FLIP_THRESHOLD_PX && rect.top > below);
  }, [open]);

  // --- The suggestions ----------------------------------------------------------------
  const refresh = (next: FieldState, caret: number, forced = false) => {
    const found = activeWord(next, caret);
    setWord(found ?? (forced ? { start: caret, end: caret, query: '' } : null));
    setHighlight(-1);
  };

  const closeList = () => {
    setWord(null);
    setHighlight(-1);
  };

  const pick = (option: MeasureOption) => {
    if (!word) return;
    const result = insertPill(state, word, { measure: option.measure }, label(option.measure, undefined));
    pendingCaretRef.current = result.caret;
    onChange(result.state);
    closeList();
  };

  // --- Editing -----------------------------------------------------------------------------
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    // One line: a pasted line break is a space (same length, the pills stay put).
    const text = e.target.value.replace(/[\r\n]/g, ' ');
    const caret = e.target.selectionStart ?? text.length;
    const carried = { text, pills: reconcilePills(state.text, text, state.pills) };
    const next = recogniseMeasures(carried, options, caret);
    onChange(next);
    setDismissed(false);
    refresh(next, caret);
  };

  const openPanel = (pill: FieldPill) => {
    closeList();
    setPanelKey(pill.key);
    onPanelOpen?.();
  };

  const closePanel = () => {
    const pill = panelPill;
    setPanelKey(null);
    // Back to the field, the caret after the pill.
    pendingCaretRef.current = pill ? pill.start + pill.text.length : state.text.length;
    setFocusTick((n) => n + 1);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      if (!open) return; // the dialog's own Escape
      // Close only the list: the Modal listens on `document` (see MentionTextarea).
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      return;
    }
    if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((i) => Math.min(matches.length - 1, i + 1));
      return;
    }
    if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(-1, i - 1));
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab') && highlight >= 0 && matches[highlight]) {
      e.preventDefault();
      pick(matches[highlight]);
      return;
    }
    if (e.key === 'Enter') {
      // Never a new line; on a pill, its filters.
      e.preventDefault();
      const pill = pillAt(state, e.currentTarget.selectionStart ?? 0, true);
      if (pill) openPanel(pill);
    }
  };

  const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'];
  const handleSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    if ('key' in e.nativeEvent && NAV_KEYS.includes((e.nativeEvent as globalThis.KeyboardEvent).key)) return;
    const caret = e.currentTarget.selectionStart ?? 0;
    if (e.type === 'click') {
      const pill = pillAt(state, caret);
      if (pill) {
        openPanel(pill);
        return;
      }
    }
    refresh(state, caret, state.text.trim() === '');
  };

  const handleBlur = () => {
    closeList();
    const next = recogniseMeasures(state, options, null);
    if (next !== state) onChange(next);
  };

  useImperativeHandle(ref, () => ({
    openSuggestions: () => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? state.text.length;
      setDismissed(false);
      setPanelKey(null);
      // The word under the caret, or an empty query there.
      refresh(state, caret, true);
      textarea?.focus();
    },
  }));

  // The pill under the pointer, from the mirror's boxes (the textarea on top takes the events).
  const handleMouseMove = (e: MouseEvent<HTMLTextAreaElement>) => {
    const spans = mirrorRef.current?.querySelectorAll<HTMLElement>('[data-pill]') ?? [];
    let found: number | null = null;
    for (const span of spans) {
      const inside = Array.from(span.getClientRects()).some(
        (box) => e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom
      );
      if (inside) {
        found = Number(span.dataset.pill);
        break;
      }
    }
    if (found !== hoverKey) setHoverKey(found);
  };
  const hovered = hoverKey === null ? null : state.pills.find((p) => p.key === hoverKey) ?? null;

  const updatePill = (patch: Partial<Pick<FieldPill, 'filters' | 'total'>>) => {
    if (!panelPill) return;
    const filters = 'filters' in patch ? patch.filters : panelPill.filters;
    onChange(relabelPill(state, panelPill.key, label(panelPill.measure, filters), patch));
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className={styles.root}>
      <div ref={wrapperRef} className={`${styles.field}${invalid ? ` ${styles.invalid}` : ''}`}>
        <div ref={mirrorRef} className={styles.mirror} aria-hidden="true">
          {segments.map((segment) =>
            segment.kind === 'pill' ? (
              <span
                key={`p${segment.pill.key}`}
                data-pill={segment.pill.key}
                className={`${styles.pill}${segment.pill.key === hoverKey ? ` ${styles.pillHover}` : ''}`}
              >
                {segment.text}
              </span>
            ) : (
              <span key={`t${segment.start}`}>{segment.text}</span>
            )
          )}
        </div>
        <textarea
          ref={textareaRef}
          id={id}
          className={`${styles.textarea}${hovered ? ` ${styles.overPill}` : ''}`}
          title={hovered ? clickToFilter(hovered.text) : undefined}
          rows={1}
          value={state.text}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : panelPill ? panelId : undefined}
          aria-activedescendant={open && highlight >= 0 ? optionId(highlight) : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleSelect}
          onClick={handleSelect}
          onFocus={(e) => {
            if (state.text.trim() === '') refresh(state, e.currentTarget.selectionStart ?? 0, true);
          }}
          onScroll={syncScroll}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverKey(null)}
          onBlur={handleBlur}
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Measures"
            className={`${styles.list}${flip ? ` ${styles.flip}` : ''}`}
          >
            {matches.map((option, i) => (
              <li key={option.measure} className={styles.item}>
                {(i === 0 || matches[i - 1].group !== option.group) && (
                  <span className={styles.group} role="presentation">
                    {option.group}
                  </span>
                )}
                <span
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === highlight}
                  className={`${styles.option}${i === highlight ? ` ${styles.active}` : ''}`}
                  // Before the blur, keeping the field's selection.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(option);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {option.label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {panelPill && (
        <div
          ref={panelRef}
          id={panelId}
          className={styles.panel}
          role="group"
          aria-label={`Filters for ${label(panelPill.measure, undefined)}`}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            e.stopPropagation();
            closePanel();
          }}
        >
          <div className={styles.panelHeader}>
            <p className={styles.panelTitle}>Filters for {label(panelPill.measure, undefined)}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!panelPill.filters || Object.keys(panelPill.filters).length === 0}
              onClick={() => updatePill({ filters: {} })}
            >
              Clear filters
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={closePanel}>
              Done
            </Button>
          </div>
          <div className={styles.panelBody} data-panel-body>
            {renderPanel(panelPill, updatePill)}
          </div>
        </div>
      )}
    </div>
  );
});
