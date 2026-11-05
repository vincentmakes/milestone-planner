/**
 * retryableLazy — a `React.lazy` that an `ErrorBoundary` Retry can recover.
 *
 * `React.lazy` caches a rejected import: remounting the same lazy component
 * re-throws the same error forever, so a chunk that failed to load (a
 * network blip, a redeploy that changed its hash) could never come back.
 * `retryableLazy(load)` returns a getter: it hands out one lazy component
 * while its import has not failed — a loaded view mounts again without a
 * Suspense flash — and a fresh one (a new `import()`) after a failure. Call
 * the getter where the boundary's Retry remounts (`useState(getter)` in a
 * component below the boundary).
 */

import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

export function retryableLazy<T extends ComponentType<object>>(
  load: () => Promise<{ default: T }>
): () => LazyExoticComponent<T> {
  let failed = false;
  const create = () => {
    failed = false;
    return lazy(() =>
      load().catch((err: unknown) => {
        failed = true;
        throw err;
      })
    );
  };
  let current = create();
  return () => {
    if (failed) current = create();
    return current;
  };
}
