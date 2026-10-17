/**
 * EquipmentPanel (Settings hub > Equipment)
 *
 * Admin/SuperUser panel for managing equipment - list, create, edit, delete.
 * Equipment can be available on several sites (like staff); equipment types
 * are shared across all sites. Superusers only target their own sites, and
 * can't edit equipment also linked to a site they don't manage (the backend
 * answers 403).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { PanelToolbar } from '../PanelToolbar';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { apiGet, apiPost, apiPut, apiDelete } from '@/api/client';
import { getEquipment } from '@/api/endpoints/equipment';
import type { Equipment, Site } from '@/types';
import { useManageableSites } from './calendarUtils';
import { BackIcon, CheckIcon, CloseIcon, EditIcon, GearIcon, PlusIcon } from './PanelIcons';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './EquipmentPanel.module.css';

/** Sites an equipment item is on (older servers only send site_id) */
function equipmentSiteIds(eq: Equipment): number[] {
  return eq.site_ids && eq.site_ids.length > 0 ? eq.site_ids : [eq.site_id];
}

const SHARED_EQUIPMENT_TITLE = "Shared with sites you don't manage";

export function EquipmentPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const openSettings = useUIStore((s) => s.openSettings);
  const sites = useAppStore((s) => s.sites);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentSite = useAppStore((s) => s.currentSite);
  const setEquipment = useAppStore((s) => s.setEquipment);
  const manageableSites = useManageableSites();

  const isAdmin = currentUser?.role === 'admin';
  const canManage = isAdmin || currentUser?.role === 'superuser';
  const manageableIds = useMemo(() => manageableSites.map((s) => s.id), [manageableSites]);

  /** Linked sites the user can't manage (always none for admins) */
  const foreignSiteIds = useCallback(
    (eq: Equipment) => (isAdmin ? [] : equipmentSiteIds(eq).filter((id) => !manageableIds.includes(id))),
    [isAdmin, manageableIds]
  );
  
  // State
  const [equipment, setLocalEquipment] = useState<Equipment[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | 'all'>(currentSite?.id || 'all');
  const siteFilterOptions = useMemo(
    () => [
      { value: 'all', label: 'All Sites' },
      ...sites.map((site) => ({ value: site.id, label: site.name })),
    ],
    [sites]
  );
  const [showInactive, setShowInactive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<Equipment | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  
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
    loadEquipment();
  }, [loadEquipment]);
  
  // Filter equipment by site and active status
  const filteredEquipment = equipment.filter(eq => {
    if (selectedSiteId !== 'all' && !equipmentSiteIds(eq).includes(selectedSiteId)) return false;
    if (!showInactive && !eq.active) return false;
    return true;
  });

  // Site names of an equipment item, comma separated. /equipment/all sends
  // site_names alongside site_ids (same order); prefer those, since the store
  // only holds a superuser's own sites and a shared item would read "Unknown".
  const getSiteNames = (eq: Equipment) => {
    const siteIds = equipmentSiteIds(eq);
    const serverNames = eq.site_names?.length === siteIds.length ? eq.site_names : undefined;
    return siteIds
      .map((id, i) => serverNames?.[i] || sites.find((s) => s.id === id)?.name || `Site #${id}`)
      .join(', ');
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
  
  // After a save or delete: reload the list, and refresh the global store with
  // the per-site rows every equipment filter expects (not /all)
  const refreshAfterChange = async () => {
    await loadEquipment();
    setEquipment(await getEquipment(true));
    handleCloseForm();
  };

  // Handle save
  const handleSave = async () => {
    await refreshAfterChange();
  };

  // Handle delete
  const handleDelete = async () => {
    await refreshAfterChange();
  };

  // The site the form starts on: the filter, else the current site, when manageable
  const defaultSiteId = (() => {
    const preferred = selectedSiteId !== 'all' ? selectedSiteId : currentSite?.id;
    if (preferred && manageableIds.includes(preferred)) return preferred;
    return manageableIds[0] ?? null;
  })();

  return (
    <div className={styles.container}>
      {(editingEquipment || isCreating) ? (
        <EquipmentForm
          equipment={editingEquipment}
          sites={manageableSites}
          existingTypes={existingTypes}
          defaultSiteId={defaultSiteId}
          onSave={handleSave}
          onDelete={handleDelete}
          onCancel={handleCloseForm}
          canDelete={canManage}
          onDirtyChange={onDirtyChange}
        />
      ) : (
      <>
        {/* Toolbar */}
        <PanelToolbar
          align="end"
          left={
            <div className={styles.filters}>
              <Select
                label="Site"
                className={styles.filterGroup}
                options={siteFilterOptions}
                value={selectedSiteId}
                onChange={(e) => setSelectedSiteId(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              />
            
              <ToggleSwitch checked={showInactive} onChange={setShowInactive} label="Show inactive" />
            </div>
          }
          right={
            canManage && (
              <>
                <Button variant="secondary" icon={<GearIcon />} onClick={() => openSettings('equipment-types')}>
                  Manage Types
                </Button>
                <Button icon={<PlusIcon />} onClick={handleCreate}>
                  Add Equipment
                </Button>
              </>
            )
          }
        />
        
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
                  <th>Sites</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredEquipment.map((eq) => {
                  const siteNames = getSiteNames(eq);
                  const isShared = foreignSiteIds(eq).length > 0;
                  return (
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
                    <td className={styles.siteCell} title={siteNames}>{siteNames}</td>
                    <td>
                      {/* Disabled buttons swallow hover, so the tooltip sits on a wrapper */}
                      <span title={isShared ? SHARED_EQUIPMENT_TITLE : 'Edit equipment'}>
                        <button
                          className={styles.editBtn}
                          onClick={() => handleEdit(eq)}
                          disabled={isShared}
                          aria-label={`Edit ${eq.name}`}
                        >
                          <EditIcon />
                        </button>
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </>
    )}
  </div>
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
  onDirtyChange?: (dirty: boolean) => void;
}

function EquipmentForm({ 
  equipment, 
  sites, 
  existingTypes,
  defaultSiteId, 
  onSave, 
  onDelete, 
  onCancel,
  canDelete,
  onDirtyChange,
}: EquipmentFormProps) {
  const isEditing = !!equipment;
  
  // Form state
  const [name, setName] = useState(equipment?.name || '');
  const [type, setType] = useState(equipment?.type || '');
  const [isAddingNewType, setIsAddingNewType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  // Only equipment whose sites are all manageable reaches this form (the
  // panel disables Edit otherwise), so the original links are kept as is.
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>(
    equipment ? equipmentSiteIds(equipment) : defaultSiteId !== null ? [defaultSiteId] : []
  );
  const [active, setActive] = useState(equipment?.active ?? true);

  const toggleSite = (siteId: number) => {
    setSelectedSiteIds((prev) =>
      prev.includes(siteId) ? prev.filter((id) => id !== siteId) : [...prev, siteId]
    );
  };
  
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  // Deleting equipment cascades on the server (it bypasses the What-If queue as
  // configuration) while the sandbox keeps showing the orphaned plan data, so
  // it is unavailable during What-If.
  const whatIf = useWhatIfBlocked();
  const deleteBlockedReason = whatIf.blocked ? whatIf.reason('Deleting equipment') : null;
  const [error, setError] = useState<string | null>(null);

  // The site links the form opened with (the default site is fixed at open)
  const [initialSiteIds] = useState(selectedSiteIds);
  useReportDirty(
    onDirtyChange,
    name !== (equipment?.name || '') ||
      type !== (equipment?.type || '') ||
      active !== (equipment?.active ?? true) ||
      (isAddingNewType && newTypeName.trim() !== '') ||
      selectedSiteIds.length !== initialSiteIds.length ||
      selectedSiteIds.some((id) => !initialSiteIds.includes(id))
  );
  
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
    
    if (selectedSiteIds.length === 0) {
      setError('Please select at least one site');
      return;
    }

    if (!beginSubmit()) return;

    try {
      // site_id stays the primary site (first selected) for older servers
      const data = {
        name: name.trim(),
        type: type.trim(),
        site_id: selectedSiteIds[0],
        site_ids: selectedSiteIds,
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
      endSubmit();
    }
  };
  
  // Handle delete
  const handleDelete = async () => {
    if (!equipment || deleteBlockedReason) return;
    
    const confirmed = await confirmAction({
      title: 'Delete equipment',
      message: `Are you sure you want to delete "${equipment.name}"?\n\nThis will also remove all assignments for this equipment.`,
      destructive: true,
    });
    
    if (!confirmed) return;
    
    if (!beginSubmit()) return;
    try {
      await apiDelete(`/api/equipment/${equipment.id}`);
      onDelete();
    } catch (err) {
      console.error('Failed to delete equipment:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete equipment');
    } finally {
      endSubmit();
    }
  };
  
  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.formHeader}>
        <h3>{isEditing ? 'Edit Equipment' : 'Add Equipment'}</h3>
        <Button type="button" variant="ghost" icon={<BackIcon />} onClick={onCancel}>
          Back to list
        </Button>
      </div>
      
      {error && <Notice tone="error">{error}</Notice>}
      
      <div className={styles.formFields}>
        {/* Name */}
        <Input
          label="Name *"
          type="text"
          id="equipName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Pilot Plant A, Mass Spec 1"
          required
        />
        
        {/* Type */}
        <div className={styles.field}>
          <label>Type *</label>
          {isAddingNewType ? (
            <div className={styles.newTypeInput}>
              <Input
                className={styles.newTypeField}
                aria-label="New equipment type"
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
                    // Cancel the inline input only; keep the dialog open
                    e.preventDefault();
                    e.stopPropagation();
                    cancelNewType();
                  }
                }}
              />
              <button type="button" className={styles.confirmBtn} onClick={confirmNewType} aria-label="Add type" title="Add type">
                <CheckIcon />
              </button>
              <button type="button" className={styles.cancelBtn} onClick={cancelNewType} aria-label="Cancel adding a type" title="Cancel">
                <CloseIcon />
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
        
        {/* Sites (one or more) */}
        <div className={styles.field}>
          <label>Sites *</label>
          <div className={styles.siteOptions} role="group" aria-label="Equipment sites">
            {sites.map(site => (
              <label
                key={site.id}
                className={`${styles.siteOption} ${selectedSiteIds.includes(site.id) ? styles.selected : ''}`}
              >
                <input
                  type="checkbox"
                  name="equipSite"
                  value={site.id}
                  checked={selectedSiteIds.includes(site.id)}
                  onChange={() => toggleSite(site.id)}
                />
                <span className={styles.siteOptionLabel}>{site.name}</span>
              </label>
            ))}
            {sites.length === 0 && <span className={styles.hint}>No sites available</span>}
          </div>
          <span className={styles.hint}>
            Select every site where this equipment can be booked
          </span>
        </div>
        
        {/* Active Status (only for editing) */}
        {isEditing && (
          <div className={styles.field}>
            <label>Status</label>
            <ToggleSwitch
              className={styles.toggleLabel}
              checked={active}
              onChange={setActive}
              label="Active"
            />
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
            disabled={isSubmitting || deleteBlockedReason !== null}
            title={deleteBlockedReason ?? undefined}
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
            loading={isSubmitting}
          >
            {isEditing ? 'Save Changes' : 'Create Equipment'}
          </Button>
        </div>
      </div>
    </form>
  );
}
