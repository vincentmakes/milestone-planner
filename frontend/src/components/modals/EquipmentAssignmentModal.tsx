/**
 * EquipmentAssignmentModal - Assign Equipment to Projects/Phases/Subphases
 * Thin wrapper around the generic AssignmentModal component.
 */

import { AssignmentModal } from './AssignmentModal';

export function EquipmentAssignmentModal() {
  return <AssignmentModal mode="equipment" />;
}
