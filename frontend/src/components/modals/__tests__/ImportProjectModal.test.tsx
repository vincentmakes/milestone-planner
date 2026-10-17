/**
 * MS Project / CSV import dialog: file type check, drag-and-drop, the upload
 * (raw fetch, tenant-prefixed), the success summary, the Java/MPXJ setup
 * help, server errors, and the What-If block (the raw fetch would bypass the
 * sandbox queue).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ImportProjectModal } from '../ImportProjectModal';
import { resetAllStores, useAppStore, useUIStore, useWhatIfStore } from '@/stores';
import { loadAllProjects } from '@/api/endpoints/projects';
import { makeProject, makeSite } from '@/test/factories';

vi.mock('@/api/endpoints/projects', () => ({
  loadAllProjects: vi.fn(),
}));

const fetchMock = vi.fn();

function respond(status: number, body: string) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(body),
  });
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const importButton = () => screen.getByRole('button', { name: /Import Project|Importing/ });

function choose(name: string, content = 'x'.repeat(2048)) {
  const file = new File([content], name);
  fireEvent.change(fileInput(), { target: { files: [file] } });
  return file;
}

function open() {
  act(() => useUIStore.setState({ activeModal: 'importProject' }));
  return render(<ImportProjectModal />);
}

beforeEach(() => {
  resetAllStores();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(loadAllProjects).mockReset().mockResolvedValue([makeProject({ id: 42, name: 'Imported' })]);
  useAppStore.setState({ currentSite: makeSite({ id: 3 }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('ImportProjectModal file selection', () => {
  it('starts with an empty drop zone and a disabled import button', () => {
    open();
    expect(screen.getByText('Drop file here or click to browse')).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it('rejects unsupported file types', () => {
    open();
    choose('plan.docx');
    expect(screen.getByText('Please select an MPP, CSV, or XML file')).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it('shows the chosen file and lets the user pick another', () => {
    open();
    choose('Plan.MPP');
    expect(screen.getByText('Plan.MPP')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(importButton()).not.toBeDisabled();

    fireEvent.click(screen.getByText('Choose different file'));
    expect(screen.getByText('Drop file here or click to browse')).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it('accepts a dropped CSV and highlights the zone while dragging', () => {
    open();
    const zone = screen.getByText('Drop file here or click to browse').closest('[class*="dropZone"]') as HTMLElement;
    fireEvent.dragOver(zone);
    expect(zone.className).toMatch(/dragging/);
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toMatch(/dragging/);

    fireEvent.drop(zone, { dataTransfer: { files: [new File(['a,b'], 'tasks.csv')] } });
    expect(screen.getByText('tasks.csv')).toBeInTheDocument();
    expect(zone.className).toMatch(/hasFile/);
  });

  it('opens the native picker when the zone is clicked', () => {
    open();
    const click = vi.spyOn(fileInput(), 'click');
    fireEvent.click(screen.getByText('Drop file here or click to browse'));
    expect(click).toHaveBeenCalled();
  });
});

describe('ImportProjectModal upload', () => {
  it('posts the file with the site id, reloads projects and shows the summary', async () => {
    respond(200, JSON.stringify({ success: true, project_name: 'Plan X', phases_created: 3, subphases_created: 1 }));
    open();
    const file = choose('plan.xml');
    fireEvent.click(importButton());

    expect(await screen.findByText('Import Complete!')).toBeInTheDocument();
    expect(screen.getByText('Plan X')).toBeInTheDocument();
    expect(screen.getByText('3 phases, 1 subphase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import Project' })).not.toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/import/project');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((init.body as FormData).get('file')).toBe(file);
    expect((init.body as FormData).get('site_id')).toBe('3');
    expect(useAppStore.getState().projects.map((p) => p.id)).toEqual([42]);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('prefixes the tenant path and uses the singular for one phase', async () => {
    window.history.pushState({}, '', '/t/demo-co/');
    respond(200, JSON.stringify({ success: true, project_name: 'Tiny', phases_created: 1 }));
    open();
    choose('tiny.csv');
    fireEvent.click(importButton());
    expect(await screen.findByText('1 phase')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/t/demo-co/api/import/project');
  });

  it('shows Java setup instructions when the parser is missing', async () => {
    respond(500, JSON.stringify({ success: false, error: 'JVM not found: libjvm.so' }));
    open();
    choose('plan.mpp');
    fireEvent.click(importButton());

    expect(await screen.findByText('Java Required for MPP Import')).toBeInTheDocument();
    expect(screen.getByText('JVM not found: libjvm.so')).toBeInTheDocument();
    expect(screen.getByText('Setup Instructions')).toBeInTheDocument();
    expect(screen.getByText(/pip install mpxj/)).toBeInTheDocument();
    // the user may retry (e.g. with a CSV)
    expect(screen.getByRole('button', { name: 'Import Project' })).toBeInTheDocument();
    expect(loadAllProjects).not.toHaveBeenCalled();
  });

  it('uses the server-provided setup instructions for an MPXJ package error', async () => {
    respond(
      200,
      JSON.stringify({ success: false, error: 'package mpxj not found', setup_instructions: 'Run the installer' })
    );
    open();
    choose('plan.mpp');
    fireEvent.click(importButton());
    expect(await screen.findByText('Run the installer')).toBeInTheDocument();
  });

  it('reports a plain server error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(400, JSON.stringify({ success: false, error: 'No tasks in file' }));
    open();
    choose('empty.csv');
    fireEvent.click(importButton());
    expect(await screen.findByText('No tasks in file')).toBeInTheDocument();
    expect(screen.queryByText('Java Required for MPP Import')).not.toBeInTheDocument();
    err.mockRestore();
  });

  it('reports non-JSON and empty responses', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: () => Promise.resolve('<html>proxy</html>'),
    });
    open();
    choose('plan.csv');
    fireEvent.click(importButton());
    expect(
      await screen.findByText('Server error: 502 Bad Gateway. Check server logs.')
    ).toBeInTheDocument();

    respond(200, '');
    fireEvent.click(importButton());
    expect(await screen.findByText('Empty response from server')).toBeInTheDocument();
    err.mockRestore();
  });

  it('does not upload while What-If mode is active', async () => {
    useWhatIfStore.setState({ whatIfMode: true });
    open();
    choose('plan.csv');
    fireEvent.click(importButton());
    expect(screen.getByText(/Importing is unavailable while What-If mode is active/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it('resets its state when cancelled', () => {
    const { rerender } = open();
    choose('plan.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUIStore.getState().activeModal).toBeNull();

    act(() => useUIStore.setState({ activeModal: 'importProject' }));
    rerender(<ImportProjectModal />);
    expect(screen.getByText('Drop file here or click to browse')).toBeInTheDocument();
  });


  it('uploads once when Import is clicked twice before the upload settles', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    open();
    choose('plan.xml');
    act(() => {
      fireEvent.click(importButton());
      fireEvent.click(importButton());
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(importButton()).toHaveAttribute('aria-busy', 'true');
  });
});
