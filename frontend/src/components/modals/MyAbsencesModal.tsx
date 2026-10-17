/**
 * MyAbsencesModal - self-service view of the signed-in user's absences
 *
 * Lists upcoming/current and recent (last 90 days) absences with their type,
 * and lets any user (including the plain 'user' role -- the backend enforces
 * the own-user rule) add, edit, delete and import from an .ics file.
 * Edit/Add switch to VacationModal, which returns here when it closes.
 */

import { useState, useMemo, useCallback } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { BackIcon, PlusIcon, UploadIcon } from '@/components/settings/panels/PanelIcons';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore, selectAbsenceTypesById } from '@/stores/appStore';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import { formatDateISO, parseDateISO } from '@/utils/date';
import {
  parseRecurringPattern,
  absenceTypeFor,
  absenceTypeName,
  absenceColorStyle,
  isUnavailableType,
  DAY_NAMES,
} from '@/utils/recurringVacation';
import type { Vacation } from '@/types';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { VacationICSImport } from './VacationICSImport';
import styles from './MyAbsencesModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';

/** How far back "recent" absences go */
const RECENT_DAYS = 90;

function datePart(value: string): string {
  return value.split('T')[0];
}

/** "3 Mar 2026" or "3 Mar – 7 Mar 2026" in the browser locale (local dates) */
function formatRange(start: string, end: string): string {
  const fmt = (d: string) =>
    parseDateISO(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

export function MyAbsencesModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const openVacationModal = useUIStore((s) => s.openVacationModal);
  const currentUser = useAppStore((s) => s.currentUser);
  const vacations = useAppStore((s) => s.vacations);
  const setVacations = useAppStore((s) => s.setVacations);

  const [showImport, setShowImport] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { begin, end } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  const isOpen = activeModal === 'myAbsences';
  // Adding during What-If would only be queued (absences are not part of the
  // snapshot); the .ics importer below blocks itself the same way.
  const whatIf = useWhatIfBlocked();
  const addBlockedReason = whatIf.blocked ? whatIf.reason('Adding absences') : null;
  const userId = currentUser?.id ?? null;

  const typesById = useAppStore(selectAbsenceTypesById);

  const { upcoming, recent } = useMemo(() => {
    const today = formatDateISO(new Date());
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RECENT_DAYS);
    const cutoff = formatDateISO(cutoffDate);

    const own = vacations.filter((v) => v.staff_id === userId);
    const upcomingList = own
      .filter((v) => datePart(v.end_date) >= today)
      .sort((a, b) => datePart(a.start_date).localeCompare(datePart(b.start_date)));
    const recentList = own
      .filter((v) => datePart(v.end_date) < today && datePart(v.end_date) >= cutoff)
      .sort((a, b) => datePart(b.start_date).localeCompare(datePart(a.start_date)));
    return { upcoming: upcomingList, recent: recentList };
  }, [vacations, userId]);

  const handleClose = useCallback(() => {
    setShowImport(false);
    setError(null);
    closeModal();
  }, [closeModal]);

  const handleAdd = useCallback(() => {
    if (userId == null || addBlockedReason) return;
    openVacationModal(undefined, userId, 'myAbsences');
  }, [openVacationModal, userId, addBlockedReason]);

  const handleEdit = useCallback(
    (vacation: Vacation) => {
      openVacationModal(vacation, vacation.staff_id, 'myAbsences');
    },
    [openVacationModal]
  );

  const handleDelete = useCallback(
    async (vacation: Vacation) => {
      if (
        !(await confirmAction({ title: 'Delete absence', message: 'Delete this absence?', destructive: true }))
      )
        return;
      if (!begin()) return; // a delete is already running
      setDeletingId(vacation.id);
      setError(null);
      try {
        await deleteVacation(vacation.id);
        setVacations(await getVacations());
      } catch (err) {
        console.error('Failed to delete absence:', err);
        setError(err instanceof Error ? err.message : 'Failed to delete the absence');
      } finally {
        setDeletingId(null);
        end();
      }
    },
    [setVacations, begin, end]
  );

  if (!isOpen || !currentUser) return null;

  const renderRow = (vacation: Vacation) => {
    const type = absenceTypeFor(vacation, typesById);
    const pattern = parseRecurringPattern(vacation.description);
    const description = pattern ? pattern.cleanDescription : vacation.description || '';
    const typeName = absenceTypeName(type);
    const start = datePart(vacation.start_date);
    const end = datePart(vacation.end_date);

    return (
      <li key={vacation.id} className={styles.row} data-testid="my-absence-row">
        <span className={styles.type} style={absenceColorStyle(type)}>
          <span className={styles.chip} aria-hidden="true" />
          <span className={styles.typeName}>{typeName}</span>
          {!isUnavailableType(type) && <span className={styles.availableNote}>available</span>}
        </span>
        <span className={styles.details}>
          <span className={styles.dates}>{formatRange(start, end)}</span>
          {description && description !== typeName && (
            <span className={styles.description}>{description}</span>
          )}
          {pattern && (
            <span className={styles.recurring}>
              Recurring: {pattern.daysOfWeek.map((d) => DAY_NAMES[d]).join(', ')}
            </span>
          )}
        </span>
        <span className={styles.rowActions}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleEdit(vacation)}
            aria-label={`Edit ${typeName} ${start}`}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.deleteBtn}
            onClick={() => void handleDelete(vacation)}
            loading={deletingId === vacation.id}
            aria-label={`Delete ${typeName} ${start}`}
          >
            Delete
          </Button>
        </span>
      </li>
    );
  };

  const footer = (
    <div className={styles.footer}>
      <Button type="button" variant="secondary" onClick={handleClose}>
        Close
      </Button>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="My absences" size="lg" footer={footer}>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <Button
            type="button"
            variant="primary"
            icon={<PlusIcon />}
            onClick={handleAdd}
            disabled={!!addBlockedReason}
            title={addBlockedReason ?? undefined}
          >
            Add absence
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon={showImport ? <BackIcon /> : <UploadIcon />}
            onClick={() => setShowImport((v) => !v)}
            aria-pressed={showImport}
          >
            {showImport ? 'Back to list' : 'Import .ics'}
          </Button>
        </div>

        {addBlockedReason && !showImport && (
          <div className={styles.error} role="status">
            {addBlockedReason}
          </div>
        )}

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {showImport ? (
          <VacationICSImport staffId={currentUser.id} />
        ) : (
          <>
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Upcoming and current</h3>
              {upcoming.length > 0 ? (
                <ul className={styles.list}>{upcoming.map(renderRow)}</ul>
              ) : (
                <p className={styles.empty}>No upcoming absences.</p>
              )}
            </section>
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Last {RECENT_DAYS} days</h3>
              {recent.length > 0 ? (
                <ul className={styles.list}>{recent.map(renderRow)}</ul>
              ) : (
                <p className={styles.empty}>No recent absences.</p>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
