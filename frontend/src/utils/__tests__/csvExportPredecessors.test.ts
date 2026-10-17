/**
 * CSV predecessor column: dependency entries naming their `entity` must map to
 * that kind's row. Phase and subphase ids come from separate sequences, so a
 * phase and a subphase can share an id.
 */
import { describe, it, expect } from 'vitest';
import { exportProjectsToCSV } from '../csvExport';
import type { Dependency, Project } from '@/types';

function project(buildDeps: Dependency[]): Project {
  return {
    id: 1,
    name: 'P',
    start_date: '2026-01-05',
    end_date: '2026-03-27',
    confirmed: true,
    phases: [
      {
        id: 1,
        name: 'Design',
        start_date: '2026-01-05',
        end_date: '2026-01-30',
        children: [
          // Same id as the "Design" phase on purpose.
          { id: 1, name: 'Spec', start_date: '2026-01-05', end_date: '2026-01-16', parent_subphase_id: null },
        ],
      },
      {
        id: 2,
        name: 'Build',
        start_date: '2026-02-02',
        end_date: '2026-03-27',
        dependencies: buildDeps,
      },
    ],
  } as unknown as Project;
}

/** Split one CSV line into unquoted cells (RFC 4180: quoted cells, "" escapes). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** Cells of the row whose Name cell is `name`. */
function rowOf(csv: string, name: string): string[] {
  const row = csv.split('\n').map(parseCsvLine).find(cells => cells[1] === name);
  if (!row) throw new Error(`row ${name} not found`);
  return row;
}

/** Predecessors cell of the row whose Name cell is `name`. */
function predecessorsOf(csv: string, name: string): string {
  return rowOf(csv, name)[6];
}

describe('exportProjectsToCSV predecessors', () => {
  // Rows: 1 = project, 2 = Design (phase 1), 3 = Spec (subphase 1), 4 = Build.
  it('maps an entity: subphase link to the subphase row even when a phase shares its id', () => {
    const csv = exportProjectsToCSV([project([{ id: 1, type: 'FS', entity: 'subphase' }])]);
    expect(predecessorsOf(csv, 'Build')).toBe('3FS');
  });

  it('maps an entity: phase link to the phase row', () => {
    const csv = exportProjectsToCSV([project([{ id: 1, type: 'SS', lag: 2, entity: 'phase' }])]);
    expect(predecessorsOf(csv, 'Build')).toBe('2SS+2d');
  });

  it('quotes a cell with several predecessors so later columns stay in place', () => {
    const csv = exportProjectsToCSV([
      project([
        { id: 1, type: 'FS', entity: 'phase' },
        { id: 1, type: 'SS', lag: 2, entity: 'subphase' },
      ]),
    ]);
    const buildLine = csv.split('\n').find(l => l.startsWith('4,'))!;
    expect(buildLine).toContain('"2FS,3SS+2d"');
    const cells = rowOf(csv, 'Build');
    expect(cells).toHaveLength(10);
    expect(cells[6]).toBe('2FS,3SS+2d');
    expect(cells[7]).toBe('0'); // % Complete stays in its own column
  });

  it('resolves legacy entries without entity phase-first', () => {
    const csv = exportProjectsToCSV([project([{ id: 1, type: 'FS' }])]);
    expect(predecessorsOf(csv, 'Build')).toBe('2FS');
  });
});
