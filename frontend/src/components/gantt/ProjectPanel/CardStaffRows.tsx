/**
 * CardStaffRows - the staff bookings of one phase / subphase in the project
 * tree (1.17.0). A person with one booking on the card gets their
 * AssignmentRow as before; a person with two or more gets a StaffGroupRow
 * followed, while the group is expanded, by one AssignmentRow per booking two
 * levels deeper (their badges sit right of the group row's badge). The
 * layout comes from `cardStaffItems`, the same helper the timeline
 * (ProjectTimeline) and `calculateRowPositions` use.
 */

import { Fragment, memo, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { bookingSpan, isUnlinkedBooking } from '@/utils/bookingSegments';
import { allocationRange, cardStaffItems } from '@/components/gantt/utils/staffGroups';
import type { Phase, StaffAssignment, Subphase } from '@/types';
import { AssignmentRow } from './AssignmentRow';
import { StaffGroupRow } from './StaffGroupRow';

interface CardStaffRowsProps {
  level: 'phase' | 'subphase';
  card: Phase | Subphase;
  projectId: number;
  /** The top-level phase (for a subphase: its phase) */
  phaseId: number;
  /** Depth of the card's children (the card row's depth + 1) */
  depth: number;
}

export const CardStaffRows = memo(function CardStaffRows({ level, card, projectId, phaseId, depth }: CardStaffRowsProps) {
  const staff = useAppStore((s) => s.staff);
  const collapsedStaffGroups = useViewStore((s) => s.collapsedStaffGroups);
  const toggleStaffGroup = useViewStore((s) => s.toggleStaffGroup);
  const items = useMemo(
    () => cardStaffItems(card.staffAssignments, level, card.id, collapsedStaffGroups),
    [card.staffAssignments, level, card.id, collapsedStaffGroups]
  );

  const nameOf = (a: StaffAssignment) => staff.find((s) => s.id === a.staff_id)?.name || a.staff_name || 'Unknown';

  // The earliest effective start among a person's bookings: the overview
  // row's badge scrolls the timeline there.
  const firstStart = (rows: StaffAssignment[]) =>
    rows.map((row) => bookingSpan(row, card).start).reduce((a, b) => (b < a ? b : a));

  const bookingRow = (assignment: StaffAssignment, rowDepth: number) => {
    const span = bookingSpan(assignment, card);
    return (
      <AssignmentRow
        key={`staff-${assignment.id}`}
        type={level === 'phase' ? 'phase-staff' : 'subphase-staff'}
        assignmentId={assignment.id}
        projectId={projectId}
        phaseId={phaseId}
        subphaseId={level === 'subphase' ? card.id : undefined}
        staffId={assignment.staff_id}
        name={nameOf(assignment)}
        role={staff.find((s) => s.id === assignment.staff_id)?.role}
        allocation={assignment.allocation}
        phaseType={card.name}
        phaseColor={card.color}
        depth={rowDepth}
        approvalStatus={assignment.approval_status}
        approval={assignment.approval}
        startDate={span.start}
        endDate={span.end}
        linked={!isUnlinkedBooking(assignment)}
        cardStartDate={card.start_date}
        cardEndDate={card.end_date}
      />
    );
  };

  return (
    <>
      {items.map((item) => {
        if (item.kind === 'single') return bookingRow(item.assignment, depth);
        return (
          <Fragment key={`group-${item.key}`}>
            <StaffGroupRow
              name={nameOf(item.rows[0])}
              count={item.rows.length}
              allocationText={allocationRange(item.rows)}
              collapsed={item.collapsed}
              onToggle={() => toggleStaffGroup(item.key)}
              depth={depth}
              level={level}
              phaseType={card.name}
              phaseColor={card.color}
              firstStart={firstStart(item.rows)}
            />
            {/* Two levels deeper than the group's edge: the group row's chevron
                comes before its badge, so one level would put these badges
                left of the group badge and they would not read as its children. */}
            {!item.collapsed && item.rows.map((row) => bookingRow(row, depth + 2))}
          </Fragment>
        );
      })}
    </>
  );
});
