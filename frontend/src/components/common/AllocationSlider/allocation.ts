/**
 * The vocabulary of an allocation, kept out of the component file so fast
 * refresh still works there (a module mixing components and constants loses it).
 */

export const MIN_ALLOCATION = 5;
export const MAX_ALLOCATION = 100;
export const ALLOCATION_STEP = 5;

/** Imported plans carry any integer; the slider only speaks in 5s. */
export function snapToStep(value: number): number {
  return Math.round(value / ALLOCATION_STEP) * ALLOCATION_STEP;
}

export function clampAllocation(value: number): number {
  return Math.max(MIN_ALLOCATION, Math.min(MAX_ALLOCATION, value));
}
