/**
 * StaffAssignmentModal - Assign Staff to Projects/Phases/Subphases
 * Thin wrapper around the generic AssignmentModal component.
 */

import { AssignmentModal } from './AssignmentModal';

export function StaffAssignmentModal() {
  return <AssignmentModal mode="staff" />;
}
