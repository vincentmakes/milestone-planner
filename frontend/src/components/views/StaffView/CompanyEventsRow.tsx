/**
 * Company Events Row Component
 * Expandable row showing all company events with actions
 * - Add company event button
 * - Delete company events
 * - Export to ICS
 */

import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { deleteCompanyEvent, getCompanyEvents, buildEventDateSet } from '@/api';
import styles from './StaffView.module.css';

interface CompanyEventsRowProps {
  isExpanded: boolean;
  onToggle?: () => void;
}

export function CompanyEventsRow({ isExpanded, onToggle }: CompanyEventsRowProps) {
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const setCompanyEvents = useAppStore((s) => s.setCompanyEvents);
  const { openModal } = useUIStore();
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Group events by year
  const eventsByYear = companyEvents.reduce((acc, e) => {
    const year = new Date(e.date).getFullYear();
    if (!acc[year]) acc[year] = [];
    acc[year].push(e);
    return acc;
  }, {} as Record<number, typeof companyEvents>);
  
  // Format date for display using browser locale
  const formatEventDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { 
      weekday: 'short',
      day: 'numeric', 
      month: 'short' 
    });
  };
  
  // Export events to ICS
  const exportToICS = () => {
    if (companyEvents.length === 0) return;
    
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Milestone//Company Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    
    companyEvents.forEach((event) => {
      const startDate = event.date.replace(/-/g, '');
      // End date is the day after for all-day events
      const endDateObj = new Date(event.end_date || event.date);
      endDateObj.setDate(endDateObj.getDate() + 1);
      const endDate = endDateObj.toISOString().split('T')[0].replace(/-/g, '');
      
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:companyevent-${event.id}@milestone`);
      lines.push(`DTSTART;VALUE=DATE:${startDate}`);
      lines.push(`DTEND;VALUE=DATE:${endDate}`);
      lines.push(`SUMMARY:${event.name.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')}`);
      lines.push('TRANSP:TRANSPARENT');
      lines.push('END:VEVENT');
    });
    
    lines.push('END:VCALENDAR');
    
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `company-events-${currentSite?.name || 'site'}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // Handle opening add company event modal
  const handleAddEvent = () => {
    openModal('companyEvent');
  };
  
  // Handle deleting a company event
  const handleDeleteEvent = async (eventId: number) => {
    if (!currentSite) return;
    if (!confirm('Delete this company event?')) return;
    
    try {
      await deleteCompanyEvent(currentSite.id, eventId);
      
      // Reload events
      const events = await getCompanyEvents(currentSite.id);
      const eventDates = buildEventDateSet(events);
      setCompanyEvents(events, eventDates);
    } catch (err) {
      console.error('Failed to delete company event:', err);
      alert('Failed to delete company event');
    }
  };
  
  return (
    <div className={styles.companyEventsWrapper}>
      {/* Main company events row */}
      <div 
        className={`${styles.staffRow} ${styles.companyEventsRow} ${!onToggle ? styles.noExpand : ''}`}
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
        <div className={`${styles.status} ${styles.companyEventStatus}`} />
        <div className={styles.staffInfo}>
          <div className={styles.staffName}>Company Events</div>
          <div className={styles.staffMeta}>
            <span>{currentSite?.name || 'Site'}</span>
            <span> · </span>
            <span>{companyEvents.length} event{companyEvents.length !== 1 ? 's' : ''}</span>
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
              onClick={handleAddEvent}
              title="Add company event"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* Expanded content - Event details */}
      {isExpanded && (
        <div className={styles.expandedContent}>
          {Object.keys(eventsByYear).sort().map((year) => (
            eventsByYear[Number(year)].map((event) => {
              const dateDisplay = event.end_date && event.end_date !== event.date
                ? `${formatEventDate(event.date)} - ${formatEventDate(event.end_date)}`
                : formatEventDate(event.date);
              
              return (
                <div 
                  key={event.id}
                  className={styles.detailRow}
                >
                  <span className={`${styles.detailType} ${styles.companyEvent}`}>
                    Event
                  </span>
                  <span className={styles.detailName}>{event.name}</span>
                  <span className={styles.dateBadge}>{dateDisplay}</span>
                  {canEdit && (
                    <button
                      className={styles.deleteAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteEvent(event.id);
                      }}
                      title="Delete company event"
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
          
          {companyEvents.length === 0 && (
            <div className={styles.detailRow}>
              <span className={styles.noAssignments}>No company events</span>
            </div>
          )}
          
          {/* Add event row at bottom */}
          {canEdit && (
            <div 
              className={`${styles.detailRow} ${styles.addRow}`}
              onClick={handleAddEvent}
            >
              <span className={styles.addIcon}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span className={styles.addText}>Add company event</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
