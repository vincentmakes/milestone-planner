/**
 * Company Events Row Component
 * Expandable row showing all company events with actions
 * - Add company event button / click an event to edit it (Settings hub)
 * - Delete company events (removes the event from this site only)
 * - Export to ICS
 */

import { useMemo, useState } from 'react';
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
import { teamsForSite, teamIdsOnSite } from '@/utils/teams';
import { can } from '@/utils/permissions';
import { Icon, PlusIcon, CloseIcon, DownloadIcon, ChevronRightIcon } from '@/components/common/Icon';

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
  
  const canEdit = can(currentUser, 'company_events.manage');
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
  
  // This site's teams, inactive included. `team_ids` is a flat cross-site
  // list; an event with no team here concerns the whole site, like the filter.
  const siteTeams = useMemo(() => teamsForSite(teams, currentSite?.id), [teams, currentSite?.id]);
  const teamNamesHere = (teamIds: number[] | undefined): string[] =>
    teamIdsOnSite(teamIds, siteTeams).flatMap((id) => siteTeams.find((t) => t.id === id)?.name ?? []);

  // Tooltip of the Closure badge: a team-limited closure names its teams,
  // since only their members are out
  const closureTitle = (teamIds: number[] | undefined): string => {
    const names = teamNamesHere(teamIds);
    if (names.length === 0) return 'Site closure: staff on this site are unavailable';
    return `Closure for ${names.join(', ')}: only their members are unavailable`;
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
            <Icon icon={ChevronRightIcon} size={12} />
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
            <Icon icon={DownloadIcon} size={14} />
          </button>
          {canEdit && (
            <button 
              className={styles.iconBtn}
              onClick={handleAddEvent}
              disabled={addBlockedReason !== null}
              title={addBlockedReason ?? 'Add company event'}
              aria-label="Add company event"
            >
              <Icon icon={PlusIcon} size={14} />
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
              const teamNames = teamNamesHere(event.team_ids);
              
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
                    {teamNames.length > 0 && (
                      <span className={styles.detailTeams}>{`· ${teamNames.join(', ')}`}</span>
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
                      <Icon icon={CloseIcon} size={14} />
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
                <Icon icon={PlusIcon} size={12} />
              </span>
              <span className={styles.addText}>Add company event</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
