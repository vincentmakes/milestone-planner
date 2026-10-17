import { describe, it, expect, vi } from 'vitest';
import { useConfirmStore } from '../confirmStore';

describe('confirmStore', () => {
  it('queues requests in order with distinct ids', () => {
    const a = useConfirmStore.getState().enqueue({ message: 'A' }, vi.fn());
    const b = useConfirmStore.getState().enqueue({ message: 'B', destructive: true }, vi.fn());
    expect(a).not.toBe(b);
    const queue = useConfirmStore.getState().queue;
    expect(queue.map((r) => r.message)).toEqual(['A', 'B']);
    expect(queue[1]).toMatchObject({ id: b, destructive: true });
  });

  it('settle resolves one request once and removes it; unknown ids are ignored', () => {
    const resolveA = vi.fn();
    const resolveB = vi.fn();
    const a = useConfirmStore.getState().enqueue({ message: 'A' }, resolveA);
    useConfirmStore.getState().enqueue({ message: 'B' }, resolveB);

    useConfirmStore.getState().settle(a, true);
    useConfirmStore.getState().settle(a, false);
    useConfirmStore.getState().settle(-1, true);

    expect(resolveA).toHaveBeenCalledTimes(1);
    expect(resolveA).toHaveBeenCalledWith(true);
    expect(resolveB).not.toHaveBeenCalled();
    expect(useConfirmStore.getState().queue.map((r) => r.message)).toEqual(['B']);
  });

  it('reset resolves every pending request false and empties the queue', () => {
    const resolveA = vi.fn();
    const resolveB = vi.fn();
    useConfirmStore.getState().enqueue({ message: 'A' }, resolveA);
    useConfirmStore.getState().enqueue({ message: 'B' }, resolveB);

    useConfirmStore.getState().reset();

    expect(resolveA).toHaveBeenCalledWith(false);
    expect(resolveB).toHaveBeenCalledWith(false);
    expect(useConfirmStore.getState().queue).toEqual([]);

    // Nothing pending: a second reset is a no-op
    useConfirmStore.getState().reset();
    expect(resolveA).toHaveBeenCalledTimes(1);
  });
});
