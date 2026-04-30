/**
 * Equipment Block Modal
 * Modal for blocking equipment due to maintenance, defect, or calibration.
 * Equivalent to VacationModal but for equipment.
 */

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { createEquipmentBlock, getEquipment } from '@/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import type { Equipment } from '@/types';
import styles from './CustomHolidayModal.module.css'; // Reuse same styles

const REASON_OPTIONS: { value: string; label: string; defaultDescription: string }[] = [
  { value: 'maintenance', label: 'Maintenance', defaultDescription: 'Maintenance' },
  { value: 'defect', label: 'Defect / Out of order', defaultDescription: 'Defect' },
  { value: 'calibration', label: 'Calibration', defaultDescription: 'Calibration' },
  { value: 'other', label: 'Other', defaultDescription: 'Unavailable' },
];

export function EquipmentBlockModal() {
  const { activeModal, modalContext, closeModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);

  const isOpen = activeModal === 'equipmentBlock';

  // Equipment list - loaded when modal opens
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [equipmentId, setEquipmentId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState<string>('maintenance');
  const [description, setDescription] = useState('Maintenance');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset and load equipment when modal opens
  useEffect(() => {
    if (!isOpen) return;

    setEquipmentId(modalContext.equipmentId ?? null);
    setStartDate('');
    setEndDate('');
    setReason('maintenance');
    setDescription('Maintenance');
    setError(null);

    let cancelled = false;
    (async () => {
      try {
        const items = await getEquipment(false);
        if (cancelled) return;
        const filtered = currentSite
          ? items.filter((e) => e.site_id === currentSite.id)
          : items;
        setEquipmentList(filtered);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load equipment');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, currentSite, modalContext.equipmentId]);

  const duration = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return diff;
  }, [startDate, endDate]);

  const handleReasonChange = (value: string) => {
    setReason(value);
    const opt = REASON_OPTIONS.find((o) => o.value === value);
    if (opt) setDescription(opt.defaultDescription);
  };

  const handleSave = async () => {
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

    setIsSubmitting(true);
    setError(null);
    try {
      await createEquipmentBlock({
        equipment_id: equipmentId,
        start_date: startDate,
        end_date: endDate,
        reason,
        description: description.trim() || (REASON_OPTIONS.find((o) => o.value === reason)?.defaultDescription ?? 'Unavailable'),
      });
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to block equipment');
    } finally {
      setIsSubmitting(false);
    }
  };

  const footer = (
    <div className={styles.footer}>
      <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button variant="primary" onClick={handleSave} disabled={isSubmitting}>
        {isSubmitting ? 'Blocking...' : 'Block Equipment'}
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="Block Equipment"
      size="sm"
      footer={footer}
    >
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formGroup}>
        <label className={styles.label}>Equipment</label>
        <select
          className={styles.input}
          value={equipmentId ?? ''}
          onChange={(e) => setEquipmentId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select equipment…</option>
          {equipmentList.map((eq) => (
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
        Blocked equipment is unavailable for new project bookings during this period — same as staff vacations.
      </p>
    </Modal>
  );
}
