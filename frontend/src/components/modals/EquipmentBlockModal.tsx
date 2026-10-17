/**
 * Equipment Block Modal
 * Modal for blocking equipment due to maintenance, defect, or calibration.
 * Equivalent to VacationModal but for equipment.
 */

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import {
  createEquipmentBlock,
  updateEquipmentBlock,
  deleteEquipmentBlock,
  getEquipmentBlocks,
} from '@/api';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { toInputDateFormat, formatDateISO, daysBetweenDateStrings } from '@/utils/date';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import styles from './EquipmentBlockModal.module.css';

const REASON_OPTIONS: { value: string; label: string; defaultDescription: string }[] = [
  { value: 'maintenance', label: 'Maintenance', defaultDescription: 'Maintenance' },
  { value: 'defect', label: 'Defect / Out of order', defaultDescription: 'Defect' },
  { value: 'calibration', label: 'Calibration', defaultDescription: 'Calibration' },
  { value: 'other', label: 'Other', defaultDescription: 'Unavailable' },
];

export function EquipmentBlockModal() {
  const { activeModal, editingEquipmentBlock, modalContext, closeModal } = useUIStore();
  const equipment = useAppStore((s) => s.equipment);
  const currentSite = useAppStore((s) => s.currentSite);
  const setEquipmentBlocks = useAppStore((s) => s.setEquipmentBlocks);

  const isOpen = activeModal === 'equipmentBlock';
  const isEditing = !!editingEquipmentBlock;
  // A create during What-If would only be queued and stay invisible until
  // Apply (blocks are not part of the What-If snapshot); edits stay allowed.
  const whatIf = useWhatIfBlocked();
  const createBlockedReason = !isEditing && whatIf.blocked ? whatIf.reason('Blocking equipment') : null;

  const [equipmentId, setEquipmentId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState<string>('maintenance');
  const [description, setDescription] = useState('Maintenance');

  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const siteEquipment = useMemo(() => {
    if (!currentSite) return equipment;
    return equipment.filter((e) => e.site_id === currentSite.id);
  }, [equipment, currentSite]);

  // Initialize form whenever the modal opens
  useEffect(() => {
    if (!isOpen) return;
    setError(null);

    if (editingEquipmentBlock) {
      setEquipmentId(editingEquipmentBlock.equipment_id);
      setStartDate(toInputDateFormat(editingEquipmentBlock.start_date));
      setEndDate(toInputDateFormat(editingEquipmentBlock.end_date));
      setReason(editingEquipmentBlock.reason || 'maintenance');
      setDescription(editingEquipmentBlock.description || 'Maintenance');
    } else {
      setEquipmentId(modalContext.equipmentId ?? null);
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      setStartDate(formatDateISO(today));
      setEndDate(formatDateISO(tomorrow));
      setReason('maintenance');
      setDescription('Maintenance');
    }
  }, [isOpen, editingEquipmentBlock, modalContext.equipmentId]);

  const duration = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return daysBetweenDateStrings(startDate, endDate) + 1;
  }, [startDate, endDate]);

  const handleReasonChange = (value: string) => {
    setReason(value);
    const opt = REASON_OPTIONS.find((o) => o.value === value);
    if (opt && (description === '' || REASON_OPTIONS.some((o) => o.defaultDescription === description))) {
      setDescription(opt.defaultDescription);
    }
  };

  const refreshBlocks = async () => {
    try {
      const blocks = await getEquipmentBlocks();
      setEquipmentBlocks(blocks);
    } catch (err) {
      console.error('[EquipmentBlockModal] Failed to refresh blocks:', err);
    }
  };

  const handleSave = async () => {
    if (createBlockedReason) {
      setError(createBlockedReason);
      return;
    }
    if (!equipmentId) {
      setError('Please select equipment');
      return;
    }
    if (!startDate || !endDate) {
      setError('Please select start and end dates');
      return;
    }
    if (endDate < startDate) {
      setError('End date must be on or after start date');
      return;
    }

    if (!beginSubmit()) return;
    setError(null);
    try {
      const fallbackDesc = REASON_OPTIONS.find((o) => o.value === reason)?.defaultDescription ?? 'Unavailable';
      const payload = {
        equipment_id: equipmentId,
        start_date: startDate,
        end_date: endDate,
        reason,
        description: description.trim() || fallbackDesc,
      };

      if (isEditing && editingEquipmentBlock) {
        await updateEquipmentBlock(editingEquipmentBlock.id, payload);
      } else {
        await createEquipmentBlock(payload);
      }
      await refreshBlocks();
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save equipment block');
    } finally {
      endSubmit();
    }
  };

  const handleDelete = async () => {
    if (!editingEquipmentBlock) return;
    if (!window.confirm('Delete this equipment block?')) return;

    if (!beginSubmit()) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteEquipmentBlock(editingEquipmentBlock.id);
      await refreshBlocks();
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete equipment block');
    } finally {
      setIsDeleting(false);
      endSubmit();
    }
  };

  const footer = (
    <div className={styles.footer} style={{ width: '100%', justifyContent: isEditing ? 'space-between' : 'flex-end' }}>
      {isEditing && (
        <Button variant="danger" onClick={handleDelete} disabled={isSubmitting || isDeleting} loading={isDeleting}>
          Delete
        </Button>
      )}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting || isDeleting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={isSubmitting || isDeleting || !!createBlockedReason}
          title={createBlockedReason ?? undefined}
          loading={isSubmitting && !isDeleting}
        >
          {isEditing ? 'Save Changes' : 'Block Equipment'}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Equipment Block' : 'Block Equipment'}
      size="sm"
      footer={footer}
    >
      {createBlockedReason && (
        <div className={styles.error} role="status">{createBlockedReason}</div>
      )}
      {error && error !== createBlockedReason && <div className={styles.error}>{error}</div>}

      <div className={styles.formGroup}>
        <label className={styles.label}>Equipment</label>
        <select
          className={styles.input}
          value={equipmentId ?? ''}
          onChange={(e) => setEquipmentId(e.target.value ? Number(e.target.value) : null)}
          disabled={isEditing}
        >
          <option value="">Select equipment…</option>
          {siteEquipment.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {eq.name}
              {eq.type ? ` (${eq.type})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Reason</label>
        <select
          className={styles.input}
          value={reason}
          onChange={(e) => handleReasonChange(e.target.value)}
        >
          {REASON_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.formRow}>
        <div className={styles.formGroup}>
          <label className={styles.label}>Start Date</label>
          <input
            type="date"
            className={styles.input}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>End Date</label>
          <input
            type="date"
            className={styles.input}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      {duration > 0 && (
        <p className={styles.help}>
          Equipment will be blocked for {duration} day{duration !== 1 ? 's' : ''}.
        </p>
      )}

      <div className={styles.formGroup}>
        <label className={styles.label}>Description</label>
        <input
          type="text"
          className={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g., Annual calibration, Pump replacement"
          maxLength={200}
        />
      </div>

      <p className={styles.help}>
        Blocked equipment is unavailable during this period — same as staff vacations.
      </p>
    </Modal>
  );
}
