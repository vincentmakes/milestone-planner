/**
 * VacationModal - Create/Edit Staff Vacations
 * Supports date range selection and ICS export
 */

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { 
  createVacation, 
  updateVacation, 
  getVacations,
} from '@/api/endpoints/vacations';
import { toInputDateFormat } from '@/utils/date';
import styles from './VacationModal.module.css';

// Memoized footer to prevent re-renders
const ModalFooter = memo(function ModalFooter({
  onCancel,
  onSaveAndExport,
  onSave,
  isSubmitting,
  canSubmit,
}: {
  onCancel: () => void;
  onSaveAndExport: () => void;
  onSave: () => void;
  isSubmitting: boolean;
  canSubmit: boolean;
}) {
  return (
    <div className={styles.footer}>
      <Button
        type="button"
        variant="secondary"
        onClick={onCancel}
        disabled={isSubmitting}
      >
        Cancel
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={onSaveAndExport}
        disabled={isSubmitting || !canSubmit}
        title="Save vacation and export to Outlook calendar"
        className={styles.exportBtn}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Save & Export to Outlook
      </Button>
      <Button
        type="button"
        variant="primary"
        onClick={onSave}
        disabled={isSubmitting || !canSubmit}
      >
        {isSubmitting ? 'Saving...' : 'Save'}
      </Button>
    </div>
  );
});

