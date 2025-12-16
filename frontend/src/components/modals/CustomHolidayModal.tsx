/**
 * Custom Holiday Modal
 * Modal for adding custom bank holidays to the current site
 * Accessed from the Bank Holidays section in Staff View
 */

import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { addCustomHoliday, getBankHolidays, buildHolidayDateSet } from '@/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import styles from './CustomHolidayModal.module.css';

export function CustomHolidayModal() {
  const { activeModal, closeModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  
  const isOpen = activeModal === 'customHoliday';
  
  // Form state
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  // Status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setStartDate('');
      setEndDate('');
      setError(null);
    }
  }, [isOpen]);
  
  // Handle save
  const handleSave = async () => {
    if (!currentSite) {
      setError('No site selected');
      return;
    }
    
    if (!name.trim()) {
      setError('Please enter a holiday name');
      return;
    }
    
    if (!startDate) {
      setError('Please select a start date');
      return;
    }
    
    // Validate end date if provided
    if (endDate && endDate < startDate) {
      setError('End date must be on or after start date');
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      await addCustomHoliday(currentSite.id, {
        name: name.trim(),
        date: startDate,
        end_date: endDate || undefined,
      });
      
      // Reload holidays
      const holidays = await getBankHolidays(currentSite.id);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
      
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add custom holiday');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Footer buttons
  const footer = (
    <div className={styles.footer}>
      <Button variant="secondary" onClick={closeModal}>
        Cancel
      </Button>
      <Button 
        variant="primary" 
        onClick={handleSave}
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Adding...' : 'Add Holiday'}
      </Button>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="Add Custom Holiday"
      size="sm"
      footer={footer}
    >
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      <div className={styles.formGroup}>
        <label className={styles.label}>Holiday Name</label>
        <input
          type="text"
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Company Anniversary"
          autoFocus
        />
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
      
      <p className={styles.help}>
        Leave end date empty for a single-day holiday. Custom holidays will be applied to {currentSite?.name || 'the current site'} only.
      </p>
    </Modal>
  );
}
