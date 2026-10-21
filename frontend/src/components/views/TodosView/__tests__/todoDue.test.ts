import { describe, it, expect } from 'vitest';
import { taskDueState } from '../todoDue';

describe('taskDueState', () => {
  it('is overdue before today, due soon within a week, nothing later', () => {
    expect(taskDueState({ status: 'open', due_date: '2026-10-21' }, '2026-10-22')).toBe('overdue');
    expect(taskDueState({ status: 'open', due_date: '2026-10-22' }, '2026-10-22')).toBe('due-soon');
    expect(taskDueState({ status: 'open', due_date: '2026-10-29' }, '2026-10-22')).toBe('due-soon');
    expect(taskDueState({ status: 'open', due_date: '2026-10-30' }, '2026-10-22')).toBeNull();
  });

  it('is nothing for a done task or a task without a date', () => {
    expect(taskDueState({ status: 'done', due_date: '2026-10-01' }, '2026-10-22')).toBeNull();
    expect(taskDueState({ status: 'open', due_date: null }, '2026-10-22')).toBeNull();
  });
});
