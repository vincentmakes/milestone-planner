/**
 * @-mention text handling for card comments.
 *
 * Mirrors app/services/mentions.py for the wire format (`@[Name](id)`). The two
 * must stay equivalent — change one, change both. The shared string table is
 * asserted on both sides (src/utils/__tests__/mentions.test.ts and
 * tests/test_mentions.py).
 *
 * ## Why anchors rather than name matching
 *
 * An accepted mention is an *anchor at a character offset*, carried across
 * edits by a prefix/suffix diff. The obvious alternative — scan the draft for
 * `@{name}` and claim the first unclaimed occurrence — fails silently and in
 * the worst direction:
 *
 *   - two people called "Alice Anderson" get their ids swapped when the pick
 *     order differs from the text order, and both pills still look right;
 *   - a picked "Ann" matches inside a typed "@Anna Smith", serialising to the
 *     corrupt `@[Ann](3)a Smith`.
 *
 * With anchors, validity is a positional identity check. Where the diff is
 * ambiguous (inserted text identical to its neighbour) the anchor is *dropped*,
 * never re-attached to different text — so ambiguity always resolves toward
 * "this no longer notifies anyone", which is the honest direction.
 *
 * Nothing here touches the DOM: the caret is passed in as a number so every
 * function is unit-testable.
 */

/** A person who can be mentioned. */
export interface MentionCandidate {
  id: number;
  name: string;
  /** Job title, shown dimmed beside the name. */
  hint?: string;
  /** Assigned to the card being commented on — pinned to the top of the list. */
  onCard: boolean;
}

/** An accepted mention, anchored at the offset of its `@`. */
export interface MentionAnchor {
  userId: number;
  name: string;
  start: number;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: number; name: string };

/** The `@query` the caret currently sits inside. */
export interface ActiveQuery {
  /** Index of the `@`. */
  start: number;
  /** Text between the `@` and the caret. */
  query: string;
}

/** A stray `@` should not scan backwards forever. */
const MAX_QUERY_LENGTH = 40;

/** Names are bounded so a pathological token can't blow up the regex. */
export const MENTION_TOKEN_RE = /@\[([^\]\n]{1,120})\]\((\d+)\)/g;

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}_]/u.test(c);
}

/** Character length an anchor occupies, including the `@`. */
export function anchorLength(anchor: Pick<MentionAnchor, 'name'>): number {
  return anchor.name.length + 1;
}

// =============================================================================
// CARET / ACTIVE QUERY
// =============================================================================

/**
 * The `@query` the caret sits inside, or null.
 *
 * Spaces are allowed inside the query because display names contain them; it is
 * the component's job to close the list once nothing matches. The character
 * before the `@` must be absent or non-word, so `bob@example.com` never opens
 * the picker.
 */
export function findActiveQuery(
  text: string,
  caret: number,
  anchors: MentionAnchor[] = []
): ActiveQuery | null {
  if (caret < 0 || caret > text.length) return null;

  const lowest = Math.max(0, caret - MAX_QUERY_LENGTH - 1);
  for (let i = caret - 1; i >= lowest; i--) {
    const ch = text[i];
    if (ch === '\n') return null; // a mention query never spans lines
    if (ch !== '@') continue;
    if (isWordChar(text[i - 1])) return null; // e.g. an email address
    // Already picked: typing after a finished mention is not still composing
    // it. Without this the picker reopens on the name you just inserted,
    // because names contain spaces and the scan walks back into them.
    if (anchors.some((a) => a.start === i && isAnchorIntact(text, a))) return null;
    return { start: i, query: text.slice(i + 1, caret) };
  }
  return null;
}

// =============================================================================
// ANCHOR LIFECYCLE
// =============================================================================

/**
 * Whether the anchor's text is still exactly `@Name` and still stands alone.
 *
 * The trailing guard is what demotes `@Annx` the moment the `x` lands, while
 * leaving `@Ann Smith`, `@Ann.` and `@Ann,` intact.
 */
