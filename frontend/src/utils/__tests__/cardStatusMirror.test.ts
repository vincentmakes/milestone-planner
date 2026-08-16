/**
 * Mirror of tests/test_card_status.py.
 *
 * The board applies an optimistic status change locally before the server
 * confirms it. That is only safe while this mirror produces exactly what
 * app/services/card_status.py produces -- so this matrix is deliberately
 * identical to the backend one. If you change one, change both.
 */

import { describe, it, expect } from 'vitest';
import {
  CARD_STATUSES,
  applyStatusToCard,
  completionForStatus,
  statusFromCompletion,
} from '../kanbanCards';
import type { CardStatus } from '@/types';

describe('statusFromCompletion', () => {
  it.each([
    [null, 'todo', 'todo'],
    [null, 'in_progress', 'todo'],
    [0, 'todo', 'todo'],
    [0, 'in_progress', 'todo'],
    [1, 'todo', 'in_progress'],
    [50, 'todo', 'in_progress'],
    [99, 'todo', 'in_progress'],
    [100, 'todo', 'done'],
    [100, 'in_progress', 'done'],
    [-5, 'todo', 'todo'],
    [150, 'todo', 'done'],
  ])('completion=%s current=%s -> %s', (completion, current, expected) => {
    expect(statusFromCompletion(completion as number | null, current as CardStatus)).toBe(expected);
  });

  it.each([1, 50, 99])(
    'blocked survives an in-progress completion edit (%i%%)',
    (completion) => {
      expect(statusFromCompletion(completion, 'blocked')).toBe('blocked');
    }
  );

  it.each([
    [0, 'todo'],
    [null, 'todo'],
    [100, 'done'],
  ])('blocked yields to terminal completion %s -> %s', (completion, expected) => {
    expect(statusFromCompletion(completion as number | null, 'blocked')).toBe(expected);
  });

  it('treats undefined like null', () => {
    expect(statusFromCompletion(undefined, 'todo')).toBe('todo');
  });
});

describe('completionForStatus', () => {
  it.each([
    ['todo', null, 0],
    ['todo', 75, 0],
    ['done', null, 100],
    ['done', 12, 100],
    ['in_progress', 1, 1],
    ['in_progress', 42, 42],
    ['in_progress', 99, 99],
    ['in_progress', null, 50],
    ['in_progress', 0, 50],
    ['in_progress', 100, 50],
  ])('status=%s current=%s -> %s', (status, current, expected) => {
    expect(completionForStatus(status as CardStatus, current as number | null)).toBe(expected);
  });

  it.each([null, 0, 37, 100])('blocked leaves completion untouched (%s)', (current) => {
    expect(completionForStatus('blocked', current as number | null)).toBe(current);
  });
});

describe('applyStatusToCard', () => {
  it('sets both fields', () => {
    const card = { status: 'todo' as CardStatus, completion: null as number | null };
    const result = applyStatusToCard(card, 'done');
    expect(card).toEqual({ status: 'done', completion: 100 });
    expect(result).toEqual({ status: 'done', completion: 100 });
  });

  it('keeps progress when blocking', () => {
    const card = { status: 'in_progress' as CardStatus, completion: 30 as number | null };
    applyStatusToCard(card, 'blocked');
    expect(card).toEqual({ status: 'blocked', completion: 30 });
  });

  it('starts halfway when moving an untouched card into progress', () => {
    const card = { status: 'todo' as CardStatus, completion: 0 as number | null };
    applyStatusToCard(card, 'in_progress');
    expect(card).toEqual({ status: 'in_progress', completion: 50 });
  });

  it('is stable when applied twice, for every status', () => {
    for (const status of CARD_STATUSES) {
      const card = { status: 'in_progress' as CardStatus, completion: 42 as number | null };
      const first = applyStatusToCard(card, status);
      const second = applyStatusToCard(card, status);
      expect(second).toEqual(first);
    }
  });
});
