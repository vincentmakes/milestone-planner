import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { restoreConfirm } from './confirmDialog';
import { useConfirmStore } from '@/stores/confirmStore';

// A confirm stub or a pending in-app confirmation never leaks into the next test.
afterEach(() => {
  restoreConfirm();
  useConfirmStore.getState().reset();
});
