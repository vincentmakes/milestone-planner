/**
 * ModalContainer - Renders all application modals
 * Centralized modal management based on uiStore activeModal state
 */

import { 
  ProjectModal, 
  PhaseModal, 
  SubphaseModal,
  StaffAssignmentModal,
  EquipmentAssignmentModal,
  VacationModal,
  BankHolidayModal,
  CustomHolidayModal,
  SiteModal,
  SiteManagementModal,
  UserManagementModal,
  SSOConfigModal,
  EquipmentManagementModal,
  PredefinedPhasesModal,
  ImportProjectModal,
  SettingsModal,
} from '@/components/modals';

export function ModalContainer() {
  return (
    <>
      <ProjectModal />
      <PhaseModal />
      <SubphaseModal />
      <StaffAssignmentModal />
      <EquipmentAssignmentModal />
      <VacationModal />
      <BankHolidayModal />
      <CustomHolidayModal />
      <SiteModal />
      <SiteManagementModal />
      <UserManagementModal />
      <SSOConfigModal />
      <EquipmentManagementModal />
      <PredefinedPhasesModal />
      <ImportProjectModal />
      <SettingsModal />
    </>
  );
}
