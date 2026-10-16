/**
 * STORAGE_KEYS is the documentation of record for localStorage keys (F1-18):
 * only keys something actually reads, and the Zustand persist names must
 * match what the stores declare inline.
 */
import { describe, it, expect } from 'vitest';
import * as storage from '../storage';
import { STORAGE_KEYS } from '../storage';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';

describe('STORAGE_KEYS', () => {
  it('lists only live keys (the never-read legacy/preference keys are gone)', () => {
    expect(Object.keys(STORAGE_KEYS).sort()).toEqual([
      'KANBAN_DUE_DISMISSED',
      'PREF_THEME',
      'PROJECT_ORDER_PREFIX',
      'ZUSTAND_APP_STORE',
      'ZUSTAND_CUSTOM_COLUMN_STORE',
      'ZUSTAND_VIEW_STORE',
    ]);
  });

  it('no longer ships the dead legacy-storage migration', () => {
    expect(Object.keys(storage)).not.toContain('migrateLegacyStorage');
  });

  it('documents the persist key of every persisted store', () => {
    expect(useAppStore.persist.getOptions().name).toBe(STORAGE_KEYS.ZUSTAND_APP_STORE);
    expect(useViewStore.persist.getOptions().name).toBe(STORAGE_KEYS.ZUSTAND_VIEW_STORE);
    expect(useCustomColumnStore.persist.getOptions().name).toBe(STORAGE_KEYS.ZUSTAND_CUSTOM_COLUMN_STORE);
  });
});
