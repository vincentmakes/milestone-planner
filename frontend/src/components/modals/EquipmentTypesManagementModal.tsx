/**
 * EquipmentTypesManagementModal
 * 
 * Modal for managing equipment types (CRUD operations).
 * Types are derived from equipment - this modal allows renaming and viewing usage.
 * Only accessible to SuperUsers and Admins.
 */

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { apiGet, apiPut } from '@/api/client';
import type { Equipment } from '@/types';
import styles from './EquipmentTypesManagementModal.module.css';

interface EquipmentTypesManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTypesChanged?: () => void;
}

interface TypeInfo {
  name: string;
  count: number;
}

export function EquipmentTypesManagementModal({ 
  isOpen, 
  onClose,
  onTypesChanged 
}: EquipmentTypesManagementModalProps) {
  // State
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Load types and equipment
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Load all equipment to get types and counts
      const equipment = await apiGet<Equipment[]>('/api/equipment/all');
      setAllEquipment(equipment);
      
      // Calculate type counts
      const typeCounts = new Map<string, number>();
      equipment.forEach(eq => {
        if (eq.type) {
          typeCounts.set(eq.type, (typeCounts.get(eq.type) || 0) + 1);
        }
      });
      
      // Convert to array and sort
      const typeInfos: TypeInfo[] = Array.from(typeCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      setTypes(typeInfos);
    } catch (err) {
      console.error('Failed to load equipment types:', err);
      setError('Failed to load equipment types');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, loadData]);
  
  // Handle edit
  const handleEdit = (typeName: string) => {
    setEditingType(typeName);
    setIsCreating(false);
  };
  
  // Handle create
  const handleCreate = () => {
    setEditingType(null);
    setIsCreating(true);
  };
  
  // Handle close form
  const handleCloseForm = () => {
    setEditingType(null);
    setIsCreating(false);
  };
  
  // Handle save
  const handleSave = async () => {
    await loadData();
    onTypesChanged?.();
    handleCloseForm();
  };
  
  // Handle delete
  const handleDelete = async (typeName: string) => {
    const typeInfo = types.find(t => t.name === typeName);
    if (!typeInfo) return;
    
    if (typeInfo.count > 0) {
      setError(`Cannot delete "${typeName}": ${typeInfo.count} equipment item(s) still use this type. Change their type first.`);
      return;
    }
    
    // Type has no equipment - just remove from local list
    // (It was derived from equipment, so if no equipment uses it, it's effectively deleted)
    setTypes(prev => prev.filter(t => t.name !== typeName));
  };
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Equipment Types"
      size="md"
    >
      <div className={styles.container}>
        {(editingType || isCreating) ? (
          <TypeForm
            typeName={editingType}
            existingTypes={types.map(t => t.name)}
            allEquipment={allEquipment}
            onSave={handleSave}
            onCancel={handleCloseForm}
          />
        ) : (
          <>
            {/* Toolbar */}
            <div className={styles.toolbar}>
              <span className={styles.count}>{types.length} type{types.length !== 1 ? 's' : ''}</span>
              <Button onClick={handleCreate}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Type
              </Button>
            </div>
            
            {error && (
              <div className={styles.error}>{error}</div>
            )}
            
            {/* Types list */}
            <div className={styles.listWrapper}>
              {isLoading ? (
                <div className={styles.loading}>Loading types...</div>
              ) : types.length === 0 ? (
                <div className={styles.empty}>
                  <p>No equipment types defined yet</p>
                  <p className={styles.emptyHint}>Types are created when you add equipment</p>
                </div>
              ) : (
                <div className={styles.list}>
                  {types.map((typeInfo) => (
                    <div key={typeInfo.name} className={styles.typeItem}>
                      <div className={styles.typeInfo}>
                        <span className={styles.typeName}>{typeInfo.name}</span>
                        <span className={styles.typeCount}>
                          {typeInfo.count} equipment item{typeInfo.count !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className={styles.typeActions}>
                        <button 
                          className={styles.actionBtn}
                          onClick={() => handleEdit(typeInfo.name)}
                          title="Rename type"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button 
                          className={`${styles.actionBtn} ${styles.deleteBtn}`}
                          onClick={() => handleDelete(typeInfo.name)}
                          title={typeInfo.count > 0 ? 'Cannot delete: type is in use' : 'Delete type'}
                          disabled={typeInfo.count > 0}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className={styles.infoNote}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>Equipment types are shared across all sites</span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// =============================================================================
// TYPE FORM COMPONENT
// =============================================================================

interface TypeFormProps {
  typeName: string | null; // null = creating new
  existingTypes: string[];
  allEquipment: Equipment[];
  onSave: () => void;
  onCancel: () => void;
}

function TypeForm({ typeName, existingTypes, allEquipment, onSave, onCancel }: TypeFormProps) {
  const isEditing = !!typeName;
  
  // Form state
  const [name, setName] = useState(typeName || '');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Equipment using this type (for editing)
  const equipmentCount = isEditing
    ? allEquipment.filter(eq => eq.type === typeName).length
    : 0;
  
  // Handle form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    const trimmedName = name.trim();
    
    if (!trimmedName) {
      setError('Type name is required');
      return;
    }
    
    // Check for duplicate (case-insensitive, excluding current type)
    const isDuplicate = existingTypes.some(
      t => t.toLowerCase() === trimmedName.toLowerCase() && t !== typeName
    );
    if (isDuplicate) {
      setError('A type with this name already exists');
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      if (isEditing && typeName) {
        // Rename type - updates all equipment with this type
        await apiPut(`/api/equipment-types/${encodeURIComponent(typeName)}?new_type=${encodeURIComponent(trimmedName)}`);
      } else {
        // Creating a new type - we don't actually create it in DB
        // It will be created when equipment uses it
        // For now, just close the form - the user will see it when they create equipment
        // Actually, let's add it to local state via callback
      }
      onSave();
    } catch (err) {
      console.error('Failed to save type:', err);
      let message = 'Failed to save type';
      if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Rename Type' : 'Add Type'}</h3>
        <button 
          type="button" 
          className={styles.backBtn}
          onClick={onCancel}
        >
          ← Back to list
        </button>
      </div>
      
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      {/* Type Name */}
      <div className={styles.field}>
        <label htmlFor="typeName">Name *</label>
        <input
          type="text"
          id="typeName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Pilot Plant, Analytical Device"
          required
          autoFocus
        />
      </div>
      
      {isEditing && equipmentCount > 0 && (
        <div className={styles.renameWarning}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Renaming will update {equipmentCount} equipment item{equipmentCount !== 1 ? 's' : ''}
          </span>
        </div>
      )}
      
      {!isEditing && (
        <div className={styles.createNote}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>New types become available when creating equipment</span>
        </div>
      )}
      
      {/* Form Actions */}
      <div className={styles.formActions}>
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Saving...' : (isEditing ? 'Rename Type' : 'Add Type')}
        </Button>
      </div>
    </form>
  );
}
