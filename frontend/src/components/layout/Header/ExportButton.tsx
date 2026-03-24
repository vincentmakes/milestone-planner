/**
 * ExportButton - Export projects to CSV
 */

import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { exportAndDownload } from '@/utils/csvExport';
import styles from './ExportButton.module.css';

export function ExportButton() {
  const [isExporting, setIsExporting] = useState(false);
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);

  // Filter to current site's non-archived projects
  const siteProjects = projects.filter(
    (p) => p.site_id === currentSite?.id && !p.archived
  );

  const handleExport = async () => {
    if (siteProjects.length === 0) {
      alert('No projects to export');
      return;
    }

    setIsExporting(true);
    try {
      // Small delay for UI feedback
      await new Promise((resolve) => setTimeout(resolve, 100));
      exportAndDownload(siteProjects, currentSite?.name);
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      className={styles.button}
      onClick={handleExport}
      disabled={isExporting || siteProjects.length === 0}
      title={`Export ${siteProjects.length} project${siteProjects.length !== 1 ? 's' : ''} to CSV`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7,10 12,15 17,10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span className={styles.label}>
        {isExporting ? 'Exporting...' : 'Export'}
      </span>
    </button>
  );
}
