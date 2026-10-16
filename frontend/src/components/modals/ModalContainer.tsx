/**
 * ModalContainer - Renders all application modals
 * Centralized modal management based on uiStore activeModal state
 * Modals are lazy-loaded to reduce initial bundle size
 *
 * Admin dialogs (users, sites, equipment, phases, SSO, settings, holidays,
 * events) live in the Settings hub; their old modal keys open the hub.
 */

import { lazy, Suspense } from 'react';

const ProjectModal = lazy(() => import('./ProjectModal').then(m => ({ default: m.ProjectModal })));
const PhaseModal = lazy(() => import('./PhaseModal').then(m => ({ default: m.PhaseModal })));
const SubphaseModal = lazy(() => import('./SubphaseModal').then(m => ({ default: m.SubphaseModal })));
const KanbanCardModal = lazy(() => import('./KanbanCardModal').then(m => ({ default: m.KanbanCardModal })));
const StaffAssignmentModal = lazy(() => import('./StaffAssignmentModal').then(m => ({ default: m.StaffAssignmentModal })));
const EquipmentAssignmentModal = lazy(() => import('./EquipmentAssignmentModal').then(m => ({ default: m.EquipmentAssignmentModal })));
const VacationModal = lazy(() => import('./VacationModal').then(m => ({ default: m.VacationModal })));
const MyAbsencesModal = lazy(() => import('./MyAbsencesModal').then(m => ({ default: m.MyAbsencesModal })));
const EquipmentBlockModal = lazy(() => import('./EquipmentBlockModal').then(m => ({ default: m.EquipmentBlockModal })));
const ImportProjectModal = lazy(() => import('./ImportProjectModal').then(m => ({ default: m.ImportProjectModal })));
const SettingsHub = lazy(() => import('@/components/settings/SettingsHub').then(m => ({ default: m.SettingsHub })));

export function ModalContainer() {
  return (
    <Suspense fallback={null}>
      <ProjectModal />
      <PhaseModal />
      <SubphaseModal />
      <KanbanCardModal />
      <StaffAssignmentModal />
      <EquipmentAssignmentModal />
      <VacationModal />
      <MyAbsencesModal />
      <EquipmentBlockModal />
      <ImportProjectModal />
      <SettingsHub />
    </Suspense>
  );
}
