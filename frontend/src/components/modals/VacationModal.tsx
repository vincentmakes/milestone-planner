/**
 * VacationModal - Create/Edit Staff Absences
 * Supports date range selection, absence types, ICS export, ICS import (via the
 * shared ICSImportPanel), and recurring patterns
 */

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { DateRangeField } from '@/components/common/DateRangeField';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore, selectCanManageOthersAbsences } from '@/stores/appStore';
import { 
  createVacation, 
  updateVacation, 
  getVacations,
} from '@/api/endpoints/vacations';
import { toInputDateFormat, formatDateISO, daysBetweenDateStrings } from '@/utils/date';
import { 
  parseRecurringPattern, 
  createRecurringPattern, 
  getRecurringDaysDisplay,
  DAY_NAMES,
} from '@/utils/recurringVacation';
import { defaultAbsenceTypeId } from '@/utils/recurringVacation';
import { buildICS, downloadICS } from '@/utils/ics';
import { uniqueById } from '@/utils/uniqueById';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { AbsenceTypeSelect } from './AbsenceTypeSelect';
import { VacationICSImport } from './VacationICSImport';
import styles from './VacationModal.module.css';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Icon, RepeatIcon, CalendarIcon, ArrowRightIcon, PersonIcon, DownloadIcon } from '@/components/common/Icon';

