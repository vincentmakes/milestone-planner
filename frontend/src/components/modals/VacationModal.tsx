/**
 * VacationModal - Create/Edit Staff Vacations
 * Supports date range selection, ICS export, ICS import, and recurring patterns
 */

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore, selectCanManageResources } from '@/stores/appStore';
import { 
  createVacation, 
  updateVacation, 
  getVacations,
} from '@/api/endpoints/vacations';
import { toInputDateFormat } from '@/utils/date';
import { 
  parseRecurringPattern, 
  createRecurringPattern, 
  getRecurringDaysDisplay,
  DAY_NAMES,
} from '@/utils/recurringVacation';
import styles from './VacationModal.module.css';

// Parsed ICS event structure
interface ParsedEvent {
  summary: string;
  startDate: string;
  endDate: string;
  selected: boolean;
}

// Normalize ICS content - handles UTF-16 encoding (SAP exports)
function normalizeICSContent(content: string): string {
  // Check for UTF-16 by looking for null bytes (appear as \x00 or char code 0)
  // UTF-16 files have null bytes between ASCII characters
  if (content.includes('\x00') || content.charCodeAt(1) === 0) {
    // Remove null bytes - this handles UTF-16 LE where nulls come after each char
    content = content.replace(/\x00/g, '');
  }
  
  // Also handle any BOM (Byte Order Mark)
  content = content.replace(/^\uFEFF/, '').replace(/^\uFFFE/, '');
  
  return content;
}

// ICS Parser function
function parseICSFile(content: string): ParsedEvent[] {
  // Normalize content first (handles UTF-16 encoding from SAP etc.)
  content = normalizeICSContent(content);
  
  const events: ParsedEvent[] = [];
  const lines = content.replace(/\r\n /g, '').split(/\r?\n/);
  
  let inEvent = false;
  let currentEvent: Partial<ParsedEvent> = {};
  
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = { selected: true };
    } else if (line === 'END:VEVENT') {
      inEvent = false;
      if (currentEvent.startDate && currentEvent.endDate) {
        events.push({
          summary: currentEvent.summary || 'Vacation',
          startDate: currentEvent.startDate,
          endDate: currentEvent.endDate,
          selected: true,
        });
      }
      currentEvent = {};
    } else if (inEvent) {
      // Parse DTSTART
      if (line.startsWith('DTSTART')) {
        const dateStr = extractDateFromLine(line);
        if (dateStr) currentEvent.startDate = dateStr;
      }
      // Parse DTEND
      else if (line.startsWith('DTEND')) {
        const dateStr = extractDateFromLine(line);
        if (dateStr) {
          // ICS end dates for all-day events are exclusive, so subtract 1 day
          const isAllDay = line.includes('VALUE=DATE:') || !line.includes('T');
          if (isAllDay) {
            const d = new Date(dateStr);
            d.setDate(d.getDate() - 1);
            currentEvent.endDate = d.toISOString().split('T')[0];
          } else {
            currentEvent.endDate = dateStr;
          }
        }
      }
      // Parse SUMMARY
      else if (line.startsWith('SUMMARY:')) {
        currentEvent.summary = unescapeICS(line.substring(8));
      }
    }
  }
  
  return events;
}