export function VacationModal() {
  const { activeModal, editingVacation, modalContext, closeModal } = useUIStore();
  const { staff, setVacations } = useAppStore();
  
  const isOpen = activeModal === 'vacation';
  const isEditing = !!editingVacation;
  
  // Form state
  const [staffId, setStaffId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Use ref for description to avoid re-renders on typing
  const descriptionRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);
  
  // Get staff member for display - memoized
  const staffMember = useMemo(() => {
    if (!staffId) return null;
    return staff.find(s => s.id === staffId);
  }, [staff, staffId]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
      
      if (editingVacation) {
        setStaffId(editingVacation.staff_id);
        setStartDate(toInputDateFormat(editingVacation.start_date));
        setEndDate(toInputDateFormat(editingVacation.end_date));
        if (descriptionRef.current) {
          descriptionRef.current.value = editingVacation.description || '';
        }
      } else {
        setStaffId(modalContext.staffId || null);
        
        const today = new Date();
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
        const nextFriday = new Date(nextMonday);
        nextFriday.setDate(nextMonday.getDate() + 4);
        
        setStartDate(toInputDateFormat(nextMonday.toISOString()));
        setEndDate(toInputDateFormat(nextFriday.toISOString()));
        if (descriptionRef.current) {
          descriptionRef.current.value = '';
        }
      }
      setError(null);
    }
    
    if (!isOpen) {
      initializedRef.current = false;
    }
  }, [isOpen, editingVacation, modalContext.staffId]);
  
  // Calculate duration
  const duration = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    return diffDays;
  }, [startDate, endDate]);
  
  const handleClose = useCallback(() => {
    closeModal();
    setError(null);
  }, [closeModal]);
  
  const saveVacation = useCallback(async (): Promise<boolean> => {
    const description = descriptionRef.current?.value || '';
    
    if (!staffId) {
      setError('No staff member selected');
      return false;
    }
    
    if (!startDate || !endDate) {
      setError('Please select start and end dates');
      return false;
    }
    
    if (new Date(startDate) > new Date(endDate)) {
      setError('Start date must be before end date');
      return false;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const vacationData = {
        staff_id: staffId,
        start_date: startDate,
        end_date: endDate,
        description: description || 'Vacation',
      };
      
      if (isEditing && editingVacation) {
        await updateVacation(editingVacation.id, vacationData);
      } else {
        await createVacation(vacationData);
      }
      
      const updatedVacations = await getVacations();
      setVacations(updatedVacations);
      
      return true;
    } catch (err) {
      console.error('Failed to save vacation:', err);
      setError(err instanceof Error ? err.message : 'Failed to save vacation');
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [staffId, startDate, endDate, isEditing, editingVacation, setVacations]);
  
  const handleSave = useCallback(async () => {
    const success = await saveVacation();
    if (success) {
      handleClose();
    }
  }, [saveVacation, handleClose]);
  
  const exportICS = useCallback(() => {
    const staffName = staffMember?.name || 'Staff';
    const description = descriptionRef.current?.value || 'Vacation';
    
    const icsContent = generateICS({
      summary: description,
      description: `${staffName} - Time Off`,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      isAllDay: true,
    });
    
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vacation-${staffName.replace(/\s+/g, '-').toLowerCase()}-${startDate}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [staffMember?.name, startDate, endDate]);
  
  const handleSaveAndExport = useCallback(async () => {
    const success = await saveVacation();
    if (success) {
      exportICS();
      handleClose();
    }
  }, [saveVacation, exportICS, handleClose]);
  
  const canSubmit = !!staffId && !!startDate && !!endDate;
  
  // Memoize the footer component props
  const footerElement = useMemo(() => (
    <ModalFooter
      onCancel={handleClose}
      onSaveAndExport={handleSaveAndExport}
      onSave={handleSave}
      isSubmitting={isSubmitting}
      canSubmit={canSubmit}
    />
  ), [handleClose, handleSaveAndExport, handleSave, isSubmitting, canSubmit]);
  
  if (!isOpen) return null;
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isEditing ? 'Edit Vacation' : 'Add Vacation'}
      size="md"
      footer={footerElement}
    >
      <div className={styles.content}>
        {error && (
          <div className={styles.error}>{error}</div>
        )}
        
        {/* Staff Member Display */}
        {staffMember ? (
          <div className={styles.staffDisplay}>
            <div className={styles.staffAvatar}>
              {staffMember.name?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className={styles.staffInfo}>
              <div className={styles.staffName}>{staffMember.name}</div>
              {staffMember.role && (
                <div className={styles.staffRole}>{staffMember.role}</div>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.noStaff}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M20 21a8 8 0 1 0-16 0" />
            </svg>
            <span>No staff member selected</span>
          </div>
        )}
        
        {/* Date Selection */}
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Duration</label>
          <div className={styles.dateRow}>
            <div className={styles.dateField}>
              <label className={styles.label}>From</label>
              <input
                type="date"
                className={styles.input}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            
            <div className={styles.dateSeparator}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </div>
            
            <div className={styles.dateField}>
              <label className={styles.label}>To</label>
              <input
                type="date"
                className={styles.input}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          
          {duration > 0 && (
            <div className={styles.duration}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              {duration} day{duration !== 1 ? 's' : ''}
            </div>
          )}
        </div>
        
        {/* Description - using uncontrolled input with ref */}
        <div className={styles.section}>
          <label className={styles.sectionLabel} htmlFor="vacation-description">
            Description <span className={styles.optional}>(optional)</span>
          </label>
          <input
            ref={descriptionRef}
            id="vacation-description"
            type="text"
            className={styles.input}
            defaultValue={editingVacation?.description || ''}
            placeholder="e.g., Annual Leave, Personal Day..."
            autoComplete="off"
          />
        </div>
      </div>
    </Modal>
  );
}

// Helper function to generate ICS file content
function generateICS(options: {
  summary: string;
  description: string;
  startDate: Date;
  endDate: Date;
  isAllDay: boolean;
}): string {
  const { summary, description, startDate, endDate, isAllDay } = options;
  
  const formatDate = (date: Date, allDay: boolean): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    if (allDay) {
      return `${year}${month}${day}`;
    }
    
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
  };
  
  const adjustedEndDate = new Date(endDate);
  if (isAllDay) {
    adjustedEndDate.setDate(adjustedEndDate.getDate() + 1);
  }
  
  const uid = `vacation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@milestone`;
  const now = formatDate(new Date(), false);
  
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Milestone//Vacation Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    isAllDay 
      ? `DTSTART;VALUE=DATE:${formatDate(startDate, true)}`
      : `DTSTART:${formatDate(startDate, false)}`,
    isAllDay
      ? `DTEND;VALUE=DATE:${formatDate(adjustedEndDate, true)}`
      : `DTEND:${formatDate(adjustedEndDate, false)}`,
    `SUMMARY:${escapeICS(summary)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'X-MICROSOFT-CDO-BUSYSTATUS:OOF',
    'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  
  return lines.join('\r\n');
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}
