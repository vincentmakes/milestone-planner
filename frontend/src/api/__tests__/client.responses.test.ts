/**
 * API client: URL building (tenant prefix), request shape, response parsing
 * (204, empty body, non-JSON, FastAPI 422 flattening, error/detail messages),
 * the convenience helpers and downloadFile. What-If and 401 handling are in
 * client.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiRequest,
  configureApiClient,
  downloadFile,
  getTenantPrefix,
  isWhatIfActive,
} from '../client';

const fetchMock = vi.fn();

function respondText(status: number, text: string, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValue(new Response(text, { status, headers }));
}
function respond(status: number, body: unknown) {
  respondText(status, JSON.stringify(body));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
  configureApiClient({ isWhatIfMode: () => false, onUnauthorized: undefined });
});

describe('getTenantPrefix', () => {
  it('extracts /t/{slug} from the current path', () => {
    window.history.pushState({}, '', '/t/acme-labs/gantt');
    expect(getTenantPrefix()).toBe('/t/acme-labs');
  });

  it('is empty outside a tenant path or for an invalid slug', () => {
    expect(getTenantPrefix()).toBe('');
    window.history.pushState({}, '', '/t/-bad/x');
    expect(getTenantPrefix()).toBe('');
  });
});

describe('apiRequest', () => {
  it('prefixes /api/ routes with the tenant and sends cookies + JSON', async () => {
    window.history.pushState({}, '', '/t/demo/');
    respond(200, { ok: 1 });
    await expect(apiRequest('api/projects', { method: 'POST', body: { a: 1 } })).resolves.toEqual({
      ok: 1,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/t/demo/api/projects');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('does not prefix non-API paths', async () => {
    window.history.pushState({}, '', '/t/demo/');
    respond(200, {});
    await apiRequest('/health');
    expect(fetchMock.mock.calls[0][0]).toBe('/health');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('returns {} for 204 and for an empty 2xx body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiDelete('/api/x/1')).resolves.toEqual({});
    respondText(200, '   ');
    await expect(apiGet('/api/x')).resolves.toEqual({});
  });

  it('rejects an empty error body with the status', async () => {
    respondText(500, '');
    await expect(apiGet('/api/x')).rejects.toThrow('HTTP 500: Empty response');
  });

  it('rejects a non-JSON body (proxy HTML page)', async () => {
    respondText(502, '<html>Bad gateway</html>');
    await expect(apiGet('/api/x')).rejects.toThrow('HTTP 502: Invalid response');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Non-JSON response from /api/x'),
      '<html>Bad gateway</html>'
    );
  });

  it('flattens FastAPI 422 validation errors to "field: message"', async () => {
    respond(422, {
      detail: [
        { loc: ['body', 'name'], msg: 'field required' },
        { loc: [], msg: 'bad' },
        {},
      ],
    });
    await expect(apiPost('/api/x', {})).rejects.toThrow(
      'name: field required, field: bad, field: invalid'
    );
  });

  it('prefers error, then detail, then the status for other failures', async () => {
    respond(400, { error: 'Name taken', detail: 'ignored' });
    await expect(apiPut('/api/x', {})).rejects.toThrow('Name taken');
    respond(404, { detail: 'Not found' });
    await expect(apiPatch('/api/x', {})).rejects.toThrow('Not found');
    respond(409, { other: true });
    await expect(apiGet('/api/x')).rejects.toThrow('HTTP 409');
  });

  it('wraps a non-Error rejection from fetch', async () => {
    fetchMock.mockRejectedValue('offline');
    await expect(apiGet('/api/x')).rejects.toThrow('An unexpected error occurred');
  });

  it('sends each helper with its method', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await apiGet('/api/a');
    await apiPost('/api/a', { b: 1 });
    await apiPut('/api/a', { b: 2 });
    await apiPatch('/api/a', { b: 3 });
    await apiDelete('/api/a');
    expect(fetchMock.mock.calls.map((c) => [c[1].method, c[1].body])).toEqual([
      ['GET', undefined],
      ['POST', '{"b":1}'],
      ['PUT', '{"b":2}'],
      ['PATCH', '{"b":3}'],
      ['DELETE', undefined],
    ]);
  });

  it('isWhatIfActive reflects the configured callback', () => {
    expect(isWhatIfActive()).toBe(false);
    configureApiClient({ isWhatIfMode: () => true });
    expect(isWhatIfActive()).toBe(true);
  });
});

describe('downloadFile', () => {
  let click: ReturnType<typeof vi.spyOn>;
  const createObjectURL = vi.fn(() => 'blob:file');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  const clickedLink = () => click.mock.instances[0] as unknown as HTMLAnchorElement;

  it('saves the blob under the Content-Disposition filename', async () => {
    window.history.pushState({}, '', '/t/demo/');
    respondText(200, 'xlsx-bytes', {
      'Content-Disposition': "attachment; filename*=UTF-8''Basel%20export.xlsx",
    });
    await downloadFile('/api/export/site/1/excel', 'fallback.xlsx');
    expect(fetchMock).toHaveBeenCalledWith('/t/demo/api/export/site/1/excel', {
      method: 'GET',
      credentials: 'include',
    });
    expect(clickedLink().download).toBe('Basel export.xlsx');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file');
  });

  it('uses the fallback name without a Content-Disposition header', async () => {
    respondText(200, 'csv');
    await downloadFile('api/export/csv/1', 'project.csv');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/export/csv/1');
    expect(clickedLink().download).toBe('project.csv');
  });

  it('throws the JSON detail on failure and reports a 401 session expiry', async () => {
    const onUnauthorized = vi.fn();
    configureApiClient({ onUnauthorized });
    respond(401, { detail: 'Not authenticated' });
    await expect(downloadFile('/api/export/csv/1', 'x.csv')).rejects.toThrow('Not authenticated');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it('falls back to the status when the error body is not JSON', async () => {
    respondText(500, 'boom');
    await expect(downloadFile('/api/x', 'x')).rejects.toThrow('HTTP 500');
  });
});
