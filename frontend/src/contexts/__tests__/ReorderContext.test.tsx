/**
 * Row reordering in the project tree: drag state, before/after drop position,
 * the optimistic local reorder, the per-type reorder endpoint, the server
 * reload, and the persist-failure protocol (reload + clear undo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReorderProvider, useReorder, type ReorderItemType } from '../ReorderContext';
import { apiPut } from '@/api/client';
import { loadAllProjects } from '@/api/endpoints/projects';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { resetAllStores } from '@/stores';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';

vi.mock('@/api/client', () => ({ apiPut: vi.fn() }));
vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));

interface RowSpec {
  type: ReorderItemType;
  id: number;
  parentId?: number;
  parentType?: 'phase' | 'subphase';
}

function Rows({ rows }: { rows: RowSpec[] }) {
  const r = useReorder();
  return (
    <div data-testid="rows">
      {rows.map((row) => {
        const siblings = rows.filter((x) => x.type === row.type && x.parentId === row.parentId);
        return (
          <div
            key={`${row.type}-${row.id}`}
            data-testid={`${row.type}-${row.id}`}
            draggable
            onDragStart={(e) => r.handleDragStart(e, row.type, row.id, 1, row.parentId, row.parentType)}
            onDragOver={(e) => r.handleDragOver(e, row.type, row.id)}
            onDragLeave={r.handleDragLeave}
            onDrop={(e) => r.handleDrop(e, row.type, row.id, siblings, row.parentId, row.parentType)}
            onDragEnd={r.handleDragEnd}
          >
            {row.type}-{row.id}:{r.isDragging(row.type, row.id) ? 'dragging' : ''}:
            {r.getDropPosition(row.type, row.id) ?? ''}
            <span data-testid={`child-${row.type}-${row.id}`} />
          </div>
        );
      })}
    </div>
  );
}

const phaseRows: RowSpec[] = [
  { type: 'phase', id: 10 },
  { type: 'phase', id: 11 },
  { type: 'phase', id: 12 },
];
const subRows: RowSpec[] = [
  { type: 'subphase', id: 20, parentId: 10, parentType: 'phase' },
  { type: 'subphase', id: 21, parentId: 10, parentType: 'phase' },
];

function dt() {
  return { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' };
}

// The drag image is a clone of the row (same test id) appended to <body>, so
// rows are looked up inside the rendered list only.
const row = (key: string) => within(screen.getByTestId('rows')).getByTestId(key);

/**
 * jsdom has no DragEvent, so testing-library builds a plain Event and drops
 * mouse fields (`clientY`, `relatedTarget`) from the init dict; set them on
 * the event itself.
 */
function fireDrag(
  type: 'dragOver' | 'dragLeave',
  el: HTMLElement,
  props: Record<string, unknown>,
  transfer?: ReturnType<typeof dt>
) {
  const event = createEvent[type](el, transfer ? { dataTransfer: transfer } : {});
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  fireEvent(el, event);
}

/** Rows measure 0×0 at y=0 in jsdom: a negative clientY is the upper half ("before"). */
function dragOverAt(el: HTMLElement, transfer: ReturnType<typeof dt>, clientY: number) {
  fireDrag('dragOver', el, { clientY }, transfer);
}
const phaseOrder = () => useAppStore.getState().projects[0].phases.map((p) => p.id);

function seed() {
  useAppStore.setState({
    projects: [
      makeProject({
        id: 1,
        phases: [
          makePhase({ id: 10, children: [makeSubphase({ id: 20 }), makeSubphase({ id: 21 })] }),
          makePhase({ id: 11 }),
          makePhase({ id: 12 }),
        ],
      }),
    ],
  });
}

