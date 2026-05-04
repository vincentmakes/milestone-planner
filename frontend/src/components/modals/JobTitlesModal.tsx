/**
 * JobTitlesModal
 *
 * Admin/SuperUser modal for managing the job-title dropdown used during user
 * creation. Mirrors PredefinedPhasesModal. SSO-provisioned users intentionally
 * bypass this list (their job_title comes straight from the Entra ID claim).
 */

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { jobTitlesApi } from '@/api/endpoints/jobTitles';
import type { JobTitle } from '@/types';
import styles from './PredefinedPhasesModal.module.css';

export function JobTitlesModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentUser = useAppStore((s) => s.currentUser);

  const isOpen = activeModal === 'jobTitles';
  const canManage = currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  const [items, setItems] = useState<JobTitle[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after' | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await jobTitlesApi.getAll();
      setItems(data);
    } catch (err) {
      console.error('Failed to load job titles:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      load();
    }
  }, [isOpen, load]);

  const handleAdd = async () => {
    if (!newName.trim()) return;

    setIsAdding(true);
    try {
      await jobTitlesApi.create({ name: newName.trim() });
      setNewName('');
      await load();
    } catch (err) {
      console.error('Failed to add job title:', err);
      alert(err instanceof Error ? err.message : 'Failed to add job title');
    } finally {
      setIsAdding(false);
    }
  };

  const handleUpdateName = async (id: number) => {
    if (!editingName.trim()) {
      setEditingId(null);
      return;
    }

    try {
      await jobTitlesApi.update(id, { name: editingName.trim() });
      setEditingId(null);
      await load();
    } catch (err) {
      console.error('Failed to update job title:', err);
      alert(err instanceof Error ? err.message : 'Failed to update job title');
    }
  };

  const handleToggleActive = async (item: JobTitle) => {
    try {
      await jobTitlesApi.update(item.id, { is_active: !item.is_active });
      await load();
    } catch (err) {
      console.error('Failed to toggle job title:', err);
      alert(err instanceof Error ? err.message : 'Failed to update job title');
    }
  };

  const handleDelete = async (item: JobTitle) => {
    const confirmed = window.confirm(`Are you sure you want to delete "${item.name}"?`);
    if (!confirmed) return;

    try {
      await jobTitlesApi.delete(item.id);
      await load();
    } catch (err) {
      console.error('Failed to delete job title:', err);
      alert(err instanceof Error ? err.message : 'Failed to delete job title');
    }
  };

  const startEditing = (item: JobTitle) => {
    setEditingId(item.id);
    setEditingName(item.name);
  };

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

    const currentOrder = items.map((p) => p.id);
    const draggedIndex = currentOrder.indexOf(draggedId);
    let dropIndex = currentOrder.indexOf(dragOverId);

    currentOrder.splice(draggedIndex, 1);

    dropIndex = currentOrder.indexOf(dragOverId);
    if (dragOverPosition === 'after') {
      dropIndex += 1;
    }

    currentOrder.splice(dropIndex, 0, draggedId);

    setDraggedId(null);
    setDragOverId(null);
    setDragOverPosition(null);

    try {
      await jobTitlesApi.reorder(currentOrder);
      await load();
    } catch (err) {
      console.error('Failed to reorder job titles:', err);
      await load();
    }
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Job Titles" size="md">
      <div className={styles.container}>
        <p className={styles.description}>
          Manage the dropdown of job titles available when creating users. Drag to reorder.
          Inactive titles are hidden from the dropdown but kept on existing users.
          SSO-provisioned users always receive their job title from the identity provider.
        </p>

        <div className={styles.phaseList}>
          {isLoading ? (
            <div className={styles.loading}>Loading job titles...</div>
          ) : items.length === 0 ? (
            <div className={styles.empty}>No job titles. Add one below.</div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className={`
                  ${styles.phaseItem}
                  ${!item.is_active ? styles.inactive : ''}
                  ${draggedId === item.id ? styles.dragging : ''}
                  ${dragOverId === item.id && dragOverPosition === 'before' ? styles.dropBefore : ''}
                  ${dragOverId === item.id && dragOverPosition === 'after' ? styles.dropAfter : ''}
                `}
                draggable={canManage}
                onDragStart={(e) => handleDragStart(e, item.id)}
                onDragOver={(e) => handleDragOver(e, item.id)}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              >
                {canManage && (
                  <div className={styles.dragHandle}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="8" y1="6" x2="16" y2="6" />
                      <line x1="8" y1="12" x2="16" y2="12" />
                      <line x1="8" y1="18" x2="16" y2="18" />
                    </svg>
                  </div>
                )}

                <div className={styles.phaseName}>
                  {editingId === item.id ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => handleUpdateName(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleUpdateName(item.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <span
                      onClick={() => canManage && startEditing(item)}
                      className={canManage ? styles.editable : ''}
                    >
                      {item.name}
                    </span>
                  )}
                </div>

                {canManage && (
                  <div className={styles.phaseActions}>
                    <button
                      className={`${styles.actionBtn} ${item.is_active ? styles.active : ''}`}
                      onClick={() => handleToggleActive(item)}
                      title={item.is_active ? 'Deactivate' : 'Activate'}
                    >
                      {item.is_active ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                          <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                        </svg>
                      )}
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.delete}`}
                      onClick={() => handleDelete(item)}
                      title="Delete"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {canManage && (
          <div className={styles.addSection}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New job title..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
            />
            <Button onClick={handleAdd} disabled={isAdding || !newName.trim()}>
              {isAdding ? 'Adding...' : 'Add Job Title'}
            </Button>
          </div>
        )}

        <div className={styles.footer}>
          <Button variant="secondary" onClick={closeModal}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
