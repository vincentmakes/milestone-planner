/**
 * useSettingWriter - instance settings that apply the moment they change.
 *
 * `write(key, value)` puts the value in `appStore.instanceSettings` at once
 * (optimistic, synchronous) and persists it with `PUT /api/settings/{key}`:
 * - One PUT per key at a time. A write while that key's PUT is in flight is
 *   kept as the next value (newest wins) and sent when the PUT returns, so a
 *   burst of clicks costs two PUTs and the server ends on the last value.
 * - When the last PUT of a key succeeds, the server's answer (its canonical
 *   form) is written to the store again: a `change:settings` refetch that
 *   landed between the click and the commit would otherwise snap the control
 *   back to the old value.
 * - On a failure the key's queue is dropped, the message goes to `onError`
 *   (the panel's error Notice) or, once the panel has unmounted (a blur save
 *   can outlive the Settings hub), to `uiStore.showFlash`, and the settings
 *   are reloaded from the server so the store holds the truth again.
 *   Settings are not on the undo stack, so `recoverFromPersistFailure` does
 *   not apply.
 * Queued sends are not cancelled on unmount. `pending` is true while any PUT
 * is in flight; `savedAt` changes each time a key's writes have all landed.
 *
 * One writer per panel: two writers on the same key would not serialise.
 * The value is the setting's canonical string; computing it from
 * `useAppStore.getState()` at click time (not from the render) keeps a change
 * that a stale refetch has not shown yet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { getInstanceSettings, updateSetting } from '@/api/endpoints/settings';
import type { InstanceSettings } from '@/types';

export type InstanceSettingKey = string & keyof InstanceSettings;

export interface SettingWriter {
  write: (key: InstanceSettingKey, value: string) => void;
  /** A PUT is in flight */
  pending: boolean;
  /** When the last key's writes all landed (Date.now()); null before the first */
  savedAt: number | null;
}

function putInStore(key: InstanceSettingKey, value: string) {
  const { instanceSettings, setInstanceSettings } = useAppStore.getState();
  setInstanceSettings({ ...(instanceSettings ?? {}), [key]: value });
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Failed to save the setting';
}

export function useSettingWriter(onError: (message: string) => void): SettingWriter {
  // Per key: the value to send once the PUT in flight returns (undefined = none)
  const queues = useRef(new Map<InstanceSettingKey, { next: string | undefined }>());
  const inFlight = useRef(0);
  const mounted = useRef(true);
  const onErrorRef = useRef(onError);
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const changeInFlight = useCallback((delta: number) => {
    inFlight.current += delta;
    if (mounted.current) setPending(inFlight.current > 0);
  }, []);

  const send = useCallback(
    async (key: InstanceSettingKey, value: string) => {
      const entry: { next: string | undefined } = { next: undefined };
      queues.current.set(key, entry);
      changeInFlight(1);
      let sent = value;
      try {
        for (;;) {
          const res = await updateSetting(key, sent);
          if (entry.next === undefined) {
            putInStore(key, res?.value ?? sent);
            break;
          }
          sent = entry.next;
          entry.next = undefined;
        }
        queues.current.delete(key);
        if (mounted.current) setSavedAt((prev) => Math.max(Date.now(), (prev ?? 0) + 1));
      } catch (err) {
        queues.current.delete(key);
        const message = errorMessage(err);
        if (mounted.current) onErrorRef.current(message);
        else useUIStore.getState().showFlash(message);
        try {
          useAppStore.getState().setInstanceSettings(await getInstanceSettings());
        } catch {
          // The store keeps the optimistic value; the next load corrects it.
        }
      } finally {
        changeInFlight(-1);
      }
    },
    [changeInFlight]
  );

  const write = useCallback(
    (key: InstanceSettingKey, value: string) => {
      putInStore(key, value);
      const queued = queues.current.get(key);
      if (queued) {
        queued.next = value;
        return;
      }
      void send(key, value);
    },
    [send]
  );

  return { write, pending, savedAt };
}
