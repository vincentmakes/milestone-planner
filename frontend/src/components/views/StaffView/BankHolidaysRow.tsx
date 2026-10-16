/**
 * Bank Holidays Row Component
 * Expandable row showing all bank holidays with actions
 * - Add custom holiday button / click a holiday to edit it (Settings hub)
 * - Delete holidays (Nager holidays come back on the next refresh)
 * - Export to ICS
 */

import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { deleteCustomHoliday, getBankHolidays, buildHolidayDateSet } from '@/api';
import { buildICS, downloadICS } from '@/utils/ics';
import styles from './StaffView.module.css';
import { parseLocalDate } from '@/utils/date';

interface BankHolidaysRowProps {
  isExpanded: boolean;
  onToggle?: () => void;
}

export function BankHolidaysRow({ isExpanded, onToggle }: BankHolidaysRowProps) {
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const openSettings = useUIStore((s) => s.openSettings);
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Group holidays by year
  const holidaysByYear = bankHolidays.reduce((acc, h) => {
    const year = h.year || parseLocalDate(h.date).getFullYear();
    if (!acc[year]) acc[year] = [];
    acc[year].push(h);
    return acc;
  }, {} as Record<number, typeof bankHolidays>);
  
  // Format date for display using browser locale
  const formatHolidayDate = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    return date.toLocaleDateString(undefined, { 
      weekday: 'short',
      day: 'numeric', 
      month: 'short' 
    });
  };
  
  // Export holidays to ICS
  const exportToICS = () => {
    if (bankHolidays.length === 0) return;
    
    const icsContent = buildICS(
      bankHolidays.map((holiday) => ({
        uid: `bankholiday-${holiday.id}@milestone`,
        summary: holiday.name,
        start_date: holiday.date,
        end_date: holiday.end_date,
        transparency: 'TRANSPARENT' as const,
      })),
      'Bank Holidays',
    );
    downloadICS(icsContent, `bank-holidays-${currentSite?.name || 'site'}.ics`);
  };
  
  // Holidays are managed in the Settings hub
  const handleAddCustom = () => {
    openSettings('bank-holidays', { type: 'add', siteId: currentSite?.id });
  };
  
  const handleEditHoliday = (holidayId: number) => {
    openSettings('bank-holidays', { type: 'edit', id: holidayId, siteId: currentSite?.id });
  };
  
  // Handle deleting a holiday. Nager (public) holidays can be deleted too,
  // but come back the next time the site's holidays are refreshed from Nager.
  const handleDeleteHoliday = async (holidayId: number, isCustom: boolean) => {
    if (!currentSite) return;
    const message = isCustom
      ? 'Delete this custom holiday?'
      : 'Delete this public holiday? It will come back the next time holidays are refreshed from Nager.';
    if (!confirm(message)) return;
    
    try {
      await deleteCustomHoliday(currentSite.id, holidayId);
      
      // Reload holidays
      const holidays = await getBankHolidays(currentSite.id);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
    } catch (err) {
      console.error('Failed to delete holiday:', err);
      alert('Failed to delete holiday');
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
                  className={`${styles.detailRow} ${holiday.is_custom ? styles.customHoliday : ''} ${canEdit ? styles.clickable : ''}`}
                  onClick={canEdit ? () => handleEditHoliday(holiday.id) : undefined}
                  title={canEdit ? 'Edit in Settings' : undefined}
                >
                  <span className={`${styles.detailType} ${styles.bankHoliday}`}>
                    {holiday.is_custom ? 'Custom' : 'Holiday'}
                  </span>
                  <span className={styles.detailName}>{holiday.name}</span>
                  <span className={styles.dateBadge}>{dateDisplay}</span>
                  {canEdit && (
                    <button
                      className={styles.deleteAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteHoliday(holiday.id, !!holiday.is_custom);
                      }}
                      title={holiday.is_custom ? 'Delete custom holiday' : 'Delete holiday (returns on the next Nager refresh)'}
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
