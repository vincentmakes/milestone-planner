/**
 * ProjectModal - Create/Edit Project Modal
 * Matches vanilla JS functionality for creating new projects with phases
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createProject, updateProject, loadAllProjects } from '@/api/endpoints/projects';
import { getPredefinedPhases } from '@/api/endpoints/settings';
import { toInputDateFormat } from '@/utils/date';
import { exportAndDownload } from '@/utils/csvExport';
import { exportProjectToXML } from '@/utils/xmlExport';
import styles from './ProjectModal.module.css';

// Local interface for predefined phases from API
interface PredefinedPhaseFromAPI {
  id: number;
  name: string;
  default_color?: string;
  color?: string;
  is_active?: boolean;
}

export function ProjectModal() {
  const { activeModal, editingProject, closeModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);
  const staff = useAppStore((s) => s.staff);
  const setProjects = useAppStore((s) => s.setProjects);
  
  const isOpen = activeModal === 'project';
  const isEditing = !!editingProject;
  
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Filter staff by current site
  const siteStaff = useMemo(() => {
    if (!currentSite) return [];
    return staff.filter(s => s.site_id === currentSite.id);
  }, [staff, currentSite]);
  
  // Load predefined phases
  useEffect(() => {
    if (isOpen) {
      getPredefinedPhases()
        .then((phases: unknown) => {
          const typedPhases = phases as PredefinedPhaseFromAPI[];
          const activePhases = typedPhases.filter(p => p.is_active !== false);
          setPredefinedPhases(activePhases);
          // Select all by default for new projects
          if (!isEditing) {
            setSelectedPhases(new Set(activePhases.map(p => p.name)));
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
        setStartDate(today.toISOString().split('T')[0]);
        setEndDate(nextMonth.toISOString().split('T')[0]);
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
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Build phases array from selected predefined phases
      const phases: { type: string; start_date: string; end_date: string }[] = [];
      
      if (selectedPhases.size > 0 && !isEditing) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const totalDuration = end.getTime() - start.getTime();
        const phaseDuration = totalDuration / selectedPhases.size;
        
        let idx = 0;
        // Maintain order from predefinedPhases
        for (const phase of predefinedPhases) {
          if (selectedPhases.has(phase.name)) {
            const phaseStart = new Date(start.getTime() + phaseDuration * idx);
            const phaseEnd = new Date(start.getTime() + phaseDuration * (idx + 1));
            // Don't exceed project end
            const adjustedEnd = phaseEnd > end ? end : phaseEnd;
            
            phases.push({
              type: phase.name,
              start_date: phaseStart.toISOString().split('T')[0],
              end_date: adjustedEnd.toISOString().split('T')[0],
            });
            idx++;
          }
        }
      }
      
      const projectData = {
        name: name.trim(),
        site_id: currentSite.id,
        customer: customer.trim() || null,
        pm_id: pmId ? parseInt(pmId) : null,
        sales_pm: salesPm.trim() || null,
        volume: volume ? parseInt(volume) : null,
        confirmed,
        archived,
        start_date: startDate,
        end_date: endDate,
        phases: isEditing ? undefined : phases,
      };
      
      if (isEditing && editingProject) {
        await updateProject(editingProject.id, projectData);
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
      setIsSubmitting(false);
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
      alert('Failed to export to MS Project format');
    } finally {
      setIsExporting(false);
    }
  };
  
  const footer = (
    <div className={styles.footer}>
      {isEditing && (
        <div className={styles.exportButtons}>
          <Button 
            variant="secondary" 
            onClick={handleExportCSV} 
            disabled={isSubmitting || isExporting}
            title="Export to CSV (MS Project compatible)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7,10 12,15 17,10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            CSV
          </Button>
          <Button 
            variant="secondary" 
            onClick={handleExportXML} 
            disabled={isSubmitting || isExporting}
            title="Export to MS Project XML format"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7,10 12,15 17,10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {isExporting ? 'Exporting...' : 'XML'}
          </Button>
        </div>
      )}
      <div className={styles.actionButtons}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Project'}
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
        {error && <div className={styles.error}>{error}</div>}
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Project Name *</label>
          <input
            type="text"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter project name"
            autoFocus
          />
        </div>
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Start Date *</label>
            <input
              type="date"
              className={styles.input}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>End Date *</label>
            <input
              type="date"
              className={styles.input}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Project Manager</label>
            <select
              className={styles.input}
              value={pmId}
              onChange={(e) => setPmId(e.target.value)}
            >
              <option value="">Select PM</option>
              {siteStaff.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Customer</label>
            <input
              type="text"
              className={styles.input}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="Customer name"
            />
          </div>
        </div>
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Sales PM</label>
            <input
              type="text"
              className={styles.input}
              value={salesPm}
              onChange={(e) => setSalesPm(e.target.value)}
              placeholder="Sales contact"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Project Volume (CHF)</label>
            <input
              type="number"
              className={styles.input}
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              placeholder="0"
            />
          </div>
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
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>Project Confirmed</span>
            </label>
          </div>
          {isEditing && (
            <div className={styles.formGroup}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                <span>Archived</span>
              </label>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
