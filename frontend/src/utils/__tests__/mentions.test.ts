/**
 * Mirrors tests/test_mentions.py for the wire-format cases.
 *
 * The cases that matter most are the ones a naive "scan for @Name" design gets
 * wrong: two people sharing a display name, and a short name contained inside a
 * longer one. Both are asserted below.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMentionCandidates,
  deserializeMentions,
  filterCandidates,
  findActiveQuery,
  insertMention,
  isAnchorIntact,
  mentionedUserIds,
  parseMentionTokens,
  reconcileAnchors,
  segmentDraft,
  serializeMentions,
  stripMentionTokens,
  type MentionAnchor,
} from '../mentions';

const anchor = (userId: number, name: string, start: number): MentionAnchor => ({
  userId,
  name,
  start,
});

// =============================================================================
// findActiveQuery
// =============================================================================

describe('findActiveQuery', () => {
  it('opens on a bare @ at the caret', () => {
    expect(findActiveQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });

  it('captures the text between @ and the caret', () => {
    expect(findActiveQuery('hi @Ali', 7)).toEqual({ start: 3, query: 'Ali' });
  });

  it('allows spaces, because display names contain them', () => {
    expect(findActiveQuery('hi @Alice And', 13)).toEqual({ start: 3, query: 'Alice And' });
  });

  it('captures only up to the caret when it sits mid-name', () => {
    expect(findActiveQuery('@Alice', 4)).toEqual({ start: 0, query: 'Ali' });
  });

  it('ignores an @ inside an email address', () => {
    expect(findActiveQuery('bob@example', 11)).toBeNull();
  });

  it('does not span lines', () => {
    expect(findActiveQuery('@Alice\nhello', 12)).toBeNull();
  });

  it('returns null when there is no @ before the caret', () => {
    expect(findActiveQuery('plain text', 5)).toBeNull();
  });

  it('returns null when the caret is before the @', () => {
    expect(findActiveQuery('hi @Alice', 2)).toBeNull();
  });

  it('gives up on an over-long query so a stray @ does not scan forever', () => {
    const text = `@${'x'.repeat(60)}`;
    expect(findActiveQuery(text, text.length)).toBeNull();
  });

  it('opens at the very start of the text', () => {
    expect(findActiveQuery('@a', 2)).toEqual({ start: 0, query: 'a' });
  });
});

// =============================================================================
// isAnchorIntact — the boundary rule
// =============================================================================

describe('isAnchorIntact', () => {
  it('accepts an exact match at the start', () => {
    expect(isAnchorIntact('@Ann', anchor(3, 'Ann', 0))).toBe(true);
  });

  it('accepts a following space, full stop or comma', () => {
    expect(isAnchorIntact('@Ann Smith', anchor(3, 'Ann', 0))).toBe(true);
    expect(isAnchorIntact('@Ann.', anchor(3, 'Ann', 0))).toBe(true);
    expect(isAnchorIntact('@Ann,', anchor(3, 'Ann', 0))).toBe(true);
  });

  it('rejects a trailing word character — this is the demotion', () => {
    expect(isAnchorIntact('@Annx', anchor(3, 'Ann', 0))).toBe(false);
  });

  it('rejects a leading word character', () => {
    expect(isAnchorIntact('x@Ann', anchor(3, 'Ann', 1))).toBe(false);
  });

  it('rejects when the name no longer matches', () => {
    expect(isAnchorIntact('@Anb', anchor(3, 'Ann', 0))).toBe(false);
  });

  it('rejects an offset past the end of the text', () => {
    expect(isAnchorIntact('@Ann', anchor(3, 'Ann', 10))).toBe(false);
  });
});

// =============================================================================
// reconcileAnchors
// =============================================================================

describe('reconcileAnchors', () => {
  it('shifts an anchor when text is inserted before it', () => {
    const prev = 'hi @Ann';
    const next = 'oh hi @Ann';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 3)])).toEqual([anchor(3, 'Ann', 6)]);
  });

  it('leaves an anchor alone when text is inserted after it', () => {
    const prev = '@Ann hi';
    const next = '@Ann hi there';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 0)])).toEqual([anchor(3, 'Ann', 0)]);
  });

  it('shifts an anchor back when text before it is deleted', () => {
    const prev = 'oh hi @Ann';
    const next = 'hi @Ann';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 6)])).toEqual([anchor(3, 'Ann', 3)]);
  });

  it('drops an anchor the edit overlapped', () => {
    const prev = 'hi @Ann';
    const next = 'hi @An';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 3)])).toEqual([]);
  });

  it('drops an anchor when a word character is appended to it', () => {
    const prev = 'hi @Ann';
    const next = 'hi @Annx';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 3)])).toEqual([]);
  });

  it('drops every anchor on select-all-and-replace', () => {
    const prev = '@Ann and @Bob';
    expect(reconcileAnchors(prev, 'x', [anchor(3, 'Ann', 0), anchor(4, 'Bob', 9)])).toEqual([]);
  });

  it('shifts several anchors independently', () => {
    const prev = '@Ann and @Bob';
    const next = 'Oh @Ann and @Bob';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 0), anchor(4, 'Bob', 9)])).toEqual([
      anchor(3, 'Ann', 3),
      anchor(4, 'Bob', 12),
    ]);
  });

  it('demotes a mention that a preceding word character turns into an address', () => {
    // "X@Ann" reads as an email, not a mention — the same guard that stops
    // findActiveQuery opening on bob@example.com.
    const prev = '@Ann and @Bob';
    const next = 'X@Ann and @Bob';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 0), anchor(4, 'Bob', 9)])).toEqual([
      anchor(4, 'Bob', 10),
    ]);
  });

  it('revalidates survivors even when the edit was elsewhere', () => {
    // Deleting from the tail leaves the first anchor's offsets untouched but
    // must still re-check it.
    const prev = '@Ann tail';
    const next = '@Ann';
    expect(reconcileAnchors(prev, next, [anchor(3, 'Ann', 0)])).toEqual([anchor(3, 'Ann', 0)]);
  });
});

// =============================================================================
// The cases a name-scanning design gets wrong
// =============================================================================

describe('adversarial cases', () => {
  it('keeps ids attached to positions when two people share a display name', () => {
    // Both called "Alice Anderson"; picked in the opposite order to the text.
    const text = '@Alice Anderson and @Alice Anderson';
    const anchors = [anchor(9, 'Alice Anderson', 20), anchor(7, 'Alice Anderson', 0)];

    expect(serializeMentions(text, anchors)).toBe(
      '@[Alice Anderson](7) and @[Alice Anderson](9)'
    );
    expect(mentionedUserIds(text, anchors)).toEqual([7, 9]);
  });

  it('does not let a picked short name attach to a longer typed one', () => {
    // "Ann" is picked at offset 0. "@Anna Smith" later is plain typed text.
    const text = '@Ann see @Anna Smith';
    const anchors = [anchor(3, 'Ann', 0)];

    expect(serializeMentions(text, anchors)).toBe('@[Ann](3) see @Anna Smith');
    expect(mentionedUserIds(text, anchors)).toEqual([3]);
  });

  it('does not corrupt the body when a short name sits inside a longer one', () => {
    // An anchor pointing at "@Anna Smith"'s prefix is invalid by the boundary
    // rule, so it is dropped rather than splicing a token mid-word.
    const text = '@Anna Smith';
    expect(serializeMentions(text, [anchor(3, 'Ann', 0)])).toBe('@Anna Smith');
  });

  it('supports the same person mentioned twice', () => {
    const text = '@Bob and @Bob';
    const anchors = [anchor(4, 'Bob', 0), anchor(4, 'Bob', 9)];
    expect(serializeMentions(text, anchors)).toBe('@[Bob](4) and @[Bob](4)');
    expect(mentionedUserIds(text, anchors)).toEqual([4]);
  });
});

// =============================================================================
// insertMention
// =============================================================================

describe('insertMention', () => {
  it('replaces the query and appends a trailing space', () => {
    const result = insertMention('hi @Ali', [], { start: 3, query: 'Ali' }, {
      id: 7,
      name: 'Alice Anderson',
    });
    expect(result.text).toBe('hi @Alice Anderson ');
    expect(result.caret).toBe(result.text.length);
    expect(result.anchors).toEqual([anchor(7, 'Alice Anderson', 3)]);
  });

  it('keeps and shifts earlier anchors', () => {
    const text = '@Bob hi @Ali';
    const result = insertMention(text, [anchor(4, 'Bob', 0)], { start: 8, query: 'Ali' }, {
      id: 7,
      name: 'Alice Anderson',
    });
    expect(result.text).toBe('@Bob hi @Alice Anderson ');
    expect(result.anchors).toEqual([anchor(4, 'Bob', 0), anchor(7, 'Alice Anderson', 8)]);
  });

  it('produces an immediately valid anchor mid-sentence', () => {
    const result = insertMention('see @a end', [], { start: 4, query: 'a' }, { id: 7, name: 'Al' });
    expect(result.text).toBe('see @Al  end');
    expect(isAnchorIntact(result.text, result.anchors[0])).toBe(true);
  });
});

// =============================================================================
// segmentDraft and the truth invariant
// =============================================================================

describe('segmentDraft', () => {
  it('splits text around mention runs', () => {
    expect(segmentDraft('hi @Bob !', [anchor(4, 'Bob', 3)])).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@Bob', userId: 4, name: 'Bob' },
      { kind: 'text', text: ' !' },
    ]);
  });

  it('omits anchors that no longer match', () => {
    expect(segmentDraft('hi @Bobx', [anchor(4, 'Bob', 3)])).toEqual([
      { kind: 'text', text: 'hi @Bobx' },
    ]);
  });

  it('returns a single text segment for a plain draft', () => {
    expect(segmentDraft('nothing here', [])).toEqual([{ kind: 'text', text: 'nothing here' }]);
  });

  it('handles an empty draft', () => {
    expect(segmentDraft('', [])).toEqual([]);
  });
});

describe('the truth invariant', () => {
  // What the user sees highlighted must equal what is serialized, which must
  // equal who gets notified. One function drives all three, and this pins it.
  const cases: Array<{ text: string; anchors: MentionAnchor[] }> = [
    { text: '@Bob hi', anchors: [anchor(4, 'Bob', 0)] },
    { text: 'hi @Bob', anchors: [anchor(4, 'Bob', 3)] },
    { text: '@Ann see @Anna Smith', anchors: [anchor(3, 'Ann', 0)] },
    {
      text: '@Alice Anderson and @Alice Anderson',
      anchors: [anchor(9, 'Alice Anderson', 20), anchor(7, 'Alice Anderson', 0)],
    },
    { text: 'demoted @Bobx', anchors: [anchor(4, 'Bob', 8)] },
    { text: 'none at all', anchors: [] },
  ];

  it.each(cases)('highlight, body and ids agree for %o', ({ text, anchors }) => {
    const highlighted = segmentDraft(text, anchors)
      .filter((s) => s.kind === 'mention')
      .map((s) => (s as Extract<typeof s, { kind: 'mention' }>).userId);
    const body = serializeMentions(text, anchors);
    const fromBody = parseMentionTokens(body)
      .filter((s) => s.kind === 'mention')
      .map((s) => (s as Extract<typeof s, { kind: 'mention' }>).userId);

    expect(fromBody).toEqual(highlighted);
    expect(mentionedUserIds(text, anchors)).toEqual(Array.from(new Set(highlighted)));
  });
});

// =============================================================================
// Wire format
// =============================================================================

describe('serializeMentions', () => {
  it('leaves a plain draft untouched', () => {
    expect(serializeMentions('just text', [])).toBe('just text');
  });

  it('survives trimming the result rather than the input', () => {
    // Trimming the draft first would shift every offset.
    const text = '  @Bob hi  ';
    expect(serializeMentions(text, [anchor(4, 'Bob', 2)]).trim()).toBe('@[Bob](4) hi');
  });
});

describe('parseMentionTokens', () => {
  it('treats a comment written before mentions existed as plain text', () => {
    expect(parseMentionTokens('hello @Bob')).toEqual([{ kind: 'text', text: 'hello @Bob' }]);
  });

  it('parses a token at the start and at the end', () => {
    expect(parseMentionTokens('@[Bob](4) hi')[0]).toEqual({
      kind: 'mention',
      text: '@Bob',
      userId: 4,
      name: 'Bob',
    });
    expect(parseMentionTokens('hi @[Bob](4)')[1]).toEqual({
      kind: 'mention',
      text: '@Bob',
      userId: 4,
      name: 'Bob',
    });
  });

  it('parses adjacent tokens', () => {
    expect(parseMentionTokens('@[A](1)@[B](2)').filter((s) => s.kind === 'mention')).toHaveLength(2);
  });

  it('leaves a malformed token as text', () => {
    expect(parseMentionTokens('@[Alice](x)')).toEqual([{ kind: 'text', text: '@[Alice](x)' }]);
  });

  it('handles an empty body', () => {
    expect(parseMentionTokens('')).toEqual([]);
  });
});

describe('stripMentionTokens', () => {
  it('reduces tokens to plain @Name', () => {
    expect(stripMentionTokens('hi @[Alice Anderson](7) and @[Bob](4)')).toBe(
      'hi @Alice Anderson and @Bob'
    );
  });

  it('leaves a plain body untouched', () => {
    expect(stripMentionTokens('nothing here')).toBe('nothing here');
  });
});

describe('deserializeMentions', () => {
  it('round-trips a serialized body', () => {
    const text = '@Bob and @Alice Anderson done';
    const anchors = [anchor(4, 'Bob', 0), anchor(7, 'Alice Anderson', 9)];
    const body = serializeMentions(text, anchors);

    const back = deserializeMentions(body);
    expect(back.text).toBe(text);
    expect(back.anchors).toEqual(anchors);
    expect(serializeMentions(back.text, back.anchors)).toBe(body);
  });
});

// =============================================================================
// Candidates
// =============================================================================

describe('buildMentionCandidates', () => {
  const staff = [
    { id: 7, name: 'Alice Anderson', role: 'Engineer' },
    { id: 7, name: 'Alice Anderson', role: 'Engineer' }, // same user, second site
    { id: 4, name: 'Bob Brown', role: 'Analyst' },
  ];

  it('deduplicates the one-row-per-user-site staff list', () => {
    const result = buildMentionCandidates([], staff);
    expect(result.map((c) => c.id)).toEqual([7, 4]);
  });

  it('pins card assignees to the top', () => {
    const result = buildMentionCandidates([{ staff_id: 4, staff_name: 'Bob Brown' }], staff);
    expect(result[0]).toMatchObject({ id: 4, onCard: true });
    expect(result[1]).toMatchObject({ id: 7, onCard: false });
  });

  it('synthesizes an assignee who is absent from staff', () => {
    // Admins are excluded from GET /staff but can be assigned to a card.
    const result = buildMentionCandidates([{ staff_id: 99, staff_name: 'Ada Admin' }], staff);
    expect(result[0]).toMatchObject({ id: 99, name: 'Ada Admin', onCard: true });
  });

  it('skips a nameless assignment it cannot render', () => {
    expect(buildMentionCandidates([{ staff_id: 99 }], staff).map((c) => c.id)).toEqual([7, 4]);
  });

  it('excludes the current user, who cannot be notified anyway', () => {
    expect(buildMentionCandidates([], staff, 7).map((c) => c.id)).toEqual([4]);
  });

  it('excludes the current user even when they are on the card', () => {
    const result = buildMentionCandidates([{ staff_id: 7, staff_name: 'Alice Anderson' }], staff, 7);
    expect(result.map((c) => c.id)).toEqual([4]);
  });
});

describe('filterCandidates', () => {
  const all = buildMentionCandidates([], [
    { id: 7, name: 'Alice Anderson' },
    { id: 4, name: 'Bob Brown' },
  ]);

  it('returns everything for an empty query', () => {
    expect(filterCandidates(all, '')).toHaveLength(2);
  });

  it('matches case-insensitively anywhere in the name', () => {
    expect(filterCandidates(all, 'ander').map((c) => c.id)).toEqual([7]);
    expect(filterCandidates(all, 'BROWN').map((c) => c.id)).toEqual([4]);
  });

  it('returns nothing when no name matches', () => {
    expect(filterCandidates(all, 'zzz')).toEqual([]);
  });
});
