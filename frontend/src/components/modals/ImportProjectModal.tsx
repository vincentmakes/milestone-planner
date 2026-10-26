/**
 * ImportProjectModal
 * 
 * Modal for importing projects from MPP (Microsoft Project) or CSV files.
 * Uses backend endpoint to parse and create project with full hierarchy.
 */

import { useState, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { loadAllProjects } from '@/api/endpoints/projects';
import styles from './ImportProjectModal.module.css';
import { Icon, CheckCircleIcon, ErrorIcon, UploadIcon, FileTextIcon, FileCsvIcon } from '@/components/common/Icon';

interface ImportResult {
  success: boolean;
  project_id?: number;
  project_name?: string;
  phases_created?: number;
  subphases_created?: number;
  error?: string;
  java_error?: boolean;
  setup_instructions?: string;
}

interface ImportProgress {
  percent: number;
  message: string;
}

export function ImportProjectModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const setProjects = useAppStore((s) => s.setProjects);
  const currentSite = useAppStore((s) => s.currentSite);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  
  const isOpen = activeModal === 'importProject';
  
  // State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { isSubmitting: isImporting, begin: beginImport, end: endImport } = useSubmitGuard();
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Handle file selection
  const handleFileSelect = (file: File) => {
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.mpp') && !fileName.endsWith('.csv') && 
        !fileName.endsWith('.mpt') && !fileName.endsWith('.mpx') && 
        !fileName.endsWith('.xml')) {
      setError('Please select an MPP, CSV, or XML file');
      return;
    }
    setSelectedFile(file);
    setError(null);
    setResult(null);
  };
  
  // Handle drag events
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  };
  
  // Handle file input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };
  
  // Handle import
  const handleImport = async () => {
    if (!selectedFile) return;

    // The import uploads via a raw fetch that bypasses the What-If queue,
    // so it would hit the server for real. Block it while the sandbox is on.
    if (whatIfMode) {
      setError('Importing is unavailable while What-If mode is active. Apply or discard your What-If changes first.');
      return;
    }

    if (!beginImport()) return; // an upload is already running
    setError(null);
    setResult(null);
    
    try {
      setProgress({ percent: 10, message: 'Uploading file...' });
      
      // Create form data
      const formData = new FormData();
      formData.append('file', selectedFile);
      if (currentSite?.id) {
        formData.append('site_id', currentSite.id.toString());
      }
      
      setProgress({ percent: 30, message: 'Parsing and creating project...' });
      
      // Build API URL - handle dev mode (port 3333 -> 8485)
      let apiUrl = '/api/import/project';
      if (window.location.port === '3333') {
        apiUrl = `${window.location.protocol}//${window.location.hostname}:8485/api/import/project`;
      }
      
      // Check for tenant prefix
      const tenantMatch = window.location.pathname.match(/^(\/t\/[a-z0-9][a-z0-9-]*)/);
      if (tenantMatch) {
        apiUrl = apiUrl.replace('/api/', `${tenantMatch[1]}/api/`);
      }
      
      // Send to backend - it handles everything
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      
      // Handle empty or non-JSON responses
      const responseText = await response.text();
      let data: ImportResult;
      
      try {
        data = responseText ? JSON.parse(responseText) : { success: false, error: 'Empty response from server' };
      } catch {
        console.error('Server response:', responseText);
        throw new Error(`Server error: ${response.status} ${response.statusText}. Check server logs.`);
      }
      
      if (!response.ok || !data.success) {
        // Check if it's a Java/JVM error or MPXJ package error
        const errorMsg = data.error || '';
        const isJavaError = data.java_error || 
          errorMsg.includes('JVM') || 
          errorMsg.includes('Java') || 
          errorMsg.includes('libjvm') ||
          errorMsg.includes('package') && errorMsg.includes('not found');
          
        if (isJavaError) {
          // Store the full error with setup instructions
          setError(data.error || 'Java/JVM not found');
          setResult({
            success: false,
            java_error: true,
            setup_instructions: data.setup_instructions || `
MPXJ Setup Required
===================

MPP file import requires the mpxj Python package.

Install with:
  pip install mpxj

This package includes the MPXJ Java library needed to parse
Microsoft Project files.

Note: Java must also be installed:
  sudo apt install default-jre-headless  (Ubuntu/WSL)
  brew install openjdk                    (macOS)
`,
            error: data.error
          });
          return;
        }
        throw new Error(data.error || `Import failed: ${response.status}`);
      }
      
      setProgress({ percent: 90, message: 'Refreshing project list...' });
      
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      
      setProgress({ percent: 100, message: 'Import complete!' });
      setResult(data);
      
    } catch (err) {
      console.error('Import error:', err);
      setError(err instanceof Error ? err.message : 'Failed to import project');
      setProgress(null);
    } finally {
      endImport();
    }
  };
  
  // Reset state when closing
  const handleClose = () => {
    setSelectedFile(null);
    setProgress(null);
    setError(null);
    setResult(null);
    endImport();
    closeModal();
  };
  
  // Clear selection
  const handleClear = () => {
    setSelectedFile(null);
    setError(null);
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // Get file icon based on type
  const getFileIcon = (filename: string) => {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'csv') {
      return (
        <Icon icon={FileCsvIcon} size={32} />
      );
    }
    // MPP/MPT/MPX/XML
    return (
      <Icon icon={FileTextIcon} size={32} />
    );
  };
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import Project"
      size="md"
    >
      <div className={styles.container}>
        {/* File Drop Zone */}
        {!isImporting && !result && (
          <>
            <div
              className={`${styles.dropZone} ${isDragging ? styles.dragging : ''} ${selectedFile ? styles.hasFile : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".mpp,.mpt,.mpx,.xml,.csv"
                onChange={handleInputChange}
                className={styles.fileInput}
              />
              
              {selectedFile ? (
                <div className={styles.selectedFile}>
                  <div className={styles.fileIcon}>
                    {getFileIcon(selectedFile.name)}
                  </div>
                  <div className={styles.fileName}>{selectedFile.name}</div>
                  <div className={styles.fileSize}>
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </div>
                </div>
              ) : (
                <div className={styles.dropContent}>
                  <Icon icon={UploadIcon} size={48} />
                  <div className={styles.dropText}>
                    Drop file here or click to browse
                  </div>
                  <div className={styles.dropHint}>
                    Supports MPP, MPT, MPX, XML, and CSV files
                  </div>
                </div>
              )}
            </div>
            
            {selectedFile && (
              <button className={styles.clearBtn} onClick={handleClear}>
                Choose different file
              </button>
            )}
          </>
        )}
        
        {/* Progress */}
        {isImporting && progress && (
          <div className={styles.progressSection}>
            <div className={styles.progressBar}>
              <div 
                className={styles.progressFill}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className={styles.progressMessage}>{progress.message}</div>
          </div>
        )}
        
        {/* Error */}
        {error && !result?.java_error && (
          <div className={styles.error}>{error}</div>
        )}
        
        {/* Java Error with Instructions */}
        {result?.java_error && (
          <div className={styles.javaError}>
            <div className={styles.javaErrorHeader}>
              <Icon icon={ErrorIcon} size={24} />
              <span>Java Required for MPP Import</span>
            </div>
            <div className={styles.javaErrorMessage}>
              {result.error || 'Java/JVM not found. MPP import requires Java to be installed.'}
            </div>
            <div className={styles.javaErrorTip}>
              <strong>Tip:</strong> CSV files don't require Java and can be imported without additional setup.
            </div>
            {result.setup_instructions && (
              <details className={styles.setupInstructions}>
                <summary>Setup Instructions</summary>
                <pre>{result.setup_instructions}</pre>
              </details>
            )}
          </div>
        )}
        
        {/* Success */}
        {result && result.success && !result.java_error && (
          <div className={styles.success}>
            <Icon icon={CheckCircleIcon} size={24} />
            <div className={styles.successContent}>
              <div className={styles.successTitle}>Import Complete!</div>
              <div className={styles.successDetails}>
                <strong>{result.project_name}</strong>
                <span>
                  {result.phases_created} phase{result.phases_created !== 1 ? 's' : ''}
                  {result.subphases_created ? `, ${result.subphases_created} subphase${result.subphases_created !== 1 ? 's' : ''}` : ''}
                </span>
              </div>
            </div>
          </div>
        )}
        
        {/* Actions */}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={handleClose}>
            {result && result.success ? 'Close' : 'Cancel'}
          </Button>
          {(!result || result.java_error) && (
            <Button 
              onClick={handleImport} 
              disabled={!selectedFile || isImporting}
              loading={isImporting}
            >
              Import Project
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

