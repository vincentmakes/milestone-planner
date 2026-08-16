/**
 * A textarea with @-mention autocomplete and inline highlighting.
 *
 * It stays a real `<textarea>` — caret, undo, paste and IME all behave
 * natively. A mirror div sits behind it painting a pill behind each *picked*
 * mention, so a picked name reads differently from one typed by hand (which
 * notifies nobody). Both are built from React children, never
 * `dangerouslySetInnerHTML`.
 *
 * Text and anchors are controlled together, so the parent can never render a
 * state where the highlight and the mention list disagree.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  filterCandidates,
  findActiveQuery,
  insertMention,
  reconcileAnchors,
  segmentDraft,
  type ActiveQuery,
  type MentionAnchor,
  type MentionCandidate,
} from '@/utils/mentions';
import styles from './MentionTextarea.module.css';

interface MentionTextareaProps {
  value: string;
  anchors: MentionAnchor[];
  onChange: (value: string, anchors: MentionAnchor[]) => void;
  candidates: MentionCandidate[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

/** Flip the list above the field when it would otherwise run off-screen. */
const FLIP_THRESHOLD_PX = 200;
const MAX_DROPDOWN_PX = 240;

export function MentionTextarea({
  value,
  anchors,
  onChange,
  candidates,
  rows = 3,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
}: MentionTextareaProps) {
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);

  const [query, setQuery] = useState<ActiveQuery | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const filtered = useMemo(
    () => filterCandidates(candidates, query?.query ?? ''),
    [candidates, query]
  );
  const open = query !== null && filtered.length > 0;

  const segments = useMemo(() => segmentDraft(value, anchors), [value, anchors]);

  // ---------------------------------------------------------------
  // Mirror alignment
  // ---------------------------------------------------------------

  const syncScroll = useCallback(() => {
    const mirror = mirrorRef.current;
    const textarea = textareaRef.current;
    if (!mirror || !textarea) return;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  }, []);

  /**
   * Once the textarea overflows it grows a scrollbar, which shrinks its content
   * box while the mirror's stays put — every wrapped line below that point
   * drifts. Mirror the lost width as extra right padding.
   */
  const syncGutter = useCallback(() => {
    const mirror = mirrorRef.current;
    const textarea = textareaRef.current;
    if (!mirror || !textarea) return;
    const gutter = textarea.offsetWidth - textarea.clientWidth;
    mirror.style.paddingRight = `calc(var(--mention-pad-x) + ${gutter}px)`;
  }, []);

  useLayoutEffect(() => {
    syncGutter();
    syncScroll();
  }, [value, syncGutter, syncScroll]);

  useEffect(() => {
    const onResize = () => {
      syncGutter();
      syncScroll();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [syncGutter, syncScroll]);

  // Restore the caret after a programmatic insert; doing it inside the handler
  // loses to React's controlled-value write.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    syncScroll();
  }, [value, syncScroll]);

  // ---------------------------------------------------------------
  // Dropdown position
  // ---------------------------------------------------------------

  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const rect = textarea.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      const flip = below < FLIP_THRESHOLD_PX && rect.top > below;
      const maxHeight = Math.min(MAX_DROPDOWN_PX, Math.max(120, flip ? rect.top - 16 : below - 16));

      setDropdownStyle({
        left: rect.left,
        width: rect.width,
        maxHeight,
        ...(flip ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    };

    update();
    window.addEventListener('resize', update);
    // Capture, so the modal body's own scroll is caught too.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Clicking outside closes only the list — never the surrounding modal.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (wrapperRef.current?.contains(target)) return;
      if (target.closest?.('[data-mention-dropdown="true"]')) return;
      setQuery(null);
      setHighlightIndex(-1);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // ---------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------

  const refreshQuery = useCallback((text: string, caret: number) => {
    const next = findActiveQuery(text, caret);
    setQuery(next);
    setHighlightIndex(-1);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next, reconcileAnchors(value, next, anchors));
    refreshQuery(next, e.target.selectionStart ?? next.length);
  };

  const select = (candidate: MentionCandidate) => {
    if (!query) return;
    const result = insertMention(value, anchors, query, {
      id: candidate.id,
      name: candidate.name,
    });
    pendingCaretRef.current = result.caret;
    onChange(result.text, result.anchors);
    setQuery(null);
    setHighlightIndex(-1);
  };

  const closeList = () => {
    setQuery(null);
    setHighlightIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME confirm must not pick a mention.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === 'Escape') {
      if (!open) return; // let it through: Modal closes
      e.preventDefault();
      e.stopPropagation();
      // React's synthetic stopPropagation does not stop Modal's listener on
      // `document`; only this does.
      e.nativeEvent.stopImmediatePropagation();
      closeList();
      return;
    }

    if (!open) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Only intercept with an active option — Enter must still insert a
      // newline, and Tab must still move focus.
      if (highlightIndex >= 0 && filtered[highlightIndex]) {
        e.preventDefault();
        select(filtered[highlightIndex]);
      }
    }
  };

  const handleSelectionChange = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    refreshQuery(textarea.value, textarea.selectionStart ?? 0);
  };

  return (
    <div ref={wrapperRef} className={styles.field}>
      <div
        ref={mirrorRef}
        className={`${styles.mirror} ${composingRef.current ? styles.composing : ''}`}
        aria-hidden="true"
      >
        {segments.map((segment, i) =>
          segment.kind === 'mention' ? (
            <span key={i} className={styles.mention}>
              {segment.text}
            </span>
          ) : (
            <span key={i}>{segment.text}</span>
          )
        )}
        {/* pre-wrap collapses a trailing newline in a block; a textarea shows it. */}
        {value.endsWith('\n') && '\n'}
      </div>

      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && highlightIndex >= 0 ? `${listId}-opt-${highlightIndex}` : undefined
        }
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        onClick={handleSelectionChange}
        onKeyUp={handleSelectionChange}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onBlur={closeList}
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Mentionable people"
          className={styles.dropdown}
          style={dropdownStyle}
          data-mention-dropdown="true"
        >
          {filtered.map((candidate, i) => (
            <li key={candidate.id} className={styles.optionWrapper}>
              {/* Headings sit between options rather than occupying an index,
                  or highlightIndex would drift whenever a group is non-empty. */}
              {(i === 0 || filtered[i - 1].onCard !== candidate.onCard) && (
                <span className={styles.groupHeading} role="presentation">
                  {candidate.onCard ? 'On this card' : 'Everyone else'}
                </span>
              )}
              <span
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === highlightIndex}
                className={`${styles.option} ${i === highlightIndex ? styles.optionActive : ''}`}
                // Select before blur, and keep the textarea's selection intact.
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(candidate);
                }}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                <span className={styles.optionName}>{candidate.name}</span>
                {candidate.hint && <span className={styles.optionHint}>{candidate.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
