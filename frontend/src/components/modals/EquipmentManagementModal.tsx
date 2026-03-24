/**
 * EquipmentManagementModal
 * 
 * Admin/SuperUser modal for managing equipment - list, create, edit, delete.
 * Equipment is site-specific. Equipment types are shared across all sites.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { apiGet, apiPost, apiPut, apiDelete } from '@/api/client';
import { EquipmentTypesManagementModal } from './EquipmentTypesManagementModal';
import type { Equipment, Site } from '@/types';
import styles from './EquipmentManagementModal.module.css';

export function EquipmentManagementModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const sites = useAppStore((s) => s.sites);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentSite = useAppStore((s) => s.currentSite);
  const setEquipment = useAppStore((s) => s.setEquipment);
  
  const isOpen = activeModal === 'manageEquipment';
  const canManage = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // State
  const [equipment, setLocalEquipment] = useState<Equipment[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | 'all'>(currentSite?.id || 'all');
  const [showInactive, setShowInactive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<Equipment | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showTypesModal, setShowTypesModal] = useState(false);
  
  // Extract unique equipment types from existing equipment
  const existingTypes = useMemo(() => {
    const types = new Set<string>();
    equipment.forEach(eq => {
      if (eq.type) types.add(eq.type);
    });
    return Array.from(types).sort();
  }, [equipment]);
  
  // Load equipment when modal opens
  const loadEquipment = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiGet<Equipment[]>('/api/equipment/all');
      setLocalEquipment(data);
    } catch (err) {
      console.error('Failed to load equipment:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (isOpen) {
      loadEquipment();
      setSelectedSiteId(currentSite?.id || 'all');
    }
  }, [isOpen, loadEquipment, currentSite?.id]);
  
  // Filter equipment by site and active status
  const filteredEquipment = equipment.filter(eq => {
    if (selectedSiteId !== 'all' && eq.site_id !== selectedSiteId) return false;
    if (!showInactive && !eq.active) return false;
    return true;
  });
  
  // Get site name
  const getSiteName = (siteId: number) => {
    return sites.find(s => s.id === siteId)?.name || 'Unknown';
  };
  
  // Handle edit
  const handleEdit = (eq: Equipment) => {
    setEditingEquipment(eq);
    setIsCreating(false);
  };
  
  // Handle create
  const handleCreate = () => {
    setEditingEquipment(null);
    setIsCreating(true);
  };
  
  // Handle close form
  const handleCloseForm = () => {
    setEditingEquipment(null);
    setIsCreating(false);
  };
  
  // Handle save
  const handleSave = async () => {
    await loadEquipment();
    // Also update global store
    const allEquipment = await apiGet<Equipment[]>('/api/equipment/all');
    setEquipment(allEquipment);
    handleCloseForm();
  };
  
  // Handle delete
  const handleDelete = async () => {
    await loadEquipment();
    const allEquipment = await apiGet<Equipment[]>('/api/equipment/all');
    setEquipment(allEquipment);
    handleCloseForm();
  };
  
  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={closeModal}
        title="Equipment Management"
        size="lg"
      >
        <div className={styles.container}>
          {(editingEquipment || isCreating) ? (
            <EquipmentForm
              equipment={editingEquipment}
              sites={sites}
              existingTypes={existingTypes}
              defaultSiteId={selectedSiteId !== 'all' ? selectedSiteId : (currentSite?.id || null)}
              onSave={handleSave}
              onDelete={handleDelete}
              onCancel={handleCloseForm}
              canDelete={currentUser?.role === 'admin' || currentUser?.role === 'superuser'}
            />
          ) : (
          <>
            {/* Toolbar */}
            <div className={styles.toolbar}>
              <div className={styles.filters}>
                <div className={styles.filterGroup}>
                  <label>Site</label>
                  <select
                    value={selectedSiteId}
                    onChange={(e) => setSelectedSiteId(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
                  >
                    <option value="all">All Sites</option>
                    {sites.map(site => (
                      <option key={site.id} value={site.id}>{site.name}</option>
                    ))}
                  </select>
                </div>
                
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={showInactive}
                    onChange={(e) => setShowInactive(e.target.checked)}
                  />
                  <span>Show inactive</span>
                </label>
              </div>
              
              {canManage && (
                <div className={styles.toolbarButtons}>
                  <Button variant="secondary" onClick={() => setShowTypesModal(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Manage Types
                  </Button>
                  <Button onClick={handleCreate}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add Equipment
                  </Button>
                </div>
              )}
            </div>
            
            {/* Equipment list */}
            <div className={styles.tableWrapper}>
              {isLoading ? (
                <div className={styles.loading}>Loading equipment...</div>
              ) : filteredEquipment.length === 0 ? (
                <div className={styles.empty}>
                  {equipment.length === 0 
                    ? 'No equipment found' 
                    : 'No equipment matching filters'}
                </div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Site</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEquipment.map((eq) => (
                      <tr 
                        key={eq.id} 
                        className={!eq.active ? styles.inactive : ''}
                      >
                        <td>
                          <div className={styles.nameCell}>
                            <span className={styles.equipName}>{eq.name}</span>
                            {!eq.active && (
                              <span className={styles.inactiveBadge}>Inactive</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={styles.typeBadge}>{eq.type}</span>
                        </td>
                        <td className={styles.siteCell}>{getSiteName(eq.site_id)}</td>
                        <td>
                          <button 
                            className={styles.editBtn}
                            onClick={() => handleEdit(eq)}
                            title="Edit equipment"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
    
    {/* Equipment Types Management Modal */}
    <EquipmentTypesManagementModal
      isOpen={showTypesModal}
      onClose={() => setShowTypesModal(false)}
      onTypesChanged={loadEquipment}
    />
    </>
  );
}

// =============================================================================
// EQUIPMENT FORM COMPONENT
// =============================================================================

interface EquipmentFormProps {
  equipment: Equipment | null;
  sites: Site[];
  existingTypes: string[];
  defaultSiteId: number | null;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
  canDelete: boolean;
}

function EquipmentForm({ 
  equipment, 
  sites, 
  existingTypes,
  defaultSiteId, 
  onSave, 
  onDelete, 
  onCancel,
  canDelete 
}: EquipmentFormProps) {
  const isEditing = !!equipment;
  
  // Form state
  const [name, setName] = useState(equipment?.name || '');
  const [type, setType] = useState(equipment?.type || '');
  const [isAddingNewType, setIsAddingNewType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [siteId, setSiteId] = useState<number | null>(equipment?.site_id || defaultSiteId);
  const [active, setActive] = useState(equipment?.active ?? true);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Handle new type confirmation
  const confirmNewType = () => {
    if (newTypeName.trim()) {
      setType(newTypeName.trim());
      setIsAddingNewType(false);
    }
  };
  
  // Cancel new type
  const cancelNewType = () => {
    setIsAddingNewType(false);
    setNewTypeName('');
  };
  
  // Handle submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    if (!name.trim()) {
      setError('Equipment name is required');
      return;
    }
    
    if (!type.trim()) {
      setError('Equipment type is required');
      return;
    }
    
    if (!siteId) {
      setError('Please select a site');
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      const data = {
        name: name.trim(),
        type: type.trim(),
        site_id: siteId,
        active,
      };
      
      if (isEditing && equipment) {
        await apiPut(`/api/equipment/${equipment.id}`, data);
      } else {
        await apiPost('/api/equipment', data);
      }
      
      onSave();
    } catch (err) {
      console.error('Failed to save equipment:', err);
      setError(err instanceof Error ? err.message : 'Failed to save equipment');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Handle delete
  const handleDelete = async () => {
    if (!equipment) return;
    
    const confirmed = window.confirm(
      `Are you sure you want to delete "${equipment.name}"?\n\nThis will also remove all assignments for this equipment.`
    );
    
    if (!confirmed) return;
    
    setIsSubmitting(true);
    try {
      await apiDelete(`/api/equipment/${equipment.id}`);
      onDelete();
    } catch (err) {
      console.error('Failed to delete equipment:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete equipment');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Edit Equipment' : 'Add Equipment'}</h3>
        <button 
          type="button" 
          className={styles.backBtn}
          onClick={onCancel}
        >
          ← Back to list
        </button>
      </div>
      
      {error && <div className={styles.error}>{error}</div>}
      
      <div className={styles.formFields}>
        {/* Name */}
        <div className={styles.field}>
          <label htmlFor="equipName">Name *</label>
          <input
            type="text"
            id="equipName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Pilot Plant A, Mass Spec 1"
            required
          />
        </div>
        
        {/* Type */}
        <div className={styles.field}>
          <label>Type *</label>
          {isAddingNewType ? (
            <div className={styles.newTypeInput}>
              <input
                type="text"
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
                placeholder="Enter new equipment type"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmNewType();
                  } else if (e.key === 'Escape') {
                    cancelNewType();
                  }
                }}
              />
              <button type="button" className={styles.confirmBtn} onClick={confirmNewType}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button type="button" className={styles.cancelBtn} onClick={cancelNewType}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ) : type ? (
            // Show selected type with change button
            <div className={styles.selectedTypeDisplay}>
              <span className={styles.selectedTypeBadge}>{type}</span>
              <button 
                type="button" 
                className={styles.changeTypeBtn}
                onClick={() => setType('')}
              >
                Change
              </button>
            </div>
          ) : (
            // Show type selection options
            <div className={styles.typeOptions}>
              {existingTypes.map(t => (
                <button
                  key={t}
                  type="button"
                  className={styles.typeOption}
                  onClick={() => setType(t)}
                >
                  {t}
                </button>
              ))}
              <button
                type="button"
                className={`${styles.typeOption} ${styles.addNew}`}
                onClick={() => {
                  setIsAddingNewType(true);
                  setNewTypeName('');
                }}
              >
                + New type
              </button>
            </div>
          )}
          <span className={styles.hint}>
            Equipment types are shared across all sites
          </span>
        </div>
        
        {/* Site */}
        <div className={styles.field}>
          <label>Site *</label>
          <div className={styles.siteOptions}>
            {sites.map(site => (
              <label 
                key={site.id} 
                className={`${styles.siteOption} ${siteId === site.id ? styles.selected : ''}`}
              >
                <input
                  type="radio"
                  name="equipSite"
                  value={site.id}
                  checked={siteId === site.id}
                  onChange={() => setSiteId(site.id)}
                  required
                />
                <span className={styles.siteOptionLabel}>{site.name}</span>
              </label>
            ))}
          </div>
        </div>
        
        {/* Active Status (only for editing) */}
        {isEditing && (
          <div className={styles.field}>
            <label>Status</label>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span>Active</span>
            </label>
            <span className={styles.hint}>
              Inactive equipment won't appear in booking lists
            </span>
          </div>
        )}
      </div>
      
      {/* Form Actions */}
      <div className={styles.formActions}>
        {isEditing && canDelete && (
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={isSubmitting}
          >
            Delete Equipment
          </Button>
        )}
        
        <div className={styles.rightActions}>
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
            {isSubmitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create Equipment')}
          </Button>
        </div>
      </div>
    </form>
  );
}