export function isAnchorIntact(text: string, anchor: MentionAnchor): boolean {
  const end = anchor.start + anchorLength(anchor);
  if (anchor.start < 0 || end > text.length) return false;
  if (text.slice(anchor.start, end) !== `@${anchor.name}`) return false;
  if (isWordChar(text[anchor.start - 1])) return false;
  return !isWordChar(text[end]);
}

interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

/** Single-range diff from the common prefix and suffix of two strings. */
function diffEdit(prev: string, next: string): TextEdit {
  let start = 0;
  const shortest = Math.min(prev.length, next.length);
  while (start < shortest && prev[start] === next[start]) start++;

  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }

  return { start, removed: prevEnd - start, inserted: nextEnd - start };
}

/**
 * Carry anchors across an edit.
 *
 * Anchors before the edit are untouched, anchors after it shift by the length
 * delta, and anchors the edit *overlapped* are dropped — that drop is the
 * silent demotion the UI relies on. Survivors are re-validated, so a mangled
 * name is demoted even when the edit landed elsewhere.
 *
 * Note: undo does not resurrect a dropped anchor. Typing a mention, deleting it
 * and pressing Ctrl+Z restores the text but not the highlight, and the person
 * is not notified. That is correct — no highlight means no notification — but
 * it surprises people who don't know the rule.
 */
export function reconcileAnchors(
  prev: string,
  next: string,
  anchors: MentionAnchor[]
): MentionAnchor[] {
  if (prev === next) return anchors.filter((a) => isAnchorIntact(next, a));

  const edit = diffEdit(prev, next);
  const editEnd = edit.start + edit.removed;
  const delta = edit.inserted - edit.removed;

  const moved: MentionAnchor[] = [];
  for (const anchor of anchors) {
    const start = anchor.start;
    const end = start + anchorLength(anchor);

    if (end <= edit.start) {
      moved.push(anchor);
    } else if (start >= editEnd) {
      moved.push({ ...anchor, start: start + delta });
    }
    // Overlapping the edit: dropped.
  }

  return moved.filter((a) => isAnchorIntact(next, a)).sort((a, b) => a.start - b.start);
}

/**
 * Replace the active query with `@Name ` and return the new text, anchors and
 * caret position.
 *
 * The trailing space guarantees a non-word boundary after the name, so the new
 * anchor is immediately valid. Offset shifting goes through `reconcileAnchors`
 * so there is exactly one place that moves anchors.
 */
export function insertMention(
  text: string,
  anchors: MentionAnchor[],
  query: ActiveQuery,
  person: { id: number; name: string }
): { text: string; anchors: MentionAnchor[]; caret: number } {
  const queryEnd = query.start + 1 + query.query.length;
  const insertion = `@${person.name} `;
  const nextText = text.slice(0, query.start) + insertion + text.slice(queryEnd);

  const shifted = reconcileAnchors(text, nextText, anchors);
  const created: MentionAnchor = {
    userId: person.id,
    name: person.name,
    start: query.start,
  };

  return {
    text: nextText,
    anchors: [...shifted, created].sort((a, b) => a.start - b.start),
    caret: query.start + insertion.length,
  };
}

// =============================================================================
// SEGMENTATION — the single source of truth
// =============================================================================

/**
 * Split a draft into text and mention runs.
 *
 * The highlight overlay, the serializer and the notified-id list are all
 * derived from this one function, so the pills a user sees and the people the
 * server notifies cannot disagree.
 */
