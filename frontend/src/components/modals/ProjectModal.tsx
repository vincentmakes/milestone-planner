/**
 * ProjectModal - Create/Edit Project Modal
 * Matches vanilla JS functionality for creating new projects with phases
 */

import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { DateRangeField } from '@/components/common/DateRangeField';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { createProject, updateProject, loadAllProjects } from '@/api/endpoints/projects';
import { getPredefinedPhases } from '@/api/endpoints/settings';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { toInputDateFormat, formatDateISO, addDaysToDateString, daysBetweenDateStrings } from '@/utils/date';
import { updateProjectLocally } from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { exportAndDownload } from '@/utils/csvExport';
import { exportProjectToXML } from '@/utils/xmlExport';
import { tagsForProjectScope } from '@/utils/tags';
import {
  draftFromValue,
  normalizeStoredValue,
  optionsForProjectScope,
  sameFieldValue,
  valueFromDraft,
} from '@/utils/projectFields';
import type { FieldDraft } from '@/utils/projectFields';
import { teamIdsOnSite, teamsForSite } from '@/utils/teams';
import { TagPicker } from './TagPicker';
import { ProjectFieldInputs } from './ProjectFieldInputs';
import styles from './ProjectModal.module.css';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { TeamChecklist } from '@/components/common/TeamChecklist';
import { can } from '@/utils/permissions';
import { builtInFieldLabel, isBuiltInFieldHidden, isSettingOn } from '@/utils/instanceSettings';
import type { ProjectFieldOption, ProjectFieldValue } from '@/types';
import { Icon, DownloadIcon } from '@/components/common/Icon';

// Local interface for predefined phases from API
interface PredefinedPhaseFromAPI {
  id: number;
  name: string;
  default_color?: string;
  color?: string;
  is_active?: boolean;
}

/** Dialog drafts of a project's field values, one per current field. */
function draftsFor(values: Record<number, ProjectFieldValue> | undefined): Record<number, FieldDraft> {
  const drafts: Record<number, FieldDraft> = {};
  for (const field of useAppStore.getState().projectFields) {
    drafts[field.id] = draftFromValue(field, values?.[field.id]);
  }
  return drafts;
}

/** `current` with the sent changes applied; a cleared field is removed. */
function applyFieldValues(
  current: Record<number, ProjectFieldValue> | undefined,
  changes: Record<number, ProjectFieldValue>
): Record<number, ProjectFieldValue> {
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    const id = Number(key);
    if (value === null || (Array.isArray(value) && value.length === 0)) delete next[id];
    else next[id] = value;
  }
  return next;
}

