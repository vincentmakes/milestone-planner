/**
 * Chunked bulk imports: the backend rejects more than 1 000 items per import
 * request, so the importers split large .ics files into slices of 500 and
 * report one summed result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import { postInChunks, IMPORT_CHUNK_SIZE } from '../importChunks';
import { importVacations } from '../vacations';
import { importBankHolidays, importCompanyEvents } from '../sites';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  downloadFile: vi.fn(),
}));

const apiPost = vi.mocked(client.apiPost);

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

type Body = { items: unknown[] } & Record<string, unknown>;

/** Answers each POST with created = items sent, skipped = 1. */
function answerPerChunk(extra: Record<string, number> = {}) {
  apiPost.mockImplementation(async (_url: string, body?: unknown) => ({
    created: (body as Body).items.length,
    skipped: 1,
    ...extra,
  }));
}

beforeEach(() => {
  apiPost.mockReset();
});

describe('postInChunks', () => {
  it('sends 1 201 items as 500 / 500 / 201, in order, and sums the counts', async () => {
    const send = vi.fn(async (chunk: number[]) => ({ created: chunk.length - 1, skipped: 1 }));
    const result = await postInChunks(range(1201), send);

    expect(IMPORT_CHUNK_SIZE).toBe(500);
    expect(send.mock.calls.map(([chunk]) => chunk.length)).toEqual([500, 500, 201]);
    expect(send.mock.calls[1][0][0]).toBe(500);
    expect(send.mock.calls[2][0][200]).toBe(1200);
    expect(result).toEqual({ created: 1198, skipped: 3 });
    expect(result).not.toHaveProperty('linked');
  });

  it('sums linked only when a response carries it', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ created: 2, skipped: 0, linked: 1 })
      .mockResolvedValueOnce({ created: 1, skipped: 0 });
    await expect(postInChunks(range(3), send, 2)).resolves.toEqual({ created: 3, skipped: 0, linked: 1 });
  });

  it('sends a list that fits in one slice (even an empty one) as a single call', async () => {
    const send = vi.fn(async (chunk: number[]) => ({ created: 0, skipped: chunk.length }));
    await postInChunks([], send);
    await expect(postInChunks(range(500), send)).resolves.toEqual({ created: 0, skipped: 500 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toHaveLength(500);
  });

  it('reports how many items were imported when a later slice fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ created: 498, skipped: 2 })
      .mockRejectedValueOnce(new Error('Server error'));
    await expect(postInChunks(range(1201), send)).rejects.toThrow(
      'Import stopped after 500 of 1201 items (498 created, 2 skipped): Server error. ' +
        'Retrying is safe — items already imported are skipped.'
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('renumbers a rejected item to its position in the whole list', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ created: 500, skipped: 0 })
      .mockResolvedValueOnce({ created: 500, skipped: 0 })
      .mockRejectedValueOnce(
        new Error('Item 37: end date makes the range longer than 366 days')
      );
    // The backend numbered row 37 of the third slice; the user sees row 1 037.
    await expect(postInChunks(range(1201), send)).rejects.toThrow(
      'Import stopped after 1000 of 1201 items (1000 created, 0 skipped): ' +
        'Item 1037: end date makes the range longer than 366 days.'
    );
  });

  it('rethrows the original error when the first slice fails', async () => {
    const boom = new Error('Validation failed');
    const send = vi.fn().mockRejectedValue(boom);
    await expect(postInChunks(range(1201), send)).rejects.toBe(boom);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('describes a non-Error rejection too', async () => {
    const send = vi.fn().mockResolvedValueOnce({ created: 1, skipped: 0 }).mockRejectedValueOnce('offline');
    await expect(postInChunks(range(2), send, 1)).rejects.toThrow('(1 created, 0 skipped): offline.');
  });
});

describe('importers send large lists in chunks', () => {
  it('importVacations', async () => {
    answerPerChunk();
    const items = range(1201).map((i) => ({ start_date: `d${i}`, end_date: `d${i}` }));
    await expect(importVacations(4, items)).resolves.toEqual({ created: 1201, skipped: 3 });
    expect(apiPost).toHaveBeenCalledTimes(3);
    for (const [url, body] of apiPost.mock.calls) {
      expect(url).toBe('/api/vacations/import');
      expect(body).toMatchObject({ staff_id: 4 });
    }
    expect(apiPost.mock.calls.map(([, body]) => (body as Body).items.length)).toEqual([500, 500, 201]);
  });

  it('importBankHolidays', async () => {
    answerPerChunk();
    const items = range(1001).map((i) => ({ date: `d${i}`, name: `H${i}` }));
    await expect(importBankHolidays(2, items)).resolves.toEqual({ created: 1001, skipped: 3 });
    expect(apiPost.mock.calls.map(([url]) => url)).toEqual([
      '/api/sites/2/holidays/import',
      '/api/sites/2/holidays/import',
      '/api/sites/2/holidays/import',
    ]);
    expect(apiPost.mock.calls.map(([, body]) => (body as Body).items.length)).toEqual([500, 500, 1]);
  });

  it('importCompanyEvents keeps the shared fields on every chunk and sums linked', async () => {
    answerPerChunk({ linked: 2 });
    const items = range(600).map((i) => ({ date: `d${i}`, name: `E${i}` }));
    const result = await importCompanyEvents({
      site_ids: [1, 3],
      color: '#ff0000',
      counts_as_unavailable: true,
      items,
    });
    expect(result).toEqual({ created: 600, skipped: 2, linked: 4 });
    expect(apiPost).toHaveBeenCalledTimes(2);
    for (const [url, body] of apiPost.mock.calls) {
      expect(url).toBe('/api/events/import');
      expect(body).toMatchObject({ site_ids: [1, 3], color: '#ff0000', counts_as_unavailable: true });
    }
    expect(apiPost.mock.calls.map(([, body]) => (body as Body).items.length)).toEqual([500, 100]);
  });
});
