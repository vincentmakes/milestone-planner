/**
 * ContextMenuContainer
 * Renders context menus based on uiStore state
 */

import { useCallback, useMemo, useState } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { ContextMenu, type ContextMenuItem } from '@/components/common';
import { deleteProject, deletePhase, deleteSubphase, deleteStaffAssignment, deleteEquipmentAssignment, createStaffAssignment } from '@/api';
import { can, canBookEquipment, canBookSelf, canEditProject, canEditAssignment, canSelf, isSelf, needsApproval } from '@/utils/permissions';
import { approvalsApi, isPendingResponse } from '@/api/endpoints/approvals';
import { ApiError } from '@/api/client';
import { RejectRequestDialog } from '@/components/common/ApprovalActions';
import { isPendingAssignment } from '@/utils/kanbanCards';
import { assignmentLock, flashSentForApproval, markRequestPendingLocally } from '@/utils/pendingBookings';
import { findSubphaseById } from '@/utils/subphaseUtils';
import { formatDateISO } from '@/utils/date';
import {
  findStaffAssignment,
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
import { Icon, EditIcon, PlusIcon, TrashIcon, CheckIcon, CloseIcon, PersonIcon, BriefcaseIcon } from '@/components/common/Icon';

/**
 * Run a delete from the context menu. A failed delete must not be an
 * unhandled rejection: follow the persist-failure protocol (reload the
 * projects, clear the undo history) and tell the user.
 */
/** Report a failure from a menu action, which has no form to show it in. */
function flashError(err: unknown, prefix = ''): void {
  const message = err instanceof Error ? err.message : 'unknown error';
  useUIStore.getState().showFlash(`${prefix}${message}`);
}

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
  // Decisions on approval requests are real writes outside the sandbox.
  const decideBlockedReason = whatIfMode ? whatIfUnavailableMessage('Approval decisions') : undefined;
  // The request whose rejection reason is being asked for (shared Modal, never a prompt).
  const [rejecting, setRejecting] = useState<{ requestId: number; name: string } | null>(null);
  // Deletes only change projects. A full loadAllData() would also re-resolve
  // the current site, and switch away from the one the user is looking at.
  const { refreshProjects } = useDataLoader();

  // The project the menu was opened on. For a project menu it is the target
  // itself; everything below a project carries contextMenu.projectId.
  const menuProject = useMemo(() => {
    const id = contextMenu.type === 'project' ? contextMenu.targetId : contextMenu.projectId;
    return projects.find((p) => p.id === id);
  }, [projects, contextMenu.type, contextMenu.targetId, contextMenu.projectId]);

  // Per-project rights: projects.edit_any, or the project's manager.
  const canEdit = canEditProject(currentUser, menuProject);
  // Equipment bookings: equipment_bookings.manage, or managing the project.
  const canBook = canBookEquipment(currentUser, menuProject);
  // Deleting a project needs projects.delete, never in the manager bundle.
  const canDeleteProject = can(currentUser, 'projects.delete');

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
    // editors (they have the full "Assign Staff" dialog).
    const assignMeItem = (): ContextMenuItem[] => {
      // Hidden when the role may not book its own time at all, or when the
      // user is not bookable as a resource (the server would answer 400).
      if (canEdit || !currentUser || !canBookSelf(currentUser, currentUser.id)) return [];
      const item = target as Project | Phase | Subphase | undefined;
      const mine = (item?.staffAssignments ?? []).filter((a) => a.staff_id === currentUser.id);
      const pending = mine.some(isPendingAssignment);
      // A project booking carries its own dates, so one per person; on a
      // phase / subphase the server places a dateless second booking (it
      // halves a full-span one or fills the largest free gap, or refuses).
      // A one-day card has no room for a second one: the server always
      // refuses, so the item stays "Assigned to me".
      const oneDay = !!item?.start_date && item.start_date === item.end_date;
      const again = mine.length > 0 && !pending && type !== 'project' && !oneDay;
      const blocked = mine.length > 0 && !again;
      // In approval mode the server files a request instead (202).
      const asRequest = needsApproval(currentUser, 'assignments.self_create');
      const label = pending
        ? 'Assignment requested'
        : mine.length > 0
          ? again
            ? asRequest
              ? 'Request to assign me again'
              : 'Assign me again'
            : 'Assigned to me'
          : asRequest
            ? 'Request to assign me'
            : 'Assign me';
      return [
        {
          label,
          icon: <Icon icon={PersonIcon} size={14} />,
          onClick: async () => {
            if (!item) return;
            // A project may have no dates yet; the assignment still needs some.
            const today = formatDateISO(new Date());
            try {
              // On a phase / subphase the booking is sent without dates: the
              // server books it linked when it is the person's first on the
              // card and places it (largest free gap, or the half of a
              // full-span booking) on "Assign me again"; a project booking
              // takes the project's days.
              const res = await createStaffAssignment({
                staff_id: currentUser.id,
                allocation: ownDefaultAllocation,
                ...(type === 'project'
                  ? { start_date: item.start_date || today, end_date: item.end_date || today }
                  : {}),
                project_id: type === 'project' ? targetId : projectId,
                phase_id: type === 'phase' ? targetId : undefined,
                subphase_id: type === 'subphase' ? targetId : undefined,
              });
              await refreshProjects();
              if (isPendingResponse(res)) flashSentForApproval();
            } catch (err) {
              console.error('Failed to self-assign:', err);
              flashError(err, 'Could not assign you: ');
            }
          },
          disabled: blocked || !item || whatIfMode,
          title: blocked ? undefined : createBlockedReason,
        },
      ];
    };

    // Project context menu
    if (type === 'project') {
      const project = target as Project;
      return [
        {
          label: 'Edit Project',
          icon: <Icon icon={EditIcon} size={14} />,
          onClick: () => {
            if (project) openProjectModal(project);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Phase',
          icon: <Icon icon={PlusIcon} size={14} />,
          onClick: () => {
            openPhaseModal(undefined, targetId);
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        {
          label: 'Assign Staff',
          icon: <Icon icon={PersonIcon} size={14} />,
          onClick: () => {
            openModal('staffAssignment', { projectId: targetId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <Icon icon={BriefcaseIcon} size={14} />,
          onClick: () => {
            openModal('equipmentAssignment', { projectId: targetId });
          },
          disabled: !canBook || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Project',
          icon: <Icon icon={TrashIcon} size={14} />,
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
          icon: <Icon icon={EditIcon} size={14} />,
          onClick: () => {
            if (phase && projectId) openPhaseModal(phase, projectId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Subphase',
          icon: <Icon icon={PlusIcon} size={14} />,
          onClick: () => {
            openSubphaseModal(undefined, targetId, projectId);
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        {
          label: 'Assign Staff',
          icon: <Icon icon={PersonIcon} size={14} />,
          onClick: () => {
            openModal('staffAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <Icon icon={BriefcaseIcon} size={14} />,
          onClick: () => {
            openModal('equipmentAssignment', { phaseId: targetId, projectId });
          },
          disabled: !canBook || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Phase',
          icon: <Icon icon={TrashIcon} size={14} />,
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
          icon: <Icon icon={EditIcon} size={14} />,
          onClick: () => {
            if (subphase && phaseId && projectId) openSubphaseModal(subphase, phaseId, projectId);
          },
          disabled: !canEdit,
        },
        {
          label: 'Add Child Subphase',
          icon: <Icon icon={PlusIcon} size={14} />,
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
          icon: <Icon icon={PersonIcon} size={14} />,
          onClick: () => {
            openModal('staffAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canEdit || whatIfMode,
          title: createBlockedReason,
        },
        ...assignMeItem(),
        {
          label: 'Assign Equipment',
          icon: <Icon icon={BriefcaseIcon} size={14} />,
          onClick: () => {
            openModal('equipmentAssignment', { subphaseId: targetId, phaseId, projectId });
          },
          disabled: !canBook || whatIfMode,
          title: createBlockedReason,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Subphase',
          icon: <Icon icon={TrashIcon} size={14} />,
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
      const staffId = assignmentData?.staffId;
      const row = findStaffAssignment(menuProject, assignmentLevel, targetId);
      const request = row?.approval ?? null;
      const isRequester = Boolean(request && currentUser && request.requester_id === currentUser.id);
      // The one lock rule (assignmentLock, shared with the booking dialog and
      // like KanbanCardModal's): a row with an open request from me offers me
      // only Cancel request; a pending create is locked for everyone (deciders
      // approve / reject, the requester cancels); editors keep their controls
      // on an approved row carrying someone else's change request (their write
      // expires it server-side). Whoever manages others' bookings changes
      // anyone's; everyone else their own, when their role holds the matching
      // own-booking key.
      const lock = assignmentLock(row ?? { staff_id: staffId }, currentUser, menuProject);
      const lockedPending = lock === 'request-open' || lock === 'pending-other';
      const canEditThis = lock === null;
      const canRemoveThis =
        canEditAssignment(currentUser, menuProject, staffId, 'assignments.self_remove') && !lockedPending;
      const isEditor = can(currentUser, 'assignments.manage_others', menuProject);
      // Denied mode: an own booking the role may not remove shows no Delete.
      const hideDelete = !isEditor && isSelf(currentUser, staffId) && !canSelf(currentUser, 'assignments.self_remove');
      const removalNeedsApproval =
        !isEditor && isSelf(currentUser, staffId) && needsApproval(currentUser, 'assignments.self_remove');

      const refreshAfterDecision = async (action: () => Promise<unknown>) => {
        try {
          await action();
          await refreshProjects();
        } catch (err) {
          flashError(err);
          // A 409: the request was decided or expired meanwhile -- show that.
          if (err instanceof ApiError && err.status === 409) await refreshProjects();
        }
      };

      const requestItems: ContextMenuItem[] = [];
      if (request?.can_decide) {
        requestItems.push(
          {
            label: 'Approve request',
            icon: <Icon icon={CheckIcon} size={14} />,
            onClick: () => refreshAfterDecision(() => approvalsApi.approve(request.request_id)),
            disabled: whatIfMode,
            title: decideBlockedReason,
          },
          {
            label: 'Reject request…',
            icon: <Icon icon={CloseIcon} size={14} />,
            onClick: () => setRejecting({ requestId: request.request_id, name: assignmentName }),
            disabled: whatIfMode,
            title: decideBlockedReason,
          }
        );
      }
      if (request && isRequester) {
        requestItems.push({
          label: 'Cancel request',
          icon: <Icon icon={CloseIcon} size={14} />,
          onClick: () => refreshAfterDecision(() => approvalsApi.cancel(request.request_id)),
          disabled: whatIfMode,
          title: decideBlockedReason,
        });
      }
      if (requestItems.length > 0) requestItems.push({ label: '', divider: true, onClick: () => {} });

      const deleteItems: ContextMenuItem[] = hideDelete
        ? []
        : [
            { label: '', divider: true, onClick: () => {} },
            {
              label: 'Delete Assignment',
              icon: <Icon icon={TrashIcon} size={14} />,
              danger: true,
              onClick: async () => {
                if (
                  await confirmAction({
                    title: 'Remove assignment',
                    message: removalNeedsApproval
                      ? `Request to remove ${assignmentName} from this assignment? The removal will be sent for approval.`
                      : `Remove ${assignmentName} from this assignment?`,
                    destructive: true,
                  })
                ) {
                  await runDelete('assignment', async () => {
                    const res = await deleteStaffAssignment(targetId, assignmentLevel);
                    if (isPendingResponse(res)) {
                      // Sent for approval: the booking stays until decided.
                      if (projectId && currentUser) {
                        markRequestPendingLocally(projectId, targetId, assignmentLevel, currentUser.id, 'assignments.self_remove', res, null);
                      }
                      flashSentForApproval();
                    } else if (projectId) {
                      removeStaffAssignmentLocally(projectId, targetId, assignmentLevel);
                    }
                    refreshProjects();
                  });
                }
              },
              disabled: !canRemoveThis,
            },
          ];

      return [
        ...requestItems,
        {
          label: 'Edit Assignment',
          icon: <Icon icon={EditIcon} size={14} />,
          onClick: () => {
            setEditingStaffAssignment({
              id: targetId,
              project_id: projectId || 0,
              phase_id: phaseId || null,
              subphase_id: subphaseId || null,
              staff_id: assignmentData?.staffId || 0,
              staff_name: assignmentData?.name || '',
              allocation: assignmentData?.allocation || 100,
              // Effective dates: a card booking's own, or its card's when linked
              start_date: assignmentData?.startDate || row?.start_date || '',
              end_date: assignmentData?.endDate || row?.end_date || '',
              linked: assignmentData?.linked ?? row?.linked,
            });
            openModal('staffAssignment', { projectId, phaseId, subphaseId });
          },
          disabled: !canEditThis,
        },
        ...deleteItems,
      ];
    }

    // Equipment Assignment context menu
    if (type === 'equipmentAssignment') {
      const { assignmentData, subphaseId } = contextMenu;
      const assignmentName = assignmentData?.name || 'Equipment Assignment';
      return [
        {
          label: 'Edit Assignment',
          icon: <Icon icon={EditIcon} size={14} />,
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
          disabled: !canBook,
        },
        { label: '', divider: true, onClick: () => {} },
        {
          label: 'Delete Assignment',
          icon: <Icon icon={TrashIcon} size={14} />,
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
          disabled: !canBook,
        },
      ];
    }

    return [];
  }, [contextMenu, findTarget, canEdit, canBook, whatIfMode, createBlockedReason, decideBlockedReason, canDeleteProject, currentUser, menuProject, ownDefaultAllocation, openProjectModal, openPhaseModal, openSubphaseModal, openModal, setEditingStaffAssignment, setEditingEquipmentAssignment, refreshProjects]);

  return (
    <>
      {contextMenu.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getMenuItems()}
          onClose={hideContextMenu}
        />
      )}
      <RejectRequestDialog
        isOpen={rejecting !== null}
        subject={rejecting?.name}
        onClose={() => setRejecting(null)}
        onReject={async (note) => {
          if (!rejecting) return;
          await approvalsApi.reject(rejecting.requestId, note);
          await refreshProjects();
        }}
      />
    </>
  );
}
