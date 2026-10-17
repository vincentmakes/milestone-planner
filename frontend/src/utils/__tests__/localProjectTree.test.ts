import { describe, it, expect, beforeEach } from 'vitest';
import {
  patchEquipmentAssignmentLocally,
  patchPhaseLocally,
  patchStaffAssignmentLocally,
  patchSubphaseLocally,
  removeEquipmentAssignmentLocally,
  removePhaseLocally,
  removeProjectLocally,
  removeStaffAssignmentLocally,
  removeSubphaseLocally,
  updateProjectLocally,
} from '../localProjectTree';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import type { EquipmentAssignment, Project, StaffAssignment } from '@/types';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';

function staff(id: number, overrides: Partial<StaffAssignment> = {}): StaffAssignment {
  return {
    id,
    staff_id: 4,
    allocation: 50,
    start_date: '2026-01-05',
    end_date: '2026-01-30',
    ...overrides,
  };
}
function equip(id: number): EquipmentAssignment {
  return { id, equipment_id: 1, start_date: '2026-01-05', end_date: '2026-01-30' };
}

function tree(): Project {
  const nested = makeSubphase({
    id: 12,
    name: 'Nested',
    staffAssignments: [staff(1)],
    equipmentAssignments: [equip(30)],
  });
  const sub = makeSubphase({ id: 11, name: 'Sub', children: [nested] });
  const phase = makePhase({
    id: 10,
    name: 'Phase A',
    children: [sub],
    staffAssignments: [staff(1, { allocation: 20 })],
    equipmentAssignments: [equip(20)],
  });
  return makeProject({
    id: 1,
    phases: [phase, makePhase({ id: 13, name: 'Phase B' })],
    staffAssignments: [staff(1, { allocation: 80 })],
    equipmentAssignments: [equip(10)],
  });
}

const project = () => useAppStore.getState().projects.find((p) => p.id === 1)!;
const nested = () => project().phases[0].children[0].children[0];

describe('localProjectTree', () => {
  beforeEach(() => {
    resetAllStores();
    useAppStore.setState({ projects: [tree(), makeProject({ id: 2, name: 'Other' })] });
  });

  it('replaces the project with a mutated clone, leaving the original object untouched', () => {
    const before = project();
    updateProjectLocally(1, (p) => {
      p.name = 'Renamed';
    });
    expect(project().name).toBe('Renamed');
    expect(project()).not.toBe(before);
    expect(before.name).toBe('Bioprocess Scale-Up');
    expect(useAppStore.getState().projects[1].name).toBe('Other');
  });

  it('is a no-op for an unknown project', () => {
    const before = useAppStore.getState().projects;
    updateProjectLocally(99, (p) => {
      p.name = 'x';
    });
    removeProjectLocally(99);
    expect(useAppStore.getState().projects).toBe(before);
  });

  it('removes a project', () => {
    removeProjectLocally(2);
    expect(useAppStore.getState().projects.map((p) => p.id)).toEqual([1]);
  });

  it('patches and removes phases', () => {
    patchPhaseLocally(1, 10, { name: 'Phase A2', completion: 40 });
    expect(project().phases[0]).toMatchObject({ name: 'Phase A2', completion: 40 });
    patchPhaseLocally(1, 999, { name: 'ignored' });
    expect(project().phases.map((p) => p.name)).toEqual(['Phase A2', 'Phase B']);
    removePhaseLocally(1, 13);
    expect(project().phases.map((p) => p.id)).toEqual([10]);
  });

  it('patches a subphase at any depth', () => {
    patchSubphaseLocally(1, 12, { name: 'Deep edit' });
    expect(nested().name).toBe('Deep edit');
  });

  it('removes a nested subphase and keeps its siblings', () => {
    removeSubphaseLocally(1, 12);
    expect(project().phases[0].children.map((s) => s.id)).toEqual([11]);
    expect(project().phases[0].children[0].children).toEqual([]);
  });

  it('patches a staff assignment only at the requested level (ids are per level)', () => {
    patchStaffAssignmentLocally(1, 1, 'phase', { allocation: 25 });
    expect(project().staffAssignments[0].allocation).toBe(80);
    expect(project().phases[0].staffAssignments[0].allocation).toBe(25);
    expect(nested().staffAssignments[0].allocation).toBe(50);

    patchStaffAssignmentLocally(1, 1, 'project', { allocation: 100 });
    patchStaffAssignmentLocally(1, 1, 'subphase', { allocation: 10 });
    expect(project().staffAssignments[0].allocation).toBe(100);
    expect(nested().staffAssignments[0].allocation).toBe(10);
  });

  it('removes a staff assignment only at the requested level', () => {
    removeStaffAssignmentLocally(1, 1, 'subphase');
    expect(nested().staffAssignments).toEqual([]);
    expect(project().staffAssignments).toHaveLength(1);
    expect(project().phases[0].staffAssignments).toHaveLength(1);
    removeStaffAssignmentLocally(1, 1, 'project');
    expect(project().staffAssignments).toEqual([]);
  });

  it('patches and removes equipment bookings anywhere in the tree', () => {
    patchEquipmentAssignmentLocally(1, 30, { end_date: '2026-02-15' });
    expect(nested().equipmentAssignments[0].end_date).toBe('2026-02-15');
    removeEquipmentAssignmentLocally(1, 20);
    expect(project().phases[0].equipmentAssignments).toEqual([]);
    removeEquipmentAssignmentLocally(1, 10);
    expect(project().equipmentAssignments).toEqual([]);
    expect(nested().equipmentAssignments).toHaveLength(1);
  });
});
