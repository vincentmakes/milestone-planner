/**
 * BankHolidayModal - View and manage bank holidays for a site
 * Supports custom holiday creation, deletion, and ICS export
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { 
  getBankHolidays,
  createBankHoliday,
  deleteBankHoliday,
  refreshBankHolidays,
  buildHolidayDateSet,
} from '@/api';
import type { BankHoliday } from '@/types';
import styles from './BankHolidayModal.module.css';

export function BankHolidayModal() {
  const { activeModal, closeModal } = useUIStore();
  const { currentSite, bankHolidays, setBankHolidays } = useAppStore();
  
  const isOpen = activeModal === 'bankHoliday';
  
  // State
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [isLoading, setIsLoading] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Add form state
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayEndDate, setNewHolidayEndDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  
  // Get available years
  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear - 1, currentYear, currentYear + 1, currentYear + 2];
  }, []);
  
  // Filter holidays by selected year
  const filteredHolidays = useMemo(() => {
    return bankHolidays
      .filter(h => {
        const holidayYear = new Date(h.date).getFullYear();
        return holidayYear === selectedYear;
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [bankHolidays, selectedYear]);
  
  // Separate custom and standard holidays
  const customHolidays = filteredHolidays.filter(h => h.is_custom);
  const standardHolidays = filteredHolidays.filter(h => !h.is_custom);
  
  // Load holidays when modal opens or year changes
  useEffect(() => {
    if (isOpen && currentSite) {
      loadHolidays();
    }
  }, [isOpen, currentSite, selectedYear]);
  
  const loadHolidays = async () => {
    if (!currentSite) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const holidays = await getBankHolidays(currentSite.id, selectedYear);
      setBankHolidays(holidays, buildHolidayDateSet(holidays));
    } catch (err) {
      console.error('Failed to load holidays:', err);
      setError('Failed to load holidays');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleRefresh = async () => {
    if (!currentSite) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const holidays = await refreshBankHolidays(currentSite.id);
      setBankHolidays(holidays, buildHolidayDateSet(holidays));
    } catch (err) {
      console.error('Failed to refresh holidays:', err);
      setError('Failed to refresh holidays from API');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleAddCustomHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!currentSite || !newHolidayDate || !newHolidayName) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      await createBankHoliday(currentSite.id, {
        date: newHolidayDate,
        end_date: newHolidayEndDate || undefined,
        name: newHolidayName,
      });
      
      // Reload holidays
      const holidays = await getBankHolidays(currentSite.id);
      setBankHolidays(holidays, buildHolidayDateSet(holidays));
      
      // Reset form
      setNewHolidayDate('');
      setNewHolidayEndDate('');
      setNewHolidayName('');
      setIsAdding(false);
    } catch (err) {
      console.error('Failed to add holiday:', err);
      setError('Failed to add custom holiday');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleDeleteHoliday = async (holiday: BankHoliday) => {
    if (!currentSite) return;
    
    if (!window.confirm(`Delete "${holiday.name}"?`)) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      await deleteBankHoliday(currentSite.id, holiday.id);
      
      // Reload holidays
      const holidays = await getBankHolidays(currentSite.id);
      setBankHolidays(holidays, buildHolidayDateSet(holidays));
    } catch (err) {
      console.error('Failed to delete holiday:', err);
      setError('Failed to delete holiday');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleExportICS = () => {
    if (filteredHolidays.length === 0) return;
    
    const icsContent = generateHolidaysICS(filteredHolidays, currentSite?.name || 'Site');
    
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bank-holidays-${currentSite?.name?.toLowerCase().replace(/\s+/g, '-') || 'site'}-${selectedYear}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  const handleClose = () => {
    closeModal();
    setIsAdding(false);
    setError(null);
  };
  
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { 
      weekday: 'short',
      day: 'numeric', 
      month: 'short',
    });
  };
  
  if (!isOpen) return null;
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={`Bank Holidays - ${currentSite?.name || ''}`}
      size="md"
    >
      <div className={styles.container}>
        {error && (
          <div className={styles.error}>{error}</div>
        )}
        
        {/* Year selector and actions */}
        <div className={styles.toolbar}>
          <div className={styles.yearSelector}>
            <label className={styles.label}>Year:</label>
            <select
              className={styles.select}
              value={selectedYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
            >
              {years.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
          
          <div className={styles.toolbarActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
              title="Refresh from Nager.Date API"
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportICS}
              disabled={filteredHolidays.length === 0}
              title="Export all holidays to ICS"
            >
              Export ICS
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsAdding(true)}
              disabled={isAdding}
            >
              Add Custom
            </Button>
          </div>
        </div>
        
        {/* Add custom holiday form */}
        {isAdding && (
          <form onSubmit={handleAddCustomHoliday} className={styles.addForm}>
            <div className={styles.addFormRow}>
              <input
                type="text"
                className={styles.input}
                placeholder="Holiday name..."
                value={newHolidayName}
                onChange={(e) => setNewHolidayName(e.target.value)}
                required
              />
              <input
                type="date"
                className={styles.input}
                value={newHolidayDate}
                onChange={(e) => setNewHolidayDate(e.target.value)}
                required
              />
              <input
                type="date"
                className={styles.input}
                value={newHolidayEndDate}
                onChange={(e) => setNewHolidayEndDate(e.target.value)}
                placeholder="End date (optional)"
              />
            </div>
            <div className={styles.addFormActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setIsAdding(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={isLoading || !newHolidayName || !newHolidayDate}
              >
                Add
              </Button>
            </div>
          </form>
        )}
        
        {/* Holidays list */}
        <div className={styles.holidaysList}>
          {isLoading && filteredHolidays.length === 0 ? (
            <div className={styles.loading}>Loading holidays...</div>
          ) : filteredHolidays.length === 0 ? (
            <div className={styles.empty}>No holidays for {selectedYear}</div>
          ) : (
            <>
              {/* Standard holidays */}
              {standardHolidays.length > 0 && (
                <div className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Public Holidays ({standardHolidays.length})
                  </h3>
                  <div className={styles.holidayItems}>
                    {standardHolidays.map((holiday) => (
                      <div key={holiday.id} className={styles.holidayItem}>
                        <div className={styles.holidayDate}>
                          {formatDate(holiday.date)}
                          {holiday.end_date && holiday.end_date !== holiday.date && (
                            <span> - {formatDate(holiday.end_date)}</span>
                          )}
                        </div>
                        <div className={styles.holidayName}>{holiday.name}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Custom holidays */}
              {customHolidays.length > 0 && (
                <div className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Custom Holidays ({customHolidays.length})
                  </h3>
                  <div className={styles.holidayItems}>
                    {customHolidays.map((holiday) => (
                      <div key={holiday.id} className={`${styles.holidayItem} ${styles.custom}`}>
                        <div className={styles.holidayDate}>
                          {formatDate(holiday.date)}
                          {holiday.end_date && holiday.end_date !== holiday.date && (
                            <span> - {formatDate(holiday.end_date)}</span>
                          )}
                        </div>
                        <div className={styles.holidayName}>{holiday.name}</div>
                        <button
                          className={styles.deleteBtn}
                          onClick={() => handleDeleteHoliday(holiday)}
                          title="Delete custom holiday"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Footer */}
        <div className={styles.footer}>
          <span className={styles.footerInfo}>
            {currentSite?.country_code 
              ? `Country: ${currentSite.country_code}`
              : 'No country configured'}
          </span>
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Generate ICS file for multiple holidays
function generateHolidaysICS(holidays: BankHoliday[], siteName: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Milestone//${siteName} Holidays//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  
  holidays.forEach((holiday) => {
    const startDate = new Date(holiday.date);
    const endDate = holiday.end_date ? new Date(holiday.end_date) : startDate;
    
    // For all-day events, end date should be the day AFTER
    const adjustedEndDate = new Date(endDate);
    adjustedEndDate.setDate(adjustedEndDate.getDate() + 1);
    
    const formatDate = (date: Date): string => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    };
    
    const uid = `holiday-${holiday.id}-${Date.now()}@milestone`;
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${formatDate(startDate)}`,
      `DTEND;VALUE=DATE:${formatDate(adjustedEndDate)}`,
      `SUMMARY:${escapeICS(holiday.name)}`,
      `DESCRIPTION:${escapeICS(`${siteName} - Bank Holiday`)}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  });
  
  lines.push('END:VCALENDAR');
  
  return lines.join('\r\n');
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}
