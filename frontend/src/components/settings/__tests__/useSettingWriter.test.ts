/**
 * useSettingWriter: the store takes a value at once; one PUT per key at a
 * time, the newest queued value sent next; the server's answer re-asserted
 * after the last PUT; a failure reported (to the panel, or as a flash once
 * unmounted) and the settings reloaded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSettingWriter } from '../useSettingWriter';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';

const api = vi.hoisted(() => ({ getInstanceSettings: vi.fn(), updateSetting: vi.fn() }));
vi.mock('@/api/endpoints/settings', () => ({
  getInstanceSettings: api.getInstanceSettings,
  updateSetting: api.updateSetting,
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.updateSetting.mockReset().mockResolvedValue({});
  api.getInstanceSettings.mockReset().mockResolvedValue({ instance_title: 'Server' });
  useAppStore.setState({ instanceSettings: { instance_title: 'Lab' } });
  useUIStore.setState({ flashNotice: null });
});

describe('useSettingWriter', () => {
  it('writes the store before the PUT answers, then marks it saved', async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    const { result } = renderHook(() => useSettingWriter(vi.fn()));
    expect(result.current.savedAt).toBeNull();

    act(() => result.current.write('volume_decimals', '2'));
    expect(useAppStore.getState().instanceSettings).toEqual({ instance_title: 'Lab', volume_decimals: '2' });
    expect(api.updateSetting).toHaveBeenCalledWith('volume_decimals', '2');
    expect(result.current.pending).toBe(true);

    await act(async () => put.resolve({ value: '2' }));
    expect(result.current.pending).toBe(false);
    expect(result.current.savedAt).not.toBeNull();
  });

  it('sends one PUT per key at a time and the newest queued value next', async () => {
    const first = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useSettingWriter(vi.fn()));

    act(() => {
      result.current.write('project_fields_hidden', '["customer"]');
      result.current.write('project_fields_hidden', '[]');
      result.current.write('project_fields_hidden', '["volume"]');
      // Another key is not held back
      result.current.write('volume_decimals', '0');
    });
    expect(api.updateSetting.mock.calls).toEqual([
      ['project_fields_hidden', '["customer"]'],
      ['volume_decimals', '0'],
    ]);
    expect(useAppStore.getState().instanceSettings?.project_fields_hidden).toBe('["volume"]');

    await act(async () => first.resolve({ value: '["customer"]' }));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(api.updateSetting.mock.calls).toEqual([
      ['project_fields_hidden', '["customer"]'],
      ['volume_decimals', '0'],
      ['project_fields_hidden', '["volume"]'],
    ]);
    // The first answer never overwrote the newer value
    expect(useAppStore.getState().instanceSettings?.project_fields_hidden).toBe('["volume"]');
  });

  it("re-asserts the server's value over a stale refetch", async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    const { result } = renderHook(() => useSettingWriter(vi.fn()));

    act(() => result.current.write('project_field_labels', '{"customer":" Client "}'));
    // A change:settings refetch lands with the old value
    useAppStore.setState({ instanceSettings: { instance_title: 'Lab', project_field_labels: '{}' } });
    await act(async () => put.resolve({ value: '{"customer":"Client"}' }));
    expect(useAppStore.getState().instanceSettings?.project_field_labels).toBe('{"customer":"Client"}');
  });

  it('keeps the sent value when the answer carries none', async () => {
    const { result } = renderHook(() => useSettingWriter(vi.fn()));
    act(() => result.current.write('volume_decimals', '3'));
    useAppStore.setState({ instanceSettings: { volume_decimals: '1' } });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(useAppStore.getState().instanceSettings?.volume_decimals).toBe('3');
  });

  it('reports a failure, drops the queue and reloads the settings', async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    const onError = vi.fn();
    const { result } = renderHook(() => useSettingWriter(onError));

    act(() => {
      result.current.write('volume_decimals', '2');
      result.current.write('volume_decimals', '3');
    });
    await act(async () => put.reject(new Error('Invalid value for volume_decimals')));
    await waitFor(() => expect(useAppStore.getState().instanceSettings).toEqual({ instance_title: 'Server' }));
    expect(onError).toHaveBeenCalledWith('Invalid value for volume_decimals');
    // The queued 3 is dropped with the failed key
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
    expect(result.current.savedAt).toBeNull();

    // A later write starts afresh
    act(() => result.current.write('volume_decimals', '0'));
    expect(api.updateSetting).toHaveBeenLastCalledWith('volume_decimals', '0');
  });

  it('uses a generic message and survives a failed reload', async () => {
    api.updateSetting.mockRejectedValueOnce('nope');
    api.getInstanceSettings.mockRejectedValueOnce(new Error('offline'));
    const onError = vi.fn();
    const { result } = renderHook(() => useSettingWriter(onError));
    act(() => result.current.write('volume_decimals', '2'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Failed to save the setting'));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(useAppStore.getState().instanceSettings?.volume_decimals).toBe('2');
  });

  it('finishes a write after unmount and reports its failure as a flash', async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useSettingWriter(onError));
    act(() => result.current.write('project_field_labels', '{"volume":"Budget"}'));
    unmount();

    await act(async () => put.reject(new Error('Forbidden')));
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Forbidden'));
    expect(onError).not.toHaveBeenCalled();
  });
});
