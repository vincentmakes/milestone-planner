/**
 * Company Event Modal
 * Modal for adding company events (non-working-day markers like ISO audits, meetings, etc.)
 * Accessed from the Company Events section in Staff View
 */

import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { createCompanyEvent, getCompanyEvents, buildEventDateSet } from '@/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import styles from './CustomHolidayModal.module.css'; // Reuse same styles

export function CompanyEventModal() {
  const { activeModal, closeModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);
  const setCompanyEvents = useAppStore((s) => s.setCompanyEvents);
  
  const isOpen = activeModal === 'companyEvent';
  
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
      setError('Please enter an event name');
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
      await createCompanyEvent(currentSite.id, {
        name: name.trim(),
        date: startDate,
        end_date: endDate || undefined,
      });
      
      // Reload events
      const events = await getCompanyEvents(currentSite.id);
      const eventDates = buildEventDateSet(events);
      setCompanyEvents(events, eventDates);
      
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add company event');
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
        {isSubmitting ? 'Adding...' : 'Add Event'}
      </Button>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="Add Company Event"
      size="sm"
      footer={footer}
    >
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      <div className={styles.formGroup}>
        <label className={styles.label}>Event Name</label>
        <input
          type="text"
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., ISO Audit, All-Hands Meeting"
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
        Company events are shown as red markers on the timeline. Unlike holidays, they do not affect working day calculations. Leave end date empty for a single-day event.
      </p>
    </Modal>
  );
}
