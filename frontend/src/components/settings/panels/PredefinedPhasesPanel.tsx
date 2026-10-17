/**
 * PredefinedPhasesPanel (Settings hub > Predefined phases)
 * 
 * Admin/SuperUser panel for managing predefined phase templates.
 * Phases can be reordered, renamed, activated/deactivated, and deleted.
 */

import { useState, useEffect, useCallback } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { apiGet, apiPost, apiPut, apiDelete } from '@/api/client';
import type { PredefinedPhase } from '@/types';
import { CheckCircleIcon, CircleIcon, PlusIcon, TrashIcon } from './PanelIcons';
import styles from './PredefinedPhasesPanel.module.css';

export function PredefinedPhasesPanel() {
  const currentUser = useAppStore((s) => s.currentUser);
  
  const canManage = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // State
  const [phases, setPhases] = useState<PredefinedPhase[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newPhaseName, setNewPhaseName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting: isAdding, begin: beginAdd, end: endAdd } = useSubmitGuard();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  
  // Drag state
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after' | null>(null);
  
  // Load phases
  const loadPhases = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiGet<PredefinedPhase[]>('/api/predefined-phases/all');
      setPhases(data);
    } catch (err) {
      console.error('Failed to load predefined phases:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadPhases();
  }, [loadPhases]);
  
  // Add new phase
  const handleAdd = async () => {
    if (!newPhaseName.trim()) return;
    
    if (!beginAdd()) return; // Enter twice while the first add is in flight
    setError(null);
    try {
      await apiPost('/api/predefined-phases', { name: newPhaseName.trim() });
      setNewPhaseName('');
      await loadPhases();
    } catch (err) {
      console.error('Failed to add phase:', err);
      setError(err instanceof Error ? err.message : 'Failed to add phase');
    } finally {
      endAdd();
    }
  };
  
  // Update phase name
  const handleUpdateName = async (id: number) => {
    if (!editingName.trim()) {
      setEditingId(null);
      return;
    }
    
    setError(null);
    try {
      await apiPut(`/api/predefined-phases/${id}`, { name: editingName.trim() });
      setEditingId(null);
      await loadPhases();
    } catch (err) {
      console.error('Failed to update phase:', err);
      setError(err instanceof Error ? err.message : 'Failed to update phase');
    }
  };
  
  // Toggle active status
  const handleToggleActive = async (phase: PredefinedPhase) => {
    setError(null);
    try {
      await apiPut(`/api/predefined-phases/${phase.id}`, { 
        is_active: !phase.is_active 
      });
      await loadPhases();
    } catch (err) {
      console.error('Failed to toggle phase:', err);
      setError(err instanceof Error ? err.message : 'Failed to update phase');
    }
  };
  
  // Delete phase
  const handleDelete = async (phase: PredefinedPhase) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${phase.name}"?`
    );
    if (!confirmed) return;
    setError(null);
    
    try {
      await apiDelete(`/api/predefined-phases/${phase.id}`);
      await loadPhases();
    } catch (err) {
      console.error('Failed to delete phase:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete phase');
    }
  };
  
  // Start editing
  const startEditing = (phase: PredefinedPhase) => {
    setEditingId(phase.id);
    setEditingName(phase.name);
  };
  
  // Drag handlers
  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  };
  
  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (draggedId === id) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';
    
    setDragOverId(id);
    setDragOverPosition(position);
  };
  
  const handleDragLeave = () => {
    setDragOverId(null);
    setDragOverPosition(null);
  };
  
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedId || !dragOverId || draggedId === dragOverId) {
      setDraggedId(null);
      setDragOverId(null);
      setDragOverPosition(null);
      return;
    }
    
    // Calculate new order
    const currentOrder = phases.map(p => p.id);
    const draggedIndex = currentOrder.indexOf(draggedId);
    let dropIndex = currentOrder.indexOf(dragOverId);
    
    // Remove dragged item
    currentOrder.splice(draggedIndex, 1);
    
    // Recalculate drop index after removal
    dropIndex = currentOrder.indexOf(dragOverId);
    if (dragOverPosition === 'after') {
      dropIndex += 1;
    }
    
    // Insert at new position
    currentOrder.splice(dropIndex, 0, draggedId);
    
    // Reset drag state
    setDraggedId(null);
    setDragOverId(null);
    setDragOverPosition(null);
    
    // Save new order
    try {
      await apiPut('/api/predefined-phases/reorder', { phase_order: currentOrder });
      await loadPhases();
    } catch (err) {
      console.error('Failed to reorder phases:', err);
      await loadPhases(); // Reload to reset
    }
  };
  
  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  };
  
  return (
    <div className={styles.container}>
      <p className={styles.description}>
        Predefined phases appear as quick-add options when creating new projects.
        Drag to reorder. Inactive phases won't appear in the list.
      </p>

      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      
      {/* Phase List */}
      <div className={styles.phaseList}>
        {isLoading ? (
          <div className={styles.loading}>Loading phases...</div>
        ) : phases.length === 0 ? (
          <div className={styles.empty}>No predefined phases. Add one below.</div>
        ) : (
          phases.map((phase) => (
            <div
              key={phase.id}
              className={`
                ${styles.phaseItem} 
                ${!phase.is_active ? styles.inactive : ''}
                ${draggedId === phase.id ? styles.dragging : ''}
                ${dragOverId === phase.id && dragOverPosition === 'before' ? styles.dropBefore : ''}
                ${dragOverId === phase.id && dragOverPosition === 'after' ? styles.dropAfter : ''}
              `}
              draggable={canManage}
              onDragStart={(e) => handleDragStart(e, phase.id)}
              onDragOver={(e) => handleDragOver(e, phase.id)}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
            >
              {/* Drag Handle */}
              {canManage && (
                <div className={styles.dragHandle}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="8" y1="6" x2="16" y2="6" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                    <line x1="8" y1="18" x2="16" y2="18" />
                  </svg>
                </div>
              )}
              
              {/* Phase Name */}
              <div className={styles.phaseName}>
                {editingId === phase.id ? (
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => handleUpdateName(phase.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdateName(phase.id);
                      if (e.key === 'Escape') {
                        // Cancel the inline edit without closing the Settings hub
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span 
                    onClick={() => canManage && startEditing(phase)}
                    className={canManage ? styles.editable : ''}
                  >
                    {phase.name}
                  </span>
                )}
              </div>
              
              {/* Actions */}
              {canManage && (
                <div className={styles.phaseActions}>
                  <button
                    className={`${styles.actionBtn} ${phase.is_active ? styles.active : ''}`}
                    onClick={() => handleToggleActive(phase)}
                    title={phase.is_active ? 'Deactivate' : 'Activate'}
                    aria-label={`${phase.is_active ? 'Deactivate' : 'Activate'} ${phase.name}`}
                    aria-pressed={!!phase.is_active}
                  >
                    {phase.is_active ? <CheckCircleIcon /> : <CircleIcon />}
                  </button>
                  <button
                    className={`${styles.actionBtn} ${styles.delete}`}
                    onClick={() => handleDelete(phase)}
                    title="Delete"
                    aria-label={`Delete ${phase.name}`}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      
      {/* Add New Phase */}
      {canManage && (
        <div className={styles.addSection}>
          <input
            type="text"
            value={newPhaseName}
            onChange={(e) => setNewPhaseName(e.target.value)}
            placeholder="New phase name..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
          />
          <Button icon={<PlusIcon />} onClick={handleAdd} disabled={!newPhaseName.trim()} loading={isAdding}>
            Add Phase
          </Button>
        </div>
      )}
    </div>
  );
}
