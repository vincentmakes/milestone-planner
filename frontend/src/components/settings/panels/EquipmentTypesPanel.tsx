/**
 * EquipmentTypesPanel (Settings hub > Equipment types)
 * 
 * Types only exist through equipment (a type is the `type` string of at least
 * one equipment item; new types are created in the Equipment section). This
 * panel lists them with their usage, renames a type on every item at once,
 * and deletes a type through `DELETE /equipment-types/{name}`, which the
 * backend refuses while equipment still uses it (the reason is shown).
 * Only accessible to SuperUsers and Admins.
 */

import { useState, useEffect, useCallback } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { PanelToolbar } from '../PanelToolbar';
import { BackIcon, EditIcon, TrashIcon } from './PanelIcons';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { apiPut, apiDelete } from '@/api/client';
import { getAllEquipment, getEquipment } from '@/api/endpoints/equipment';
import type { Equipment } from '@/types';
import { useAppStore } from '@/stores/appStore';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './EquipmentTypesPanel.module.css';
import { can } from '@/utils/permissions';

interface TypeInfo {
  name: string;
  count: number;
}

/** The backend's "still in use" refusal (400 today, 409 planned) */
function isInUseError(message: string): boolean {
  return /in use|still use|409/i.test(message);
}

export function EquipmentTypesPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setEquipment = useAppStore((s) => s.setEquipment);
  // The store's per-site rows come from GET /equipment (views.equipment)
  const canViewEquipment = useAppStore((s) => can(s.currentUser, 'views.equipment'));
  
  // State
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingType, setEditingType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deleteGuard = useSubmitGuard();
  
  // Load types and equipment
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Load all equipment to get types and counts
      const equipment = await getAllEquipment();
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
      return equipment;
    } catch (err) {
      console.error('Failed to load equipment types:', err);
      setError('Failed to load equipment types');
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    loadData();
  }, [loadData]);
  
  // Handle edit
  const handleEdit = (typeName: string) => {
    setError(null);
    setEditingType(typeName);
  };
  
  // Handle close form
  const handleCloseForm = () => {
    setEditingType(null);
  };
  
  // Handle save
  const handleSave = async () => {
    // A rename changes the type on every equipment item: refresh the store too
    // (per-site rows, like the initial load — /all has one row per item)
    const equipment = await loadData();
    if (equipment && canViewEquipment) setEquipment(await getEquipment(true));
    handleCloseForm();
  };
  
  // Handle delete: the backend decides (the list may be stale), then reload
  const handleDelete = async (typeInfo: TypeInfo) => {
    const usage =
      typeInfo.count > 0
        ? `\n\n${typeInfo.count} equipment item${typeInfo.count !== 1 ? 's' : ''} use it; a type can only be deleted once no equipment uses it.`
        : '';
    const confirmed = await confirmAction({
      title: 'Delete equipment type',
      message: `Delete the equipment type "${typeInfo.name}"?${usage}`,
      destructive: true,
    });
    if (!confirmed) return;
    if (!deleteGuard.begin()) return;
    try {
      setError(null);
      try {
        await apiDelete(`/api/equipment-types/${encodeURIComponent(typeInfo.name)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        setError(
          isInUseError(message)
            ? `"${typeInfo.name}" is still used by equipment — change their type in Equipment first.`
            : message || 'Failed to delete the equipment type'
        );
        return;
      }
      const equipment = await loadData();
      if (equipment && canViewEquipment) setEquipment(await getEquipment(true));
    } finally {
      deleteGuard.end();
    }
  };
  
  return (
    <div className={styles.container}>
      {editingType ? (
        <TypeForm
          typeName={editingType}
          existingTypes={types.map(t => t.name)}
          allEquipment={allEquipment}
          onSave={handleSave}
          onCancel={handleCloseForm}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <>
          {/* Toolbar */}
          <PanelToolbar
            left={<span className={styles.count}>{types.length} type{types.length !== 1 ? 's' : ''}</span>}
          />
          
          {error && (
            <Notice tone="error">{error}</Notice>
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
                        aria-label={`Rename ${typeInfo.name}`}
                      >
                        <EditIcon />
                      </button>
                      <button 
                        className={`${styles.actionBtn} ${styles.deleteBtn}`}
                        onClick={() => handleDelete(typeInfo)}
                        title={typeInfo.count > 0 ? 'Delete type (only once no equipment uses it)' : 'Delete type'}
                        aria-label={`Delete ${typeInfo.name}`}
                        disabled={deleteGuard.isSubmitting}
                      >
                        <TrashIcon />
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
            <span>
              Equipment types are shared across all sites. New types are created when you add or
              edit equipment.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// TYPE FORM COMPONENT
// =============================================================================

interface TypeFormProps {
  /** The type being renamed */
  typeName: string;
  existingTypes: string[];
  allEquipment: Equipment[];
  onSave: () => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function TypeForm({ typeName, existingTypes, allEquipment, onSave, onCancel, onDirtyChange }: TypeFormProps) {
  // Form state
  const [name, setName] = useState(typeName);
  
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  useReportDirty(onDirtyChange, name !== typeName);
  
  // Equipment using this type
  const equipmentCount = allEquipment.filter(eq => eq.type === typeName).length;
  
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
    
    if (!beginSubmit()) return;
    
    try {
      // Rename type - updates all equipment with this type
      await apiPut(`/api/equipment-types/${encodeURIComponent(typeName)}?new_type=${encodeURIComponent(trimmedName)}`);
      onSave();
    } catch (err) {
      console.error('Failed to save type:', err);
      let message = 'Failed to save type';
      if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      endSubmit();
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>Rename Type</h3>
        <Button type="button" variant="ghost" icon={<BackIcon />} onClick={onCancel}>
          Back to list
        </Button>
      </div>
      
      {error && (
        <Notice tone="error">{error}</Notice>
      )}
      
      {/* Type Name */}
      <Input
        label="Name *"
        type="text"
        id="typeName"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Pilot Plant, Analytical Device"
        required
        autoFocus
      />
      
      {equipmentCount > 0 && (
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
          loading={isSubmitting}
        >
          Rename Type
        </Button>
      </div>
    </form>
  );
}
