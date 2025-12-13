/**
 * ProjectPanel
 * Left panel containing the project tree hierarchy
 */

import { forwardRef } from 'react';
import { ProjectRow } from './ProjectRow';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { ReorderProvider } from '@/contexts/ReorderContext';
import type { Project } from '@/types';
import styles from './ProjectPanel.module.css';

interface ProjectPanelProps {
  projects: Project[];
  width: number;
}

export const ProjectPanel = forwardRef<HTMLDivElement, ProjectPanelProps>(
  function ProjectPanel({ projects, width }, ref) {
    const openProjectModal = useUIStore((s) => s.openProjectModal);
    const setActiveModal = useUIStore((s) => s.setActiveModal);
    const currentUser = useAppStore((s) => s.currentUser);
    
    const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
    
    return (
      <ReorderProvider>
        <div className={styles.panel} style={{ width }}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <span className={styles.headerTitle}>Projects</span>
              <span className={styles.headerCount}>{projects.length}</span>
            </div>
            {canEdit && (
              <div className={styles.headerActions}>
                <button 
                  className={styles.importBtn}
                  onClick={() => setActiveModal('importProject')}
                  title="Import Project"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
                <button 
                  className={styles.newProjectBtn}
                  onClick={() => openProjectModal()}
                  title="New Project"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>New</span>
                </button>
              </div>
            )}
          </div>

          {/* Scrollable body */}
          <div ref={ref} className={styles.body}>
            {projects.length === 0 ? (
              <div className={styles.empty}>
                <p>No projects found</p>
                <p className={styles.emptyHint}>
                  {canEdit ? 'Click "New" to create a project' : 'No projects available for this site'}
                </p>
              </div>
            ) : (
              projects.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))
            )}
          </div>
        </div>
      </ReorderProvider>
    );
  }
);
