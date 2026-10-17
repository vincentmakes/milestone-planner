/**
 * Every "reload after a write" path goes through loadAllProjects(); in What-If
 * mode it must keep the sandbox instead of replacing it with server state
 * (F1-3). fetchAllProjects() is the explicit, unguarded server fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAllProjects, fetchAllProjects } from '../projects';
import { configureApiClient } from '@/api/client';
import { useAppStore } from '@/stores/appStore';
import type { Project } from '@/types';

const SANDBOX: Project = {
  id: 1,
  name: 'Sandbox',
  site_id: 1,
  confirmed: true,
  archived: false,
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('loadAllProjects What-If guard', () => {
  let whatIf = false;
  const fetchMock = vi.fn();

  beforeEach(() => {
    whatIf = false;
    configureApiClient({ isWhatIfMode: () => whatIf });
    useAppStore.getState().setProjects([SANDBOX]);
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url.includes('/api/projects?archived=all')) return jsonResponse({ items: [{ id: 2 }], total: 1, offset: 0, limit: 200 });
      return jsonResponse({ id: 2, name: 'Server', site_id: 1, phases: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    configureApiClient({ isWhatIfMode: () => false });
  });

  it('returns the local sandbox and does not hit the server while What-If is active', async () => {
    whatIf = true;
    const result = await loadAllProjects();
    expect(result).toBe(useAppStore.getState().projects);
    expect(result[0].name).toBe('Sandbox');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('fetches from the server outside What-If', async () => {
    const result = await loadAllProjects();
    expect(fetchMock).toHaveBeenCalled();
    expect(result.map((p) => p.name)).toEqual(['Server']);
  });

  it('fetchAllProjects always fetches, even during What-If', async () => {
    whatIf = true;
    const result = await fetchAllProjects();
    expect(fetchMock).toHaveBeenCalled();
    expect(result.map((p) => p.name)).toEqual(['Server']);
  });
});
