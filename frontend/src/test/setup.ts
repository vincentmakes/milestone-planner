import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { restoreConfirm } from './confirmDialog';
import { useConfirmStore } from '@/stores/confirmStore';
import { clearMentionableUsersCache } from '@/api/endpoints/mentionableCache';

// jsdom has no ResizeObserver: a no-op stand-in, so components that follow
// their container's size (the dashboards' grid and charts) mount. A test that
// needs the callbacks stubs its own (vi.stubGlobal), as useScrollSync's does.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// A confirm stub or a pending in-app confirmation never leaks into the next test.
afterEach(() => {
  restoreConfirm();
  useConfirmStore.getState().reset();
  // The @-mention lists are cached for the session; each test starts empty.
  clearMentionableUsersCache();
});
