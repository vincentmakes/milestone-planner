/**
 * A link from a My Todos entry to its Kanban card: opens the card dialog in
 * place (no view switch). Plain text without `views.kanban` (the card's reads
 * need it); disabled with the reason during What-If, like the bell's card
 * links (the card dialog writes plan data).
 */

import { useUIStore } from '@/stores/uiStore';
import { useHasPermission } from '@/hooks/useCan';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import styles from './TodosView.module.css';

export const OPEN_CARD_ACTION = 'Opening a card';

interface CardLinkProps {
  entityType: string | null;
  entityId: number | null;
  projectId: number | null;
  /** The card's name */
  label: string;
}

export function CardLink({ entityType, entityId, projectId, label }: CardLinkProps) {
  const openKanbanCard = useUIStore((s) => s.openKanbanCardModal);
  const canOpenCards = useHasPermission('views.kanban');
  const whatIf = useWhatIfBlocked();
  const isCard = (entityType === 'phase' || entityType === 'subphase') && entityId != null && projectId != null;

  if (!isCard || !canOpenCards) return <span className={styles.cardName}>{label}</span>;

  const blocked = whatIf.blocked ? whatIf.reason(OPEN_CARD_ACTION) : undefined;
  return (
    <button
      type="button"
      className={styles.cardLink}
      onClick={() => openKanbanCard(entityType, entityId, projectId)}
      disabled={Boolean(blocked)}
      title={blocked}
      aria-label={`Open card ${label}`}
    >
      {label}
    </button>
  );
}