export function segmentDraft(text: string, anchors: MentionAnchor[]): MentionSegment[] {
  const live = anchors
    .filter((a) => isAnchorIntact(text, a))
    .sort((a, b) => a.start - b.start);

  const segments: MentionSegment[] = [];
  let cursor = 0;

  for (const anchor of live) {
    if (anchor.start < cursor) continue; // overlapping anchors: keep the first
    if (anchor.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, anchor.start) });
    }
    const end = anchor.start + anchorLength(anchor);
    segments.push({
      kind: 'mention',
      text: text.slice(anchor.start, end),
      userId: anchor.userId,
      name: anchor.name,
    });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Draft text -> wire body, with mentions as `@[Name](id)`.
 *
 * Trim the *result*, never the input: trimming the draft first would shift
 * every anchor offset. Tokens never occupy leading or trailing whitespace, so
 * trimming the serialized string is safe.
 */
export function serializeMentions(text: string, anchors: MentionAnchor[]): string {
  return segmentDraft(text, anchors)
    .map((s) => (s.kind === 'mention' ? `@[${s.name}](${s.userId})` : s.text))
    .join('');
}

/** The user ids a draft will notify, deduplicated. */
export function mentionedUserIds(text: string, anchors: MentionAnchor[]): number[] {
  const ids = segmentDraft(text, anchors)
    .filter((s): s is Extract<MentionSegment, { kind: 'mention' }> => s.kind === 'mention')
    .map((s) => s.userId);
  return Array.from(new Set(ids));
}

// =============================================================================
// WIRE FORMAT
// =============================================================================

/**
 * Split a stored body into text and mention runs for rendering.
 * A comment written before mentions existed contains no tokens and comes back
 * as a single text segment.
 */
export function parseMentionTokens(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(body)) !== null) {
    const [token, name, rawId] = match;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) continue;

    if (match.index > cursor) {
      segments.push({ kind: 'text', text: body.slice(cursor, match.index) });
    }
    segments.push({ kind: 'mention', text: `@${name}`, userId: id, name });
    cursor = match.index + token.length;
  }

  if (cursor < body.length) {
    segments.push({ kind: 'text', text: body.slice(cursor) });
  }
  return segments;
}

/** `@[Alice Anderson](7)` -> `@Alice Anderson`, for plain-text previews. */
export function stripMentionTokens(body: string): string {
  return body.replace(new RegExp(MENTION_TOKEN_RE.source, 'g'), (_m, name) => `@${name}`);
}

/** Inverse of `serializeMentions`, for a future edit-comment UI. */
export function deserializeMentions(body: string): { text: string; anchors: MentionAnchor[] } {
  let text = '';
  const anchors: MentionAnchor[] = [];

  for (const segment of parseMentionTokens(body)) {
    if (segment.kind === 'mention') {
      anchors.push({ userId: segment.userId, name: segment.name, start: text.length });
    }
    text += segment.text;
  }
  return { text, anchors };
}

// =============================================================================
// CANDIDATES
// =============================================================================

/**
 * Build the mention list: people on the card first, then everyone else.
 *
 * `staff` holds one row per user-site pair, so the same person can appear
 * several times — deduplicated by id here. Assignees absent from `staff` are
 * synthesized, which is what makes an admin (excluded from GET /staff) or a
 * cross-site colleague mentionable on a card they are actually assigned to.
 */
export function buildMentionCandidates(
  assignments: { staff_id: number; staff_name?: string | null }[],
  staff: { id: number; name: string; role?: string }[],
  excludeUserId?: number
): MentionCandidate[] {
  const byId = new Map<number, MentionCandidate>();

  for (const s of staff) {
    if (s.id === excludeUserId || byId.has(s.id)) continue;
    byId.set(s.id, { id: s.id, name: s.name, hint: s.role, onCard: false });
  }

  for (const a of assignments) {
    if (a.staff_id === excludeUserId) continue;
    const existing = byId.get(a.staff_id);
    if (existing) {
      existing.onCard = true;
    } else if (a.staff_name) {
      // Not in staff at all — an admin, or someone from another site.
      byId.set(a.staff_id, { id: a.staff_id, name: a.staff_name, onCard: true });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.onCard !== b.onCard) return a.onCard ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Case-insensitive substring match, preserving candidate order. */
export function filterCandidates(all: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((c) => c.name.toLowerCase().includes(q));
}
