/**
 * ContextMenuContainer
 * Renders context menus based on uiStore state
 */

import { useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { ContextMenu, type ContextMenuItem } from '@/components/common';
import { deleteProject, deletePhase, deleteSubphase, deleteStaffAssignment, deleteEquipmentAssignment } from '@/api';
import type { Project, Phase, Subphase } from '@/types';

export function ContextMenuContainer() {
  const contextMenu = useUIStore((s) => s.contextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const openProjectModal = useUIStore((s) => s.openProjectModal);
  const openPhaseModal = useUIStore((s) => s.openPhaseModal);
  const openSubphaseModal = useUIStore((s) => s.openSubphaseModal);
  const openModal = useUIStore((s) => s.openModal);
  const setEditingStaffAssignment = useUIStore((s) => s.setEditingStaffAssignment);
  const setEditingEquipmentAssignment = useUIStore((s) => s.setEditingEquipmentAssignment);

  const projects = useAppStore((s) => s.projects);
  const currentUser = useAppStore((s) => s.currentUser);
  const { loadAllData } = useDataLoader();

  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  // Find the target project/phase/subphase
  const findTarget = useCallback(() => {
    if (!contextMenu.targetId || !contextMenu.type) return null;

    if (contextMenu.type === 'project') {
      return projects.find((p) => p.id === contextMenu.targetId);
    }

    if (contextMenu.type === 'phase' && contextMenu.projectId) {
      const project = projects.find((p) => p.id === contextMenu.projectId);
      return project?.phases?.find((ph) => ph.id === contextMenu.targetId);
    }

    if (contextMenu.type === 'subphase' && contextMenu.projectId && contextMenu.phaseId) {
      const project = projects.find((p) => p.id === contextMenu.projectId);
      const phase = project?.phases?.find((ph) => ph.id === contextMenu.phaseId);
      return phase?.children?.find((sp) => sp.id === contextMenu.targetId);
    }

    return null;
  }, [contextMenu, projects]);

  const getMenuItems = useCallback((): ContextMenuItem[] => {
    const { type, targetId, projectId, phaseId } = contextMenu;
    const target = findTarget();

    if (!type || !targetId) return [];

    // Project context menu
    if (type === 'project') {
      const project = target as Project;
      return [
        {
          label: 'Edit Project',
          icon: <EditIcon />,
          onClick: () => {
            if (project) openProjectModal(project);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Phase',
          icon: <AddIcon />,
          onClick: () => {
            openPhaseModal(undefined, targetId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { projectId: targetId });
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { projectId: targetId });
          },
          disabled: !canEdit,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Project',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (confirm(`Delete project "${project?.name}"? This cannot be undone.`)) {
              await deleteProject(targetId);
              loadAllData();
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    // Phase context menu
    if (type === 'phase') {
      const phase = target as Phase;
      return [
        {
          label: 'Edit Phase',
          icon: <EditIcon />,
          onClick: () => {
            if (phase && projectId) openPhaseModal(phase, projectId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Subphase',
          icon: <AddIcon />,
          onClick: () => {
            openSubphaseModal(undefined, targetId, projectId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canEdit,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Phase',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (confirm(`Delete phase "${phase?.name}"? This cannot be undone.`)) {
              await deletePhase(targetId);
              loadAllData();
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    // Subphase context menu
    if (type === 'subphase') {
      const subphase = target as Subphase;
      return [
        {
          label: 'Edit Subphase',
          icon: <EditIcon />,
          onClick: () => {
            if (subphase && phaseId && projectId) openSubphaseModal(subphase, phaseId, projectId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Child Subphase',
          icon: <AddIcon />,
          onClick: () => {
            // Add subphase as child of this subphase
            // phaseId stays the same, but we pass targetId as parentSubphaseId
            openSubphaseModal(undefined, phaseId, projectId, targetId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canEdit,
        },
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canEdit,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Subphase',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (confirm(`Delete subphase "${subphase?.name}"? This cannot be undone.`)) {
              await deleteSubphase(targetId);
              loadAllData();
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    // Staff Assignment context menu
    if (type === 'staffAssignment') {
      const { assignmentData, subphaseId } = contextMenu;
      const assignmentName = assignmentData?.name || 'Staff Assignment';
      // Determine assignment level for API routing
      const assignmentLevel = subphaseId ? 'subphase' : (phaseId ? 'phase' : 'project');
      
      return [
        {
          label: 'Edit Assignment',
          icon: <EditIcon />,
          onClick: () => {
            setEditingStaffAssignment({
              id: targetId,
              project_id: projectId || 0,
              phase_id: phaseId || null,
              subphase_id: subphaseId || null,
              staff_id: assignmentData?.staffId || 0,
              staff_name: assignmentData?.name || '',
              allocation: assignmentData?.allocation || 100,
              start_date: assignmentData?.startDate || '',
              end_date: assignmentData?.endDate || '',
            });
            openModal('staffAssignment', { projectId, phaseId, subphaseId });
          },
          disabled: !canEdit,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Assignment',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (confirm(`Remove ${assignmentName} from this assignment?`)) {
              await deleteStaffAssignment(targetId, assignmentLevel);
              loadAllData();
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    // Equipment Assignment context menu
    if (type === 'equipmentAssignment') {
      const { assignmentData, subphaseId } = contextMenu;
      const assignmentName = assignmentData?.name || 'Equipment Assignment';
      return [
        {
          label: 'Edit Assignment',
          icon: <EditIcon />,
          onClick: () => {
            setEditingEquipmentAssignment({
              id: targetId,
              project_id: projectId || 0,
              phase_id: phaseId || null,
              subphase_id: subphaseId || null,
              equipment_id: assignmentData?.equipmentId || 0,
              equipment_name: assignmentData?.name || '',
              start_date: assignmentData?.startDate || '',
              end_date: assignmentData?.endDate || '',
            });
            openModal('equipmentAssignment', { projectId, phaseId, subphaseId });
          },
          disabled: !canEdit,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Assignment',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (confirm(`Remove ${assignmentName} from this assignment?`)) {
              // Equipment assignments use a single endpoint for all levels
              await deleteEquipmentAssignment(targetId);
              loadAllData();
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    return [];
  }, [contextMenu, findTarget, canEdit, openProjectModal, openPhaseModal, openSubphaseModal, openModal, setEditingStaffAssignment, setEditingEquipmentAssignment, loadAllData]);

  if (!contextMenu.visible) return null;

  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      items={getMenuItems()}
      onClose={hideContextMenu}
    />
  );
}

// Simple icons
const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const AddIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const DeleteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);

const PersonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const EquipmentIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
    <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
  </svg>
);
