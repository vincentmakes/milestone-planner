/**
 * Bank Holidays Row Component
 * Expandable row showing all bank holidays with actions
 * - Add custom holiday button
 * - Delete custom holidays
 * - Export to ICS
 */

import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { deleteCustomHoliday, getBankHolidays, buildHolidayDateSet } from '@/api';
import styles from './StaffView.module.css';

interface BankHolidaysRowProps {
  isExpanded: boolean;
  onToggle?: () => void;
}

export function BankHolidaysRow({ isExpanded, onToggle }: BankHolidaysRowProps) {
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const { openModal } = useUIStore();
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Group holidays by year
  const holidaysByYear = bankHolidays.reduce((acc, h) => {
    const year = h.year || new Date(h.date).getFullYear();
    if (!acc[year]) acc[year] = [];
    acc[year].push(h);
    return acc;
  }, {} as Record<number, typeof bankHolidays>);
  
  // Format date for display using browser locale
  const formatHolidayDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { 
      weekday: 'short',
      day: 'numeric', 
      month: 'short' 
    });
  };
  
  // Export holidays to ICS
  const exportToICS = () => {
    if (bankHolidays.length === 0) return;
    
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Milestone//Bank Holidays//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    
    bankHolidays.forEach((holiday) => {
      const startDate = holiday.date.replace(/-/g, '');
      // End date is the day after for all-day events
      const endDateObj = new Date(holiday.end_date || holiday.date);
      endDateObj.setDate(endDateObj.getDate() + 1);
      const endDate = endDateObj.toISOString().split('T')[0].replace(/-/g, '');
      
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:bankholiday-${holiday.id}@milestone`);
      lines.push(`DTSTART;VALUE=DATE:${startDate}`);
      lines.push(`DTEND;VALUE=DATE:${endDate}`);
      lines.push(`SUMMARY:${holiday.name.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')}`);
      lines.push('TRANSP:TRANSPARENT');
      lines.push('END:VEVENT');
    });
    
    lines.push('END:VCALENDAR');
    
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bank-holidays-${currentSite?.name || 'site'}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // Handle opening add custom holiday modal
  const handleAddCustom = () => {
    openModal('customHoliday');
  };
  
  // Handle deleting a custom holiday
  const handleDeleteCustom = async (holidayId: number) => {
    if (!currentSite) return;
    if (!confirm('Delete this custom holiday?')) return;
    
    try {
      await deleteCustomHoliday(currentSite.id, holidayId);
      
      // Reload holidays
      const holidays = await getBankHolidays(currentSite.id);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
    } catch (err) {
      console.error('Failed to delete custom holiday:', err);
      alert('Failed to delete custom holiday');
    }
  };
  
  return (
    <div className={styles.bankHolidaysWrapper}>
      {/* Main bank holidays row */}
      <div 
        className={`${styles.staffRow} ${styles.bankHolidaysRow} ${!onToggle ? styles.noExpand : ''}`}
        onClick={onToggle}
        style={{ cursor: onToggle ? 'pointer' : 'default' }}
      >
        {onToggle && (
          <div className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        )}
        <div className={`${styles.status} ${styles.bankHolidayStatus}`} />
        <div className={styles.staffInfo}>
          <div className={styles.staffName}>Bank Holidays</div>
          <div className={styles.staffMeta}>
            <span>{currentSite?.name || 'Site'}</span>
            <span> · </span>
            <span>{bankHolidays.length} holidays</span>
          </div>
        </div>
        <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <button 
            className={styles.iconBtn}
            onClick={exportToICS}
            title="Export to Outlook"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          {canEdit && (
            <button 
              className={styles.iconBtn}
              onClick={handleAddCustom}
              title="Add custom holiday"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* Expanded content - Holiday details */}
      {isExpanded && (
        <div className={styles.expandedContent}>
          {Object.keys(holidaysByYear).sort().map((year) => (
            holidaysByYear[Number(year)].map((holiday) => {
              const dateDisplay = holiday.end_date && holiday.end_date !== holiday.date
                ? `${formatHolidayDate(holiday.date)} - ${formatHolidayDate(holiday.end_date)}`
                : formatHolidayDate(holiday.date);
              
              return (
                <div 
                  key={holiday.id}
                  className={`${styles.detailRow} ${holiday.is_custom ? styles.customHoliday : ''}`}
                >
                  <span className={`${styles.detailType} ${styles.bankHoliday}`}>
                    {holiday.is_custom ? 'Custom' : 'Holiday'}
                  </span>
                  <span className={styles.detailName}>{holiday.name}</span>
                  <span className={styles.dateBadge}>{dateDisplay}</span>
                  {canEdit && holiday.is_custom && (
                    <button
                      className={styles.deleteAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCustom(holiday.id);
                      }}
                      title="Delete custom holiday"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })
          ))}
          
          {bankHolidays.length === 0 && (
            <div className={styles.detailRow}>
              <span className={styles.noAssignments}>No holidays loaded</span>
            </div>
          )}
          
          {/* Add custom holiday row at bottom */}
          {canEdit && (
            <div 
              className={`${styles.detailRow} ${styles.addRow}`}
              onClick={handleAddCustom}
            >
              <span className={styles.addIcon}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span className={styles.addText}>Add custom holiday</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