export function ProjectModal() {
  const { activeModal, editingProject, closeModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);
  const staff = useAppStore((s) => s.staff);
  const setProjects = useAppStore((s) => s.setProjects);
  const allTags = useAppStore((s) => s.tags);
  const projectFields = useAppStore((s) => s.projectFields);
  const instanceSettings = useAppStore((s) => s.instanceSettings);
  const teams = useAppStore((s) => s.teams);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const { staffMatches, filter: teamFilter } = useTeamFilter();
  // Read when the dialog opens only: a teams refetch while it is open must
  // not reset the form.
  const teamFilterRef = useRef(teamFilter);
  useLayoutEffect(() => {
    teamFilterRef.current = teamFilter;
  }, [teamFilter]);
  
  const isOpen = activeModal === 'project';
  const isEditing = !!editingProject;
  // Tags offered/kept are the ones that apply to the project's own site.
  const tagSiteId = editingProject?.site_id ?? currentSite?.id ?? null;
  // Creating inside What-If cannot show the new project until Apply; edits are fine.
  const createBlockedReason = !isEditing && whatIfMode ? whatIfUnavailableMessage('Creating projects') : null;
  
  // Form state
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState('');
  const [pmId, setPmId] = useState<string>('');
  const [salesPm, setSalesPm] = useState('');
  const [volume, setVolume] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [archived, setArchived] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedPhases, setSelectedPhases] = useState<Set<string>>(new Set());
  const [predefinedPhases, setPredefinedPhases] = useState<PredefinedPhaseFromAPI[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<number>>(new Set());
  const [selectedTeamIds, setSelectedTeamIds] = useState<number[]>([]);
  const [fieldDrafts, setFieldDrafts] = useState<Record<number, FieldDraft>>({});
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  // Staff of the current site, narrowed by the header team filter; the
  // project's current manager stays listed so an edit never drops them.
  const editingPmId = editingProject?.pm_id;
  const siteStaff = useMemo(() => {
    if (!currentSite) return [];
    return staff.filter(
      (s) => s.site_id === currentSite.id && (staffMatches(s) || s.id === editingPmId)
    );
  }, [staff, currentSite, staffMatches, editingPmId]);

  // Teams of the project's site: the active ones, plus an inactive one while
  // it is still ticked (so it can be unticked).
  const siteTeams = useMemo(() => teamsForSite(teams, tagSiteId), [teams, tagSiteId]);
  const projectTeams = useMemo(
    () => siteTeams.filter((t) => t.active || selectedTeamIds.includes(t.id)),
    [siteTeams, selectedTeamIds]
  );

  // Built-in fields: renamed or hidden instance-wide (Settings → Project
  // fields). A hidden one is neither shown nor sent, so its value is kept.
  const customerHidden = isBuiltInFieldHidden(instanceSettings, 'customer');
  const salesPmHidden = isBuiltInFieldHidden(instanceSettings, 'sales_pm');
  const volumeHidden = isBuiltInFieldHidden(instanceSettings, 'volume');

  // Dropdown items on offer: those applying to the project's site and teams
  const optionsByField = useMemo(() => {
    const map = new Map<number, ProjectFieldOption[]>();
    for (const field of projectFields) {
      map.set(field.id, optionsForProjectScope(field, tagSiteId, selectedTeamIds, siteTeams));
    }
    return map;
  }, [projectFields, tagSiteId, selectedTeamIds, siteTeams]);

  // The picker's rows (searched by name and job title); its "Select PM" row
  // stays a real, selectable choice: picking it clears the manager.
  const pmOptions = useMemo(
    () => siteStaff.map((s) => ({ id: s.id, label: s.name, hint: s.role })),
    [siteStaff]
  );
  
  // Load predefined phases
  useEffect(() => {
    if (isOpen) {
      getPredefinedPhases()
        .then((phases: unknown) => {
          const typedPhases = phases as PredefinedPhaseFromAPI[];
          const activePhases = typedPhases.filter(p => p.is_active !== false);
          setPredefinedPhases(activePhases);
          // A new project starts with every phase selected, or with none
          // when the admin turned that off (Settings → Features & defaults):
          // the creator then picks them. Read when the dialog opens only.
          if (!isEditing) {
            const preselect = isSettingOn(
              useAppStore.getState().instanceSettings,
              'new_project_preselect_phases'
            );
            setSelectedPhases(preselect ? new Set(activePhases.map(p => p.name)) : new Set());
          }
        })
        .catch(err => console.error('Failed to load predefined phases:', err));
    }
  }, [isOpen, isEditing]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (editingProject) {
        // Editing mode - convert ISO datetime to input format
        setName(editingProject.name);
        setCustomer(editingProject.customer || '');
        setPmId(editingProject.pm_id?.toString() || '');
        setSalesPm(editingProject.sales_pm || '');
        setVolume(editingProject.volume?.toString() || '');
        setConfirmed(editingProject.confirmed);
        setArchived(editingProject.archived || false);
        setStartDate(toInputDateFormat(editingProject.start_date));
        setEndDate(toInputDateFormat(editingProject.end_date));
        setSelectedPhases(new Set()); // Don't select phases when editing
        setSelectedTagIds(new Set((editingProject.tags ?? []).map((t) => t.id)));
        setSelectedTeamIds(editingProject.team_ids ?? []);
        setFieldDrafts(draftsFor(editingProject.field_values));
      } else {
        // New project mode
        const today = new Date();
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        setName('');
        setCustomer('');
        setPmId('');
        setSalesPm('');
        setVolume('');
        setConfirmed(false);
        setArchived(false);
        setStartDate(formatDateISO(today));
        setEndDate(formatDateISO(nextMonth));
        setSelectedTagIds(new Set());
        // A project created while a team filter is active shows in that view.
        setSelectedTeamIds(teamFilterRef.current?.teamIds ?? []);
        setFieldDrafts(draftsFor(undefined));
      }
      setError(null);
    }
  }, [isOpen, editingProject]);
  
  const togglePhase = (phaseName: string) => {
    setSelectedPhases(prev => {
      const next = new Set(prev);
      if (next.has(phaseName)) {
        next.delete(phaseName);
      } else {
        next.add(phaseName);
      }
      return next;
    });
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (createBlockedReason) {
      setError(createBlockedReason);
      return;
    }
    
    if (!name.trim()) {
      setError('Please enter a project name');
      return;
    }
    
    if (!startDate || !endDate) {
      setError('Please select start and end dates');
      return;
    }
    
    if (!currentSite) {
      setError('No site selected');
      return;
    }
    
    // Drop selected tags that do not apply to the project's site and teams
    // (stale data, a tag re-scoped since the dialog opened, or a team unticked
    // after picking its tag) -- the server rejects them.
    const applicableTagIds = new Set(
      tagsForProjectScope(allTags, tagSiteId, selectedTeamIds, siteTeams).map((t) => t.id)
    );
    const tagIds = Array.from(selectedTagIds).filter((id) => applicableTagIds.has(id));

    // Project fields: only those that changed are sent (a teammate's edit to
    // another field is kept); items no longer applying are dropped like tags.
    const fieldValues: Record<number, ProjectFieldValue> = {};
    for (const field of projectFields) {
      const allowed = new Set((optionsByField.get(field.id) ?? []).map((o) => o.id));
      const value = valueFromDraft(field, fieldDrafts[field.id], allowed);
      if (value === undefined) {
        setError(`Invalid value for "${field.name}"`);
        return;
      }
      const before = isEditing ? normalizeStoredValue(field, editingProject?.field_values?.[field.id]) : null;
      if (!sameFieldValue(value, before)) {
        fieldValues[field.id] = value === null && field.field_type === 'multiselect' ? [] : value;
      }
    }

    if (!beginSubmit()) return;
    setError(null);
    
    try {
      // Build phases array from selected predefined phases
      const phases: { type: string; start_date: string; end_date: string }[] = [];
      
      if (selectedPhases.size > 0 && !isEditing) {
        // Split the project span evenly, in whole calendar days (never via
        // UTC milliseconds, which shifts a day west of UTC / across DST).
        const totalDays = daysBetweenDateStrings(startDate, endDate);
        const phaseDays = totalDays / selectedPhases.size;
        
        let idx = 0;
        // Maintain order from predefinedPhases
        for (const phase of predefinedPhases) {
          if (selectedPhases.has(phase.name)) {
            const startOffset = Math.floor(phaseDays * idx);
            // Don't exceed project end
            const endOffset = Math.min(totalDays, Math.floor(phaseDays * (idx + 1)));
            
            phases.push({
              type: phase.name,
              start_date: addDaysToDateString(startDate, startOffset),
              end_date: addDaysToDateString(startDate, endOffset),
            });
            idx++;
          }
        }
      }
      
      const projectData = {
        name: name.trim(),
        site_id: currentSite.id,
        ...(customerHidden ? {} : { customer: customer.trim() || null }),
        pm_id: pmId ? parseInt(pmId) : null,
        ...(salesPmHidden ? {} : { sales_pm: salesPm.trim() || null }),
        ...(volumeHidden ? {} : { volume: volume ? parseInt(volume) : null }),
        confirmed,
        archived,
        start_date: startDate,
        end_date: endDate,
        phases: isEditing ? undefined : phases,
        tag_ids: tagIds,
        // Only teams still on the site (any, active or not): one deleted
        // over WebSocket while the dialog is open is not sent.
        team_ids: teamIdsOnSite(selectedTeamIds, siteTeams),
        ...(Object.keys(fieldValues).length > 0 ? { field_values: fieldValues } : {}),
      };
      
      if (isEditing && editingProject) {
        await updateProject(editingProject.id, projectData);
        // Show the edit right away (the reload below is a no-op in What-If).
        updateProjectLocally(editingProject.id, (p) => {
          p.name = projectData.name;
          if (projectData.customer !== undefined) p.customer = projectData.customer;
          p.pm_id = projectData.pm_id;
          p.pm_name = projectData.pm_id
            ? staff.find((s) => s.id === projectData.pm_id)?.name ?? p.pm_name
            : null;
          if (projectData.sales_pm !== undefined) p.sales_pm = projectData.sales_pm;
          if (projectData.volume !== undefined) p.volume = projectData.volume;
          p.confirmed = projectData.confirmed;
          p.archived = projectData.archived;
          p.start_date = projectData.start_date;
          p.end_date = projectData.end_date;
          // Inline shape of project responses ({id, name, color}).
          p.tags = allTags
            .filter((t) => projectData.tag_ids.includes(t.id))
            .map(({ id, name, color }) => ({ id, name, color }));
          p.team_ids = projectData.team_ids;
          p.field_values = applyFieldValues(p.field_values, fieldValues);
        });
      } else {
        await createProject(projectData);
      }
      
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project');
    } finally {
      endSubmit();
    }
  };
  
  const [isExporting, setIsExporting] = useState(false);
  
  // Get the full project data from the store for export
  const projects = useAppStore((s) => s.projects);
  const fullProject = useMemo(() => {
    if (!editingProject) return null;
    return projects.find(p => p.id === editingProject.id);
  }, [editingProject, projects]);
  
  // Export to CSV
  const handleExportCSV = () => {
    if (!fullProject) return;
    exportAndDownload([fullProject], fullProject.name);
  };
  
  // Export to MS Project XML (client-side)
  const handleExportXML = () => {
    if (!fullProject) return;
    
    setIsExporting(true);
    try {
      exportProjectToXML(fullProject);
    } catch (err) {
      console.error('Export failed:', err);
      setError('Failed to export to MS Project format');
    } finally {
      setIsExporting(false);
    }
  };
  
  // Exporting a project needs projects.export (never in the manager bundle)
  const canExport = useAppStore((s) => can(s.currentUser, 'projects.export'));

  const footer = (
    <div className={styles.footer}>
      {isEditing && canExport && (
        <div className={styles.exportButtons}>
          <Button 
            variant="secondary" 
            onClick={handleExportCSV} 
            disabled={isSubmitting || isExporting}
            title="Export to CSV (MS Project compatible)"
          >
            <Icon icon={DownloadIcon} size={14} />
            CSV
          </Button>
          <Button 
            variant="secondary" 
            onClick={handleExportXML} 
            disabled={isSubmitting || isExporting}
            title="Export to MS Project XML format"
          >
            <Icon icon={DownloadIcon} size={14} />
            {isExporting ? 'Exporting...' : 'XML'}
          </Button>
        </div>
      )}
      <div className={styles.actionButtons}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting || !!createBlockedReason}
          title={createBlockedReason ?? undefined}
          loading={isSubmitting}
        >
          {isEditing ? 'Save Changes' : 'Create Project'}
        </Button>
      </div>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Project' : 'New Project'}
      size="lg"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {createBlockedReason && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && <div className={styles.error}>{error}</div>}
        
        <Input
          label="Project Name *"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter project name"
          autoFocus
          fullWidth
        />
        
        <div className={styles.formRow}>
          <DateRangeField
            startLabel="Start Date *"
            endLabel="End Date *"
            fieldClassName={styles.field}
            start={startDate}
            end={endDate}
            onChange={({ start, end }) => {
              setStartDate(start);
              setEndDate(end);
            }}
          />
        </div>
        
        <div className={styles.formRow}>
          <SearchableSelect
            label="Project Manager"
            className={styles.field}
            value={pmId === '' ? null : Number(pmId)}
            onChange={(id) => setPmId(id === null ? '' : String(id))}
            options={pmOptions}
            emptyLabel="Select PM"
          />
          {!customerHidden && (
            <Input
              label={builtInFieldLabel(instanceSettings, 'customer')}
              type="text"
              className={styles.field}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            />
          )}
        </div>
        
        {!(salesPmHidden && volumeHidden) && (
          <div className={styles.formRow}>
            {!salesPmHidden && (
              <Input
                label={builtInFieldLabel(instanceSettings, 'sales_pm')}
                type="text"
                className={styles.field}
                value={salesPm}
                onChange={(e) => setSalesPm(e.target.value)}
                placeholder="Sales contact"
              />
            )}
            {!volumeHidden && (
              <Input
                label={builtInFieldLabel(instanceSettings, 'volume')}
                type="number"
                className={styles.field}
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                placeholder="0"
              />
            )}
          </div>
        )}
        
        <ProjectFieldInputs
          fields={projectFields}
          optionsByField={optionsByField}
          drafts={fieldDrafts}
          onChange={(fieldId, draft) => setFieldDrafts((prev) => ({ ...prev, [fieldId]: draft }))}
          disabled={isSubmitting}
        />

        {/* Teams sit after every project field and right before Tags. */}
        {projectTeams.length > 0 && (
          <div className={styles.formGroup}>
            <span className={styles.label}>Teams</span>
            <TeamChecklist
              teams={projectTeams}
              selected={selectedTeamIds}
              onChange={setSelectedTeamIds}
              label="Project teams"
              disabled={isSubmitting}
            />
          </div>
        )}

        <div className={styles.formGroup}>
          <label className={styles.label}>Tags</label>
          <TagPicker
            selectedIds={selectedTagIds}
            onChange={setSelectedTagIds}
            siteId={tagSiteId}
            teamIds={selectedTeamIds}
            disabled={isSubmitting}
          />
        </div>

        {!isEditing && (
          <div className={styles.formGroup}>
            <label className={styles.label}>Project Phases</label>
            <div className={styles.phaseTags}>
              {predefinedPhases.map(phase => (
                <span
                  key={phase.id}
                  className={`${styles.phaseTag} ${selectedPhases.has(phase.name) ? styles.selected : ''}`}
                  onClick={() => togglePhase(phase.name)}
                  style={{ 
                    '--phase-color': phase.default_color || phase.color || 'var(--accent-blue)',
                  } as React.CSSProperties}
                >
                  {phase.name}
                </span>
              ))}
            </div>
          </div>
        )}
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <ToggleSwitch
              checked={confirmed}
              onChange={setConfirmed}
              label={builtInFieldLabel(instanceSettings, 'confirmed')}
            />
          </div>
          {isEditing && (
            <div className={styles.formGroup}>
              <ToggleSwitch checked={archived} onChange={setArchived} label="Archived" />
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
