/**
 * SkillsPanel (Settings hub > Skills)
 * 
 * Manage skills (CRUD operations).
 * Only accessible to SuperUsers and Admins.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/common/Button';
import { PanelToolbar } from '../PanelToolbar';
import { BackIcon, EditIcon, PlusIcon, TrashIcon } from './PanelIcons';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { skillsApi } from '@/api/endpoints/skills';
import type { Skill } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import styles from './SkillsPanel.module.css';

// Default colors for skills
const SKILL_COLORS = [
  '#3b82f6', // Blue
  '#8b5cf6', // Purple
  '#10b981', // Green
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#84cc16', // Lime
  '#f97316', // Orange
  '#6366f1', // Indigo
];

export function SkillsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setSkills = useAppStore((s) => s.setSkills);
  
  // State
  const [skills, setLocalSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Load skills
  const loadSkills = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await skillsApi.getAll();
      setLocalSkills(data);
      setSkills(data); // Update global state
    } catch (err) {
      console.error('Failed to load skills:', err);
      setError('Failed to load skills');
    } finally {
      setIsLoading(false);
    }
  }, [setSkills]);
  
  useEffect(() => {
    loadSkills();
  }, [loadSkills]);
  
  // Handle edit
  const handleEdit = (skill: Skill) => {
    setEditingSkill(skill);
    setIsCreating(false);
  };
  
  // Handle create
  const handleCreate = () => {
    setEditingSkill(null);
    setIsCreating(true);
  };
  
  // Handle close form
  const handleCloseForm = () => {
    setEditingSkill(null);
    setIsCreating(false);
  };
  
  // Handle save
  const handleSave = async () => {
    await loadSkills();
    handleCloseForm();
  };
  
  // Handle delete
  const handleDelete = async (skillId: number) => {
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return;
    
    const confirmed = window.confirm(
      `Are you sure you want to delete "${skill.name}"?\n\nThis will remove the skill from all users who have it assigned.`
    );
    
    if (!confirmed) return;
    
    try {
      await skillsApi.delete(skillId);
      await loadSkills();
    } catch (err) {
      console.error('Failed to delete skill:', err);
      setError('Failed to delete skill');
    }
  };
  
  return (
    <div className={styles.container}>
      {(editingSkill || isCreating) ? (
        <SkillForm
          skill={editingSkill}
          onSave={handleSave}
          onCancel={handleCloseForm}
          onDirtyChange={onDirtyChange}
        />
      ) : (
        <>
          {/* Toolbar */}
          <PanelToolbar
            left={<span className={styles.count}>{skills.length} skills</span>}
            right={
              <Button icon={<PlusIcon />} onClick={handleCreate}>
                Add Skill
              </Button>
            }
          />
          
          {error && (
            <div className={styles.error}>{error}</div>
          )}
          
          {/* Skills list */}
          <div className={styles.listWrapper}>
            {isLoading ? (
              <div className={styles.loading}>Loading skills...</div>
            ) : skills.length === 0 ? (
              <div className={styles.empty}>
                <p>No skills defined yet</p>
                <p className={styles.emptyHint}>Click "Add Skill" to create your first skill</p>
              </div>
            ) : (
              <div className={styles.list}>
                {skills.map((skill) => (
                  <div key={skill.id} className={styles.skillItem}>
                    <div className={styles.skillInfo}>
                      <span 
                        className={styles.colorDot}
                        style={{ backgroundColor: skill.color }}
                      />
                      <div className={styles.skillText}>
                        <span className={styles.skillName}>{skill.name}</span>
                        {skill.description && (
                          <span className={styles.skillDesc}>{skill.description}</span>
                        )}
                      </div>
                    </div>
                    <div className={styles.skillActions}>
                      <button 
                        className={styles.actionBtn}
                        onClick={() => handleEdit(skill)}
                        title="Edit skill"
                        aria-label={`Edit ${skill.name}`}
                      >
                        <EditIcon />
                      </button>
                      <button 
                        className={`${styles.actionBtn} ${styles.deleteBtn}`}
                        onClick={() => handleDelete(skill.id)}
                        title="Delete skill"
                        aria-label={`Delete ${skill.name}`}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// SKILL FORM COMPONENT
// =============================================================================

interface SkillFormProps {
  skill: Skill | null;
  onSave: () => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function SkillForm({ skill, onSave, onCancel, onDirtyChange }: SkillFormProps) {
  const isEditing = !!skill;
  
  // Form state
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [color, setColor] = useState(skill?.color || SKILL_COLORS[0]);
  
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  useReportDirty(
    onDirtyChange,
    name !== (skill?.name || '') ||
      description !== (skill?.description || '') ||
      color !== (skill?.color || SKILL_COLORS[0])
  );
  
  // Handle form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    if (!name.trim()) {
      setError('Skill name is required');
      return;
    }
    
    if (!beginSubmit()) return;
    
    try {
      if (isEditing && skill) {
        await skillsApi.update(skill.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          color,
        });
      } else {
        await skillsApi.create({
          name: name.trim(),
          description: description.trim() || undefined,
          color,
        });
      }
      onSave();
    } catch (err) {
      console.error('Failed to save skill:', err);
      let message = 'Failed to save skill';
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
        <h3>{isEditing ? 'Edit Skill' : 'Add Skill'}</h3>
        <Button type="button" variant="ghost" icon={<BackIcon />} onClick={onCancel}>
          Back to list
        </Button>
      </div>
      
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      {/* Skill Name */}
      <div className={styles.field}>
        <label htmlFor="skillName">Name *</label>
        <input
          type="text"
          id="skillName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Project Management"
          required
          maxLength={100}
        />
      </div>
      
      {/* Description */}
      <div className={styles.field}>
        <label htmlFor="skillDesc">Description</label>
        <input
          type="text"
          id="skillDesc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
        />
      </div>
      
      {/* Color Picker */}
      <div className={styles.field}>
        <label>Color</label>
        <div className={styles.colorPicker}>
          {SKILL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`${styles.colorOption} ${color === c ? styles.selected : ''}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
              aria-label={`Use colour ${c}`}
              aria-pressed={color === c}
              title={c}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className={styles.customColor}
            title="Custom color"
          />
        </div>
        <div className={styles.colorPreview}>
          <span 
            className={styles.previewDot}
            style={{ backgroundColor: color }}
          />
          <span className={styles.previewText}>{name || 'Skill Name'}</span>
        </div>
      </div>
      
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
          {isSubmitting ? 'Saving...' : (isEditing ? 'Save Changes' : 'Create Skill')}
        </Button>
      </div>
    </form>
  );
}