// Extract date from ICS date line
function extractDateFromLine(line: string): string | null {
  // Handle VALUE=DATE: format (all-day events)
  const allDayMatch = line.match(/VALUE=DATE:(\d{8})/);
  if (allDayMatch) {
    const dateStr = allDayMatch[1];
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  
  // Handle regular date/datetime formats
  const dateMatch = line.match(/:(\d{8})(T\d{6}Z?)?/);
  if (dateMatch) {
    const dateStr = dateMatch[1];
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  
  return null;
}

// Unescape ICS text
function unescapeICS(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Memoized footer to prevent re-renders
const ModalFooter = memo(function ModalFooter({
  onCancel,
  onSaveAndExport,
  onSave,
  isSubmitting,
  canSubmit,
  isImportMode,
  importCount,
}: {
  onCancel: () => void;
  onSaveAndExport: () => void;
  onSave: () => void;
  isSubmitting: boolean;
  canSubmit: boolean;
  isImportMode: boolean;
  importCount: number;
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
      {!isImportMode && (
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
      )}
      <Button
        type="button"
        variant="primary"
        onClick={onSave}
        disabled={isSubmitting || !canSubmit}
      >
        {isSubmitting ? 'Saving...' : isImportMode ? `Import ${importCount} vacation${importCount !== 1 ? 's' : ''}` : 'Save'}
      </Button>
    </div>
  );
});

export function VacationModal() {
  const { activeModal, editingVacation, modalContext, closeModal } = useUIStore();
  const { staff, setVacations } = useAppStore();
  const canManageResources = useAppStore(selectCanManageResources);
  
  const isOpen = activeModal === 'vacation';
  const isEditing = !!editingVacation;
  
  // Form state
  const [staffId, setStaffId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Recurring vacation state
  const [isRecurring, setIsRecurring] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  
  // ICS Import state
  const [importMode, setImportMode] = useState(false);
  const [parsedEvents, setParsedEvents] = useState<ParsedEvent[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Use ref for description to avoid re-renders on typing
  const descriptionRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);
  
  // Get staff member for display - memoized
  const staffMember = useMemo(() => {
    if (!staffId) return null;
    return staff.find(s => s.id === staffId);
  }, [staff, staffId]);
  
  // Count selected events for import
  const selectedEventsCount = useMemo(() => {
    return parsedEvents.filter(e => e.selected).length;
  }, [parsedEvents]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
      setImportMode(false);
      setParsedEvents([]);
      
      if (editingVacation) {
        setStaffId(editingVacation.staff_id);
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
        setIsRecurring(false);
        setSelectedDays([]);
        
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
    setImportMode(false);
    setParsedEvents([]);
  }, [closeModal]);
  
  // Handle ICS file selection
  const handleFileSelect = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.ics')) {
      setError('Please select an ICS file');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        const events = parseICSFile(content);
        if (events.length === 0) {
          setError('No events found in the ICS file');
          return;
        }
        setParsedEvents(events);
        setImportMode(true);
        setError(null);
      } catch (err) {
        console.error('Failed to parse ICS:', err);
        setError('Failed to parse ICS file');
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  }, []);
  
  // File input change handler
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [handleFileSelect]);
  
  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);
  
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);
  
  // Toggle event selection
  const toggleEventSelection = useCallback((index: number) => {
    setParsedEvents(prev => prev.map((e, i) => 
      i === index ? { ...e, selected: !e.selected } : e
    ));
  }, []);
  
  // Select/deselect all events
  const toggleAllEvents = useCallback((selected: boolean) => {
    setParsedEvents(prev => prev.map(e => ({ ...e, selected })));
  }, []);
  
  const saveVacation = useCallback(async (): Promise<boolean> => {
    const rawDescription = descriptionRef.current?.value || '';
    
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
    
    // Validate recurring selection
    if (isRecurring && selectedDays.length === 0) {
      setError('Please select at least one day for the recurring pattern');
      return false;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Build description with recurring pattern if applicable
      const description = isRecurring 
        ? createRecurringPattern(selectedDays, rawDescription || 'Recurring absence')
        : (rawDescription || 'Vacation');
      
      const vacationData = {
        staff_id: staffId,
        start_date: startDate,
        end_date: endDate,
        description,
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
  }, [staffId, startDate, endDate, isEditing, editingVacation, setVacations, isRecurring, selectedDays]);
  
  // Import vacations from parsed ICS events
  const importVacations = useCallback(async (): Promise<boolean> => {
    if (!staffId) {
      setError('No staff member selected');
      return false;
    }
    
    const selectedEvents = parsedEvents.filter(e => e.selected);
    if (selectedEvents.length === 0) {
      setError('No events selected for import');
      return false;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Create vacations sequentially to avoid race conditions
      for (const event of selectedEvents) {
        await createVacation({
          staff_id: staffId,
          start_date: event.startDate,
          end_date: event.endDate,
          description: event.summary || 'Vacation',
        });
      }
      
      const updatedVacations = await getVacations();
      setVacations(updatedVacations);
      
      return true;
    } catch (err) {
      console.error('Failed to import vacations:', err);
      setError(err instanceof Error ? err.message : 'Failed to import vacations');
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [staffId, parsedEvents, setVacations]);
  
  const handleSave = useCallback(async () => {
    const success = importMode ? await importVacations() : await saveVacation();
    if (success) {
      handleClose();
    }
  }, [importMode, importVacations, saveVacation, handleClose]);
  
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
  
  // Cancel import mode
  const handleCancelImport = useCallback(() => {
    setImportMode(false);
    setParsedEvents([]);
    setError(null);
  }, []);
  
  const canSubmit = importMode 
    ? !!staffId && selectedEventsCount > 0 
    : !!staffId && !!startDate && !!endDate;
  
  // Memoize the footer component props
  const footerElement = useMemo(() => (
    <ModalFooter
      onCancel={handleClose}
      onSaveAndExport={handleSaveAndExport}
      onSave={handleSave}
      isSubmitting={isSubmitting}
      canSubmit={canSubmit}
      isImportMode={importMode}
      importCount={selectedEventsCount}
    />
  ), [handleClose, handleSaveAndExport, handleSave, isSubmitting, canSubmit, importMode, selectedEventsCount]);
  
  if (!isOpen) return null;
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isEditing ? 'Edit Vacation' : importMode ? 'Import Vacations from ICS' : 'Add Vacation'}
      size="md"
      footer={footerElement}
    >
      <div className={styles.content}>
        {error && (
          <div className={styles.error}>{error}</div>
        )}
        
        {/* Staff Member Display or Selector */}
        {canManageResources && !isEditing ? (
          <div className={styles.section}>
            <label className={styles.sectionLabel}>Staff Member</label>
            <select
              className={styles.select}
              value={staffId || ''}
              onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select staff member...</option>
              {staff.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="8" r="4" />
              <path d="M20 21a8 8 0 1 0-16 0" />
            </svg>
            <span>No staff member selected</span>
          </div>
        )}
        
        {importMode ? (
          /* Import Mode: Show parsed events */
          <>
            <div className={styles.section}>
              <div className={styles.importHeader}>
                <label className={styles.sectionLabel}>
                  Events to Import ({selectedEventsCount} of {parsedEvents.length} selected)
                </label>
                <div className={styles.importActions}>
                  <button 
                    type="button" 
                    className={styles.linkBtn}
                    onClick={() => toggleAllEvents(true)}
                  >
                    Select All
                  </button>
                  <span className={styles.actionSeparator}>|</span>
                  <button 
                    type="button" 
                    className={styles.linkBtn}
                    onClick={() => toggleAllEvents(false)}
                  >
                    Deselect All
                  </button>
                  <span className={styles.actionSeparator}>|</span>
                  <button 
                    type="button" 
                    className={styles.linkBtn}
                    onClick={handleCancelImport}
                  >
                    Cancel Import
                  </button>
                </div>
              </div>
              
              <div className={styles.eventsList}>
                {parsedEvents.map((event, index) => (
                  <label key={index} className={`${styles.eventItem} ${event.selected ? styles.selected : ''}`}>
                    <input
                      type="checkbox"
                      checked={event.selected}
                      onChange={() => toggleEventSelection(index)}
                      className={styles.eventCheckbox}
                    />
                    <div className={styles.eventInfo}>
                      <div className={styles.eventSummary}>{event.summary}</div>
                      <div className={styles.eventDates}>
                        {formatEventDate(event.startDate)} - {formatEventDate(event.endDate)}
                        <span className={styles.eventDuration}>
                          ({calculateDays(event.startDate, event.endDate)} day{calculateDays(event.startDate, event.endDate) !== 1 ? 's' : ''})
                        </span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* Normal Mode: Date selection and ICS upload */
          <>
            {/* ICS Import Drop Zone - only show when creating new */}
            {!isEditing && (
              <div 
                className={`${styles.dropZone} ${isDragging ? styles.dragging : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ics"
                  onChange={handleFileInputChange}
                  className={styles.fileInput}
                />
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className={styles.dropZoneText}>
                  Drop ICS file here or click to browse
                </span>
                <span className={styles.dropZoneHint}>
                  Import vacation dates from Outlook or other calendar apps
                </span>
              </div>
            )}
            
            <div className={styles.dividerRow}>
              <span className={styles.dividerLine}></span>
              <span className={styles.dividerText}>{isEditing ? '' : 'or enter manually'}</span>
              <span className={styles.dividerLine}></span>
            </div>
            
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
            
            {/* Recurring Toggle */}
            <div className={styles.section}>
              <label className={styles.recurringToggle}>
                <input
                  type="checkbox"
                  checked={isRecurring}
                  onChange={(e) => {
                    setIsRecurring(e.target.checked);
                    if (!e.target.checked) {
                      setSelectedDays([]);
                    }
                  }}
                  className={styles.checkbox}
                />
                <span className={styles.recurringLabel}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 1l4 4-4 4" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <path d="M7 23l-4-4 4-4" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                  Recurring Absence
                </span>
              </label>
              
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
              <input
                ref={descriptionRef}
                id="vacation-description"
                type="text"
                className={styles.input}
                defaultValue={editingVacation?.description || ''}
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

// Helper function to format event date for display
function formatEventDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
}

// Helper function to calculate days between dates
function calculateDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
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
  
  const uid = `vacation-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(36)).join('').slice(0, 9)}@milestone`;
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