// Memoized footer to prevent re-renders
const ModalFooter = memo(function ModalFooter({
  onCancel,
  onSaveAndExport,
  onSave,
  isSubmitting,
  canSubmit,
  blockedReason,
  isImportMode,
}: {
  onCancel: () => void;
  onSaveAndExport: () => void;
  onSave: () => void;
  isSubmitting: boolean;
  canSubmit: boolean;
  /** Set while creating is unavailable (What-If mode) */
  blockedReason: string | null;
  isImportMode: boolean;
}) {
  // Import mode: the ICS panel has its own Import button; the footer only closes.
  if (isImportMode) {
    return (
      <div className={styles.footer}>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

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
        disabled={isSubmitting || !canSubmit || !!blockedReason}
        title={blockedReason ?? 'Save the absence and export it to your Outlook calendar'}
        className={styles.exportBtn}
      >
        <Icon icon={DownloadIcon} size={14} />
        Save & Export to Outlook
      </Button>
      <Button
        type="button"
        variant="primary"
        onClick={onSave}
        disabled={isSubmitting || !canSubmit || !!blockedReason}
        title={blockedReason ?? undefined}
        loading={isSubmitting}
      >
        Save
      </Button>
    </div>
  );
});

export function VacationModal() {
  const { activeModal, editingVacation, modalContext, closeModal, openModal } = useUIStore();
  const staff = useAppStore((s) => s.staff);
  const currentUser = useAppStore((s) => s.currentUser);
  const absenceTypes = useAppStore((s) => s.absenceTypes);
  const setVacations = useAppStore((s) => s.setVacations);
  const canManageResources = useAppStore(selectCanManageOthersAbsences);
  
  const isOpen = activeModal === 'vacation';
  const isEditing = !!editingVacation;
  // A create during What-If would only be queued and stay invisible until
  // Apply (absences are not part of the What-If snapshot); edits stay allowed.
  const whatIf = useWhatIfBlocked();
  const createBlockedReason = !isEditing && whatIf.blocked ? whatIf.reason('Adding absences') : null;
  // GET /staff returns one row per user-site pair: list each person once
  const staffOptions = useMemo(() => uniqueById(staff), [staff]);
  // The picker's rows (searched by name and job title); its empty first row
  // stays a real, selectable choice (as before).
  const staffSelectOptions = useMemo(
    () => staffOptions.map((s) => ({ id: s.id, label: s.name, hint: s.role })),
    [staffOptions]
  );
  
  // Form state
  const [staffId, setStaffId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  const [absenceTypeId, setAbsenceTypeId] = useState<number | null>(null);
  
  // Recurring vacation state
  const [isRecurring, setIsRecurring] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  
  // ICS import mode (creating only) - the shared panel does the rest
  const [importMode, setImportMode] = useState(false);
  
  // Use ref for description to avoid re-renders on typing
  const descriptionRef = useRef<HTMLInputElement>(null);
  // The description input unmounts while the Import .ics tab is shown; keep
  // what was typed so "Enter manually" brings it back.
  const descriptionDraftRef = useRef('');
  const initializedRef = useRef(false);
  
  // Get staff member for display - memoized. The signed-in user may not be in
  // the current site's staff list (My absences), so fall back to them.
  const staffMember = useMemo(() => {
    if (!staffId) return null;
    const member = staff.find(s => s.id === staffId);
    if (member) return member;
    if (currentUser && currentUser.id === staffId) {
      return { id: currentUser.id, name: currentUser.name, role: currentUser.job_title };
    }
    return null;
  }, [staff, staffId, currentUser]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
      setImportMode(false);
      descriptionDraftRef.current = '';
      
      if (editingVacation) {
        setStaffId(editingVacation.staff_id);
        setAbsenceTypeId(editingVacation.absence_type_id ?? null);
        setStartDate(toInputDateFormat(editingVacation.start_date));
        setEndDate(toInputDateFormat(editingVacation.end_date));
        
        // Parse recurring pattern from description
        const pattern = parseRecurringPattern(editingVacation.description);
        if (pattern) {
          setIsRecurring(true);
          setSelectedDays(pattern.daysOfWeek);
          if (descriptionRef.current) {
            descriptionRef.current.value = pattern.cleanDescription;
          }
        } else {
          setIsRecurring(false);
          setSelectedDays([]);
          if (descriptionRef.current) {
            descriptionRef.current.value = editingVacation.description || '';
          }
        }
      } else {
        setStaffId(modalContext.staffId || null);
        setAbsenceTypeId(defaultAbsenceTypeId(useAppStore.getState().absenceTypes));
        setIsRecurring(false);
        setSelectedDays([]);
        
        const today = new Date();
        const nextMonday = new Date(today);
        nextMonday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
        const nextFriday = new Date(nextMonday);
        nextFriday.setDate(nextMonday.getDate() + 4);
        
        setStartDate(formatDateISO(nextMonday));
        setEndDate(formatDateISO(nextFriday));
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
    return daysBetweenDateStrings(startDate, endDate) + 1;
  }, [startDate, endDate]);
  
  const returnTo = modalContext.returnTo;
  const handleClose = useCallback(() => {
    closeModal();
    // Opened from another dialog (My absences): go back to it
    if (returnTo) openModal(returnTo);
    setError(null);
    setImportMode(false);
    descriptionDraftRef.current = '';
  }, [closeModal, openModal, returnTo]);
  
  const saveVacation = useCallback(async (): Promise<boolean> => {
    const rawDescription = descriptionRef.current?.value || '';
    
    if (createBlockedReason) {
      setError(createBlockedReason);
      return false;
    }
    
    if (!staffId) {
      setError('No staff member selected');
      return false;
    }
    
    // Validate recurring selection
    if (isRecurring && selectedDays.length === 0) {
      setError('Please select at least one day for the recurring pattern');
      return false;
    }
    
    if (!beginSubmit()) return false;
    setError(null);
    
    try {
      // Build description with recurring pattern if applicable; an empty
      // description falls back to the absence type name
      const typeName = absenceTypes.find(t => t.id === absenceTypeId)?.name;
      const description = isRecurring 
        ? createRecurringPattern(selectedDays, rawDescription || typeName || 'Recurring absence')
        : (rawDescription || typeName || 'Vacation');
      
      const vacationData = {
        staff_id: staffId,
        start_date: startDate,
        end_date: endDate,
        description,
        absence_type_id: absenceTypeId,
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
      endSubmit();
    }
  }, [staffId, startDate, endDate, isEditing, editingVacation, setVacations, isRecurring, selectedDays, absenceTypes, absenceTypeId, createBlockedReason, beginSubmit, endSubmit]);
  
  const handleSave = useCallback(async () => {
    const success = await saveVacation();
    if (success) {
      handleClose();
    }
  }, [saveVacation, handleClose]);
  
  const exportICS = useCallback(() => {
    const staffName = staffMember?.name || 'Staff';
    const typeName = absenceTypes.find(t => t.id === absenceTypeId)?.name;
    const description = descriptionRef.current?.value || typeName || 'Vacation';
    
    const icsContent = buildICS(
      [{
        summary: description,
        description: `${staffName} - Time Off`,
        start_date: startDate,
        end_date: endDate,
        busyStatus: 'OOF',
      }],
      'Vacation Export',
    );
    
    downloadICS(icsContent, `vacation-${staffName.replace(/\s+/g, '-').toLowerCase()}-${startDate}.ics`);
  }, [staffMember?.name, startDate, endDate, absenceTypes, absenceTypeId]);
  
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
      blockedReason={createBlockedReason}
      isImportMode={importMode}
    />
  ), [handleClose, handleSaveAndExport, handleSave, isSubmitting, canSubmit, createBlockedReason, importMode]);
  
  if (!isOpen) return null;
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isEditing ? 'Edit Absence' : importMode ? 'Import Absences from .ics' : 'Add Absence'}
      size={importMode ? 'lg' : 'md'}
      footer={footerElement}
    >
      <div className={styles.content}>
        {createBlockedReason && !importMode && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && (
          <div className={styles.error}>{error}</div>
        )}
        
        {/* Staff Member Display or Selector */}
        {canManageResources && !isEditing ? (
          <SearchableSelect
            label="Staff Member"
            value={staffId}
            onChange={setStaffId}
            options={staffSelectOptions}
            emptyLabel="Select staff member…"
            fullWidth
          />
        ) : staffMember ? (
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
            <Icon icon={PersonIcon} size={20} />
            <span>No staff member selected</span>
          </div>
        )}
        
        {/* Manual entry / .ics import switch - creating only */}
        {!isEditing && (
          <div className={styles.modeSwitch} role="tablist" aria-label="How to add the absence">
            <button
              type="button"
              role="tab"
              aria-selected={!importMode}
              className={`${styles.modeTab} ${!importMode ? styles.modeTabActive : ''}`}
              onClick={() => setImportMode(false)}
            >
              Enter manually
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={importMode}
              className={`${styles.modeTab} ${importMode ? styles.modeTabActive : ''}`}
              onClick={() => {
                if (descriptionRef.current) descriptionDraftRef.current = descriptionRef.current.value;
                setImportMode(true);
              }}
            >
              Import .ics
            </button>
          </div>
        )}
        
        {importMode ? (
          <VacationICSImport staffId={staffId} />
        ) : (
          /* Manual entry */
          <>
            {/* Absence type */}
            <div className={styles.section}>
              <label className={styles.sectionLabel} htmlFor="vacation-absence-type">
                Absence type
              </label>
              <AbsenceTypeSelect
                id="vacation-absence-type"
                value={absenceTypeId}
                onChange={setAbsenceTypeId}
                types={absenceTypes}
              />
            </div>
            
            {/* Date Selection */}
            <div className={styles.section}>
              <label className={styles.sectionLabel}>Duration</label>
              <div className={styles.dateRow}>
                <DateRangeField
                  startLabel="From"
                  endLabel="To"
                  fieldClassName={styles.dateField}
                  start={startDate}
                  end={endDate}
                  onChange={({ start, end }) => {
                    setStartDate(start);
                    setEndDate(end);
                  }}
                  highlightWeekdays={isRecurring ? selectedDays : undefined}
                  separator={
                    <div className={styles.dateSeparator}>
                      <Icon icon={ArrowRightIcon} size={20} />
                    </div>
                  }
                />
              </div>
              
              {duration > 0 && (
                <div className={styles.duration}>
                  <Icon icon={CalendarIcon} size={14} />
                  {duration} day{duration !== 1 ? 's' : ''}
                </div>
              )}
            </div>
            
            {/* Recurring Toggle */}
            <div className={styles.section}>
              <ToggleSwitch
                checked={isRecurring}
                onChange={(checked) => {
                  setIsRecurring(checked);
                  if (!checked) {
                    setSelectedDays([]);
                  }
                }}
                label={
                  <span className={styles.recurringLabel}>
                    <Icon icon={RepeatIcon} size={16} />
                    Recurring Absence
                  </span>
                }
              />
              
              {isRecurring && (
                <div className={styles.recurringOptions}>
                  <div className={styles.recurringHint}>
                    Select which days of the week this person is unavailable within the date range above
                  </div>
                  <div className={styles.daySelector}>
                    {DAY_NAMES.map((day, index) => (
                      <button
                        key={day}
                        type="button"
                        className={`${styles.dayButton} ${selectedDays.includes(index) ? styles.selected : ''}`}
                        onClick={() => {
                          setSelectedDays(prev => 
                            prev.includes(index)
                              ? prev.filter(d => d !== index)
                              : [...prev, index].sort((a, b) => a - b)
                          );
                        }}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  {selectedDays.length > 0 && (
                    <div className={styles.recurringPreview}>
                      {getRecurringDaysDisplay(selectedDays)}
                    </div>
                  )}
                </div>
              )}
            </div>
            
            {/* Description - using uncontrolled input with ref */}
            <div className={styles.section}>
              <label className={styles.sectionLabel} htmlFor="vacation-description">
                Description <span className={styles.optional}>(optional)</span>
              </label>
              <Input
                ref={descriptionRef}
                id="vacation-description"
                type="text"
                fullWidth
                defaultValue={editingVacation ? editingVacation.description || '' : descriptionDraftRef.current}
                placeholder={isRecurring ? "e.g., Part-time, Childcare..." : "e.g., Annual Leave, Personal Day..."}
                autoComplete="off"
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