beforeEach(() => {
  resetAllStores();
  seed();
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
  vi.mocked(loadAllProjects).mockReset().mockImplementation(async () => useAppStore.getState().projects);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReorderProvider', () => {
  it('shows the dragged row and a before/after drop marker; dragleave clears it', () => {
    render(
      <ReorderProvider>
        <Rows rows={phaseRows} />
      </ReorderProvider>
    );
    const transfer = dt();
    fireEvent.dragStart(row('phase-12'), { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', JSON.stringify({ type: 'phase', id: 12 }));
    expect(transfer.setDragImage).toHaveBeenCalled();
    expect(row('phase-12').textContent).toContain(':dragging:');

    // Hovering the dragged row itself or another type is ignored.
    dragOverAt(row('phase-12'), transfer, -5);
    expect(row('phase-12').textContent).not.toMatch(/before|after/);

    dragOverAt(row('phase-10'), transfer, -5);
    expect(row('phase-10').textContent).toContain('before');
    dragOverAt(row('phase-10'), transfer, 5);
    expect(row('phase-10').textContent).toContain('after');

    fireDrag('dragLeave', row('phase-10'), { relatedTarget: row('child-phase-10') });
    expect(row('phase-10').textContent).toContain('after');
    fireDrag('dragLeave', row('phase-10'), { relatedTarget: document.body });
    expect(row('phase-10').textContent).not.toContain('after');

    fireEvent.dragEnd(row('phase-12'));
    expect(row('phase-12').textContent).not.toContain('dragging');
    const ghost = (transfer.setDragImage.mock.calls[0] as unknown[])[0] as HTMLElement;
    expect(document.body.contains(ghost)).toBe(false);
  });

  it('reorders phases optimistically, persists the order and reloads', async () => {
    render(
      <ReorderProvider>
        <Rows rows={phaseRows} />
      </ReorderProvider>
    );
    const transfer = dt();
    fireEvent.dragStart(row('phase-12'), { dataTransfer: transfer });
    dragOverAt(row('phase-10'), transfer, -5);
    fireEvent.drop(row('phase-10'), { dataTransfer: transfer });

    expect(phaseOrder()).toEqual([12, 10, 11]);
    await waitFor(() => expect(loadAllProjects).toHaveBeenCalled());
    expect(apiPut).toHaveBeenCalledWith('/api/projects/1/phases/reorder', { phase_order: [12, 10, 11] });
  });

  it('reorders subphases through the parent reorder endpoint', async () => {
    render(
      <ReorderProvider>
        <Rows rows={subRows} />
      </ReorderProvider>
    );
    const transfer = dt();
    fireEvent.dragStart(row('subphase-20'), { dataTransfer: transfer });
    dragOverAt(row('subphase-21'), transfer, 5);
    fireEvent.drop(row('subphase-21'), { dataTransfer: transfer });

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/subphases/10/reorder', {
        parent_type: 'phase',
        subphase_order: [21, 20],
      })
    );
    expect(useAppStore.getState().projects[0].phases[0].children.map((s) => s.id)).toEqual([21, 20]);
  });

  it('ignores a drop without a drop target', () => {
    render(
      <ReorderProvider>
        <Rows rows={phaseRows} />
      </ReorderProvider>
    );
    fireEvent.drop(row('phase-10'));
    fireEvent.dragStart(row('phase-12'), { dataTransfer: dt() });
    fireEvent.drop(row('phase-10'));
    expect(apiPut).not.toHaveBeenCalled();
    expect(phaseOrder()).toEqual([10, 11, 12]);
  });

  it('reloads and clears undo when the reorder fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(apiPut).mockRejectedValue(new Error('403'));
    const server = [makeProject({ id: 1, phases: [makePhase({ id: 10 })] })];
    vi.mocked(loadAllProjects).mockResolvedValue(server);
    useUndoStore.getState().saveState([], 'earlier');

    render(
      <ReorderProvider>
        <Rows rows={phaseRows} />
      </ReorderProvider>
    );
    const transfer = dt();
    fireEvent.dragStart(row('phase-11'), { dataTransfer: transfer });
    dragOverAt(row('phase-12'), transfer, 5);
    fireEvent.drop(row('phase-12'), { dataTransfer: transfer });

    await waitFor(() => expect(useAppStore.getState().projects).toBe(server));
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(error).toHaveBeenCalledWith('[Reorder] persist failed, reloading from the server:', expect.any(Error));
  });

  // Last: a render that throws leaves React's root in a state RTL's cleanup
  // does not fully undo.
  it('throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const silence = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', silence);
    expect(() => render(<Rows rows={phaseRows} />)).toThrow('useReorder must be used within ReorderProvider');
    window.removeEventListener('error', silence);
  });
});
