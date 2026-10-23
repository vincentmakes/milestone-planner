/**
 * The view leave guard: nothing registered → the switch runs at once;
 * registered → it runs once the guard agrees; unregistering only removes
 * the guard it registered.
 */
import { describe, it, expect, vi } from 'vitest';
import { leaveViewThen, setViewLeaveGuard, viewLeaveGuard } from '../viewLeaveGuard';

describe('viewLeaveGuard', () => {
  it('switches at once without a guard', () => {
    const go = vi.fn();
    expect(viewLeaveGuard()).toBeNull();
    leaveViewThen(go);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('switches only when the guard agrees', async () => {
    const go = vi.fn();
    const unregister = setViewLeaveGuard(async () => false);
    leaveViewThen(go);
    await Promise.resolve();
    expect(go).not.toHaveBeenCalled();
    unregister();
    const again = setViewLeaveGuard(async () => true);
    leaveViewThen(go);
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    again();
    expect(viewLeaveGuard()).toBeNull();
  });

  it('leaves a newer guard in place when an older one unregisters', () => {
    const older = setViewLeaveGuard(async () => true);
    const newer = async () => false;
    const unregisterNewer = setViewLeaveGuard(newer);
    older();
    expect(viewLeaveGuard()).toBe(newer);
    unregisterNewer();
    expect(viewLeaveGuard()).toBeNull();
  });
});
