import { describe, it, expect } from 'vitest';
import { stubConfirm, restoreConfirm } from './confirmDialog';
import { confirmAction } from '@/utils/confirmDialog';
import { useConfirmStore } from '@/stores/confirmStore';

describe('confirm test helpers', () => {
  it('stubConfirm(false) answers false and records the options', async () => {
    const confirm = stubConfirm(false);
    await expect(confirmAction({ message: 'Delete it?', destructive: true })).resolves.toBe(false);
    await expect(confirmAction('Bare string?')).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete it?', destructive: true }));
    expect(confirm).toHaveBeenCalledWith({ message: 'Bare string?' });
    expect(useConfirmStore.getState().queue).toHaveLength(0);
  });

  it('stubConfirm() answers true by default, and accepts a function', async () => {
    stubConfirm();
    await expect(confirmAction('Go?')).resolves.toBe(true);
    stubConfirm((options) => options.message === 'yes');
    await expect(confirmAction('yes')).resolves.toBe(true);
    await expect(confirmAction('no')).resolves.toBe(false);
  });

  it('restoreConfirm() puts the store-backed handler back', async () => {
    const confirm = stubConfirm(true);
    restoreConfirm();
    const answer = confirmAction({ message: 'Real dialog?' });
    expect(confirm).not.toHaveBeenCalled();
    const [request] = useConfirmStore.getState().queue;
    expect(request).toMatchObject({ message: 'Real dialog?' });
    useConfirmStore.getState().settle(request.id, true);
    await expect(answer).resolves.toBe(true);
  });
});
