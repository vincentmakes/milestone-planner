/**
 * One of my bookings (My Work → My Assignments): the project and its site,
 * the card it books (a link to the Kanban card) or "Whole project", the
 * effective dates, the allocation, a pin when it follows its card's dates,
 * and Open — the Gantt's edit path: the booking dialog for that row, which
 * carries the comment thread and says when the booking cannot be changed.
 */

import { Button } from '@/components/common/Button';
import { Icon, PinIcon } from '@/components/common/Icon';
import { useUIStore } from '@/stores/uiStore';
import { formatMediumDate } from '@/utils/date';
import type { MyAssignment } from '@/utils/myAssignments';
import { CardLink } from './CardLink';
import styles from './WorkView.module.css';

interface MyAssignmentRowProps {
  row: MyAssignment;
  /** The project's site name, when known */
  siteName: string | null;
}

export function MyAssignmentRow({ row, siteName }: MyAssignmentRowProps) {
  const setEditingStaffAssignment = useUIStore((s) => s.setEditingStaffAssignment);
  const openModal = useUIStore((s) => s.openModal);
  const { assignment, project, card, level } = row;
  const range =
    row.start === row.end
      ? formatMediumDate(row.start)
      : `${formatMediumDate(row.start)} – ${formatMediumDate(row.end)}`;

  const open = () => {
    const phaseId = assignment.phase_id ?? undefined;
    const subphaseId = assignment.subphase_id ?? undefined;
    setEditingStaffAssignment({
      id: assignment.id,
      project_id: project.id,
      phase_id: assignment.phase_id ?? null,
      subphase_id: assignment.subphase_id ?? null,
      staff_id: assignment.staff_id,
      staff_name: assignment.staff_name ?? '',
      allocation: assignment.allocation,
      start_date: row.start,
      end_date: row.end,
      linked: card ? row.linked : false,
    });
    openModal('staffAssignment', { projectId: project.id, phaseId, subphaseId });
  };

  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>
          {project.name}
          {siteName && <span className={styles.siteName}> · {siteName}</span>}
        </span>
        <span className={styles.itemMeta}>
          {card ? (
            <CardLink entityType={level} entityId={card.id} projectId={project.id} label={card.name} />
          ) : (
            <span className={styles.cardName}>Whole project</span>
          )}
          <span>{range}</span>
          <span className={styles.allocationChip}>{assignment.allocation}%</span>
          {row.linked && (
            <span className={styles.linkedPin}>
              <Icon icon={PinIcon} size={13} title={`Follows the ${level} dates`} />
            </span>
          )}
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={open}
        aria-label={`Open booking on ${card ? `${card.name} of ` : ''}${project.name}`}
      >
        Open
      </Button>
    </li>
  );
}
