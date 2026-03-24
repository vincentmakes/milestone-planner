/**
 * ModalContainer - Renders all application modals
 * Centralized modal management based on uiStore activeModal state
 * Modals are lazy-loaded to reduce initial bundle size
 */

import { lazy, Suspense } from 'react';

const ProjectModal = lazy(() => import('./ProjectModal').then(m => ({ default: m.ProjectModal })));
const PhaseModal = lazy(() => import('./PhaseModal').then(m => ({ default: m.PhaseModal })));
const SubphaseModal = lazy(() => import('./SubphaseModal').then(m => ({ default: m.SubphaseModal })));
const StaffAssignmentModal = lazy(() => import('./StaffAssignmentModal').then(m => ({ default: m.StaffAssignmentModal })));
const EquipmentAssignmentModal = lazy(() => import('./EquipmentAssignmentModal').then(m => ({ default: m.EquipmentAssignmentModal })));
const VacationModal = lazy(() => import('./VacationModal').then(m => ({ default: m.VacationModal })));
const BankHolidayModal = lazy(() => import('./BankHolidayModal').then(m => ({ default: m.BankHolidayModal })));
const CustomHolidayModal = lazy(() => import('./CustomHolidayModal').then(m => ({ default: m.CustomHolidayModal })));
const CompanyEventModal = lazy(() => import('./CompanyEventModal').then(m => ({ default: m.CompanyEventModal })));
const SiteModal = lazy(() => import('./SiteModal').then(m => ({ default: m.SiteModal })));
const SiteManagementModal = lazy(() => import('./SiteManagementModal').then(m => ({ default: m.SiteManagementModal })));
const UserManagementModal = lazy(() => import('./UserManagementModal').then(m => ({ default: m.UserManagementModal })));
const SSOConfigModal = lazy(() => import('./SSOConfigModal').then(m => ({ default: m.SSOConfigModal })));
const EquipmentManagementModal = lazy(() => import('./EquipmentManagementModal').then(m => ({ default: m.EquipmentManagementModal })));
const PredefinedPhasesModal = lazy(() => import('./PredefinedPhasesModal').then(m => ({ default: m.PredefinedPhasesModal })));
const ImportProjectModal = lazy(() => import('./ImportProjectModal').then(m => ({ default: m.ImportProjectModal })));
const SettingsModal = lazy(() => import('./SettingsModal').then(m => ({ default: m.SettingsModal })));

export function ModalContainer() {
  return (
    <Suspense fallback={null}>
      <ProjectModal />
      <PhaseModal />
      <SubphaseModal />
      <StaffAssignmentModal />
      <EquipmentAssignmentModal />
      <VacationModal />
      <BankHolidayModal />
      <CustomHolidayModal />
      <CompanyEventModal />
      <SiteModal />
      <SiteManagementModal />
      <UserManagementModal />
      <SSOConfigModal />
      <EquipmentManagementModal />
      <PredefinedPhasesModal />
      <ImportProjectModal />
      <SettingsModal />
    </Suspense>
  );
}
