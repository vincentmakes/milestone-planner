/**
 * Company Events Row Component
 * Expandable row showing all company events with actions
 * - Add company event button / click an event to edit it (Settings hub)
 * - Delete company events (removes the event from this site only)
 * - Export to ICS
 */

import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Notice } from '@/components/common/Notice';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useTeamFilteredCompanyEvents } from '@/hooks/useTeamFilter';
import { deleteCompanyEvent, getCompanyEvents, buildEventDateSet } from '@/api';
import { buildICS, downloadICS } from '@/utils/ics';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './StaffView.module.css';
import { parseLocalDate } from '@/utils/date';

interface CompanyEventsRowProps {
  isExpanded: boolean;
  onToggle?: () => void;
}

export function CompanyEventsRow({ isExpanded, onToggle }: CompanyEventsRowProps) {
  const [error, setError] = useState<string | null>(null);
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  // Narrowed by the header team filter; a refetch still writes the store
  const { events: companyEvents } = useTeamFilteredCompanyEvents();
  const teams = useAppStore((s) => s.teams);
  const setCompanyEvents = useAppStore((s) => s.setCompanyEvents);
  const openSettings = useUIStore((s) => s.openSettings);
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  // Events are managed in the Settings hub, which cannot open during
  // What-If (this row also shows in the Gantt's embedded staff overview).
  // Deleting is blocked too: events are not in the What-If snapshot, so a
  // queued DELETE would leave the row on screen (the reload reads the real
  // server list), a second try would queue a DELETE that 404s on Apply, and
  // Discard could not bring the event back.
  const whatIf = useWhatIfBlocked();
  const addBlockedReason = whatIf.blocked ? whatIf.reason('Adding company events') : null;
  const editBlockedReason = whatIf.blocked ? whatIf.reason('Editing company events in Settings') : null;
  const deleteBlockedReason = whatIf.blocked ? whatIf.reason('Deleting company events') : null;
  const canOpenEditor = canEdit && !editBlockedReason;
  
  // The teams an event is limited to, by name (or counted when one is not loaded)
  const teamLabel = (teamIds: number[]): string => {
    const names = teamIds.map((id) => teams.find((t) => t.id === id)?.name);
    return names.every((n) => n !== undefined)
      ? names.join(', ')
      : `${teamIds.length} ${teamIds.length === 1 ? 'team' : 'teams'}`;
  };

  // Tooltip of the Closure badge: a team-limited closure names its teams,
  // since only their members are out
  const closureTitle = (teamIds: number[] | undefined): string => {
    if (!teamIds?.length) return 'Site closure: staff on this site are unavailable';
    return `Closure for ${teamLabel(teamIds)}: only their members are unavailable`;
  };

  // Group events by year
  const eventsByYear = companyEvents.reduce((acc, e) => {
    const year = parseLocalDate(e.date).getFullYear();
    if (!acc[year]) acc[year] = [];
    acc[year].push(e);
    return acc;
  }, {} as Record<number, typeof companyEvents>);
  
  // Format date for display using browser locale
  const formatEventDate = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    return date.toLocaleDateString(undefined, { 
      weekday: 'short',
      day: 'numeric', 
      month: 'short' 
    });
  };
  
  // Export events to ICS
  const exportToICS = () => {
    if (companyEvents.length === 0) return;
    
    // A site closure blocks time (out of office); a plain event is transparent
    const icsContent = buildICS(
      companyEvents.map((event) => ({
        uid: `companyevent-${event.id}@milestone`,
        summary: event.name,
        start_date: event.date,
        end_date: event.end_date,
        transparency: event.counts_as_unavailable ? ('OPAQUE' as const) : ('TRANSPARENT' as const),
        ...(event.counts_as_unavailable ? { busyStatus: 'OOF' } : {}),
      })),
      'Company Events',
    );
    downloadICS(icsContent, `company-events-${currentSite?.name || 'site'}.ics`);
  };
  
  // Events are managed in the Settings hub
  const handleAddEvent = () => {
    openSettings('company-events', { type: 'add', siteId: currentSite?.id });
  };
  
  const handleEditEvent = (eventId: number) => {
    openSettings('company-events', { type: 'edit', id: eventId, siteId: currentSite?.id });
  };
  
  // Handle deleting a company event
  // An event shared by several sites is only removed from the current site
  // (the legacy site-scoped DELETE unlinks it); other sites keep it.
  const handleDeleteEvent = async (eventId: number, siteCount: number) => {
    if (!currentSite || deleteBlockedReason) return;
    const message = siteCount > 1
      ? `This event is shared by ${siteCount} sites. Remove it from ${currentSite.name} only? The other sites keep it (delete it everywhere from Settings → Company events).`
      : 'Delete this company event?';
    const confirmed = await confirmAction({
      title: siteCount > 1 ? 'Remove event' : 'Delete event',
      message,
      confirmLabel: siteCount > 1 ? 'Remove' : 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    
    try {
      await deleteCompanyEvent(currentSite.id, eventId);
      
      // Reload events
      const events = await getCompanyEvents(currentSite.id);
      const eventDates = buildEventDateSet(events);
      setCompanyEvents(events, eventDates);
    } catch (err) {
      console.error('Failed to delete company event:', err);
      setError('Failed to delete company event');
    }
  };
  
  return (
    <div className={styles.companyEventsWrapper}>
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)} className={styles.rowNotice}>
          {error}
        </Notice>
      )}
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
              disabled={addBlockedReason !== null}
              title={addBlockedReason ?? 'Add company event'}
              aria-label="Add company event"
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
                  className={`${styles.detailRow} ${canOpenEditor ? styles.clickable : ''}`}
                  onClick={canOpenEditor ? () => handleEditEvent(event.id) : undefined}
                  title={canEdit ? (editBlockedReason ?? 'Edit in Settings') : undefined}
                >
                  <span
                    className={`${styles.detailType} ${styles.companyEvent}`}
                    title={event.counts_as_unavailable ? closureTitle(event.team_ids) : undefined}
                  >
                    {event.counts_as_unavailable ? 'Closure' : 'Event'}
                  </span>
                  <span className={styles.detailName}>
                    {event.name}
                    {event.team_ids && event.team_ids.length > 0 && (
                      <span className={styles.detailTeams}>{`· ${teamLabel(event.team_ids)}`}</span>
                    )}
                  </span>
                  <span className={styles.dateBadge}>{dateDisplay}</span>
                  {canEdit && (
                    <button
                      className={styles.deleteAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteEvent(event.id, event.site_ids?.length ?? 1);
                      }}
                      disabled={deleteBlockedReason !== null}
                      title={deleteBlockedReason ?? ((event.site_ids?.length ?? 1) > 1 ? 'Remove from this site' : 'Delete company event')}
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
              className={`${styles.detailRow} ${styles.addRow} ${addBlockedReason ? styles.addRowDisabled : ''}`}
              onClick={addBlockedReason ? undefined : handleAddEvent}
              aria-disabled={addBlockedReason ? true : undefined}
              title={addBlockedReason ?? undefined}
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
