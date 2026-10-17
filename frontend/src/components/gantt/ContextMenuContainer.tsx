/**
 * ContextMenuContainer
 * Renders context menus based on uiStore state
 */

import { useCallback, useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { ContextMenu, type ContextMenuItem } from '@/components/common';
import { deleteProject, deletePhase, deleteSubphase, deleteStaffAssignment, deleteEquipmentAssignment, createStaffAssignment } from '@/api';
import { isPrivileged, canEditProject, canEditAssignment } from '@/utils/permissions';
import { findSubphaseById } from '@/utils/subphaseUtils';
import { formatDateISO } from '@/utils/date';
import {
  removeEquipmentAssignmentLocally,
  removePhaseLocally,
  removeProjectLocally,
  removeStaffAssignmentLocally,
  removeSubphaseLocally,
} from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import type { Project, Phase, Subphase } from '@/types';
import { confirmAction } from '@/utils/confirmDialog';

/**
 * Run a delete from the context menu. A failed delete must not be an
 * unhandled rejection: follow the persist-failure protocol (reload the
 * projects, clear the undo history) and tell the user.
 */
async function runDelete(what: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    await recoverFromPersistFailure(`Delete ${what}`, err);
    useUIStore
      .getState()
      .showFlash(`Failed to delete ${what}: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

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
  const staff = useAppStore((s) => s.staff);
  const currentUser = useAppStore((s) => s.currentUser);
  // Items that CREATE something are disabled in What-If mode: the new object
  // would only appear after Apply. Edits and deletes stay available.
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const createBlockedReason = whatIfMode ? whatIfUnavailableMessage('Adding items') : undefined;
  // Deletes only change projects. A full loadAllData() would also re-resolve
  // the current site, and switch away from the one the user is looking at.
  const { refreshProjects } = useDataLoader();

  // The project the menu was opened on. For a project menu it is the target
  // itself; everything below a project carries contextMenu.projectId.
  const menuProject = useMemo(() => {
    const id = contextMenu.type === 'project' ? contextMenu.targetId : contextMenu.projectId;
    return projects.find((p) => p.id === id);
  }, [projects, contextMenu.type, contextMenu.targetId, contextMenu.projectId]);

  // Per-project rights: admins, superusers and the project's manager.
  const canEdit = canEditProject(currentUser, menuProject);
  // Deleting a project stays with admins and superusers, even for its manager.
  const canDeleteProject = isPrivileged(currentUser);

  // "Assign me" books the current user's own time at their max capacity, the
  // same default the assignment modal and resource drag use.
  const ownDefaultAllocation = useMemo(() => {
    if (!currentUser) return 100;
    const row = staff.find((s) => s.id === currentUser.id);
    return row?.max_capacity ?? currentUser.max_capacity ?? 100;
  }, [staff, currentUser]);

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
      // Nested subphase rows carry their top-level phase's id, so the target
      // can sit at any depth below it: search the whole subtree.
      return phase ? findSubphaseById([phase], contextMenu.targetId) ?? undefined : undefined;
    }

    return null;
  }, [contextMenu, projects]);

  const getMenuItems = useCallback((): ContextMenuItem[] => {
    const { type, targetId, projectId, phaseId } = contextMenu;
    const target = findTarget();

    if (!type || !targetId) return [];

    // "Assign me" for people who cannot manage the project: a self-assignment
    // on the project, phase or subphase the menu was opened on. Hidden for
    // editors (they have the full "Assign Staff" dialog) and once assigned.
    const assignMeItem = (): ContextMenuItem[] => {
      if (canEdit || !currentUser) return [];
      const item = target as Project | Phase | Subphase | undefined;
      const alreadyAssigned = (item?.staffAssignments ?? []).some(
        (a) => a.staff_id === currentUser.id
      );
      return [
        {
          label: alreadyAssigned ? 'Assigned to me' : 'Assign me',
          icon: <PersonIcon />,
          onClick: async () => {
            if (!item) return;
            // A project may have no dates yet; the assignment still needs some.
            const today = formatDateISO(new Date());
            try {
              await createStaffAssignment({
                staff_id: currentUser.id,
                allocation: ownDefaultAllocation,
                start_date: item.start_date || today,
                end_date: item.end_date || today,
                project_id: type === 'project' ? targetId : projectId,
                phase_id: type === 'phase' ? targetId : undefined,
                subphase_id: type === 'subphase' ? targetId : undefined,
              });
              refreshProjects();
            } catch (err) {
              console.error('Failed to self-assign:', err);
            }
          },
          disabled: alreadyAssigned || !item || whatIfMode,
          title: alreadyAssigned ? undefined : createBlockedReason,
        },
      ];
    };

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
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { projectId: targetId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { projectId: targetId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Project',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (
              await confirmAction({
                title: 'Delete project',
                message: `Delete project "${project?.name}"? This cannot be undone.`,
                destructive: true,
              })
            ) {
              await runDelete('project', async () => {
                await deleteProject(targetId);
                // Mirror locally: the refresh is a no-op in What-If mode.
                removeProjectLocally(targetId);
                refreshProjects();
              });
            }
          },
          disabled: !canDeleteProject,
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
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Phase',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (
              await confirmAction({
                title: 'Delete phase',
                message: `Delete phase "${phase?.name}"? This cannot be undone.`,
                destructive: true,
              })
            ) {
              await runDelete('phase', async () => {
                await deletePhase(targetId);
                if (projectId) removePhaseLocally(projectId, targetId);
                refreshProjects();
              });
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
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        {
          label: 'Assign Staff',
          icon: <PersonIcon />,
          onClick: () => {
            openModal('staffAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <EquipmentIcon />,
          onClick: () => {
            openModal('equipmentAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Subphase',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (
              await confirmAction({
                title: 'Delete subphase',
                message: `Delete subphase "${subphase?.name}"? This cannot be undone.`,
                destructive: true,
              })
            ) {
              await runDelete('subphase', async () => {
                await deleteSubphase(targetId);
                if (projectId) removeSubphaseLocally(projectId, targetId);
                refreshProjects();
              });
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
      // Project editors may change anyone's booking; everyone may change their own.
      const canEditThis = canEditAssignment(currentUser, menuProject, assignmentData?.staffId);

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
          disabled: !canEditThis,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Assignment',
          icon: <DeleteIcon />,
          danger: true,
          onClick: async () => {
            if (
              await confirmAction({
                title: 'Remove assignment',
                message: `Remove ${assignmentName} from this assignment?`,
                destructive: true,
              })
            ) {
              await runDelete('assignment', async () => {
                await deleteStaffAssignment(targetId, assignmentLevel);
                if (projectId) removeStaffAssignmentLocally(projectId, targetId, assignmentLevel);
                refreshProjects();
              });
            }
          },
          disabled: !canEditThis,
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
            if (
              await confirmAction({
                title: 'Remove assignment',
                message: `Remove ${assignmentName} from this assignment?`,
                destructive: true,
              })
            ) {
              // Equipment assignments use a single endpoint for all levels
              await runDelete('equipment assignment', async () => {
                await deleteEquipmentAssignment(targetId);
                if (projectId) removeEquipmentAssignmentLocally(projectId, targetId);
                refreshProjects();
              });
            }
          },
          disabled: !canEdit,
        },
      ];
    }

    return [];
  }, [contextMenu, findTarget, canEdit, whatIfMode, createBlockedReason, canDeleteProject, currentUser, menuProject, ownDefaultAllocation, openProjectModal, openPhaseModal, openSubphaseModal, openModal, setEditingStaffAssignment, setEditingEquipmentAssignment, refreshProjects]);

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
