/**
 * Skills API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Skill } from '@/types';

export interface SkillCreate {
  name: string;
  description?: string;
  color?: string;
}

export interface SkillUpdate {
  name?: string;
  description?: string;
  color?: string;
}

export interface UserSkillAssignment {
  skill_ids: number[];
}

export const skillsApi = {
  // Get all skills
  getAll: () => 
    apiGet<Skill[]>('/api/skills'),

  // Get single skill
  get: (id: number) => 
    apiGet<Skill>(`/api/skills/${id}`),

  // Create skill
  create: (data: SkillCreate) => 
    apiPost<Skill>('/api/skills', data),

  // Update skill
  update: (id: number, data: SkillUpdate) => 
    apiPut<Skill>(`/api/skills/${id}`, data),

  // Delete skill
  delete: (id: number) => 
    apiDelete<void>(`/api/skills/${id}`),

  // Get user's skills
  getUserSkills: (userId: number) => 
    apiGet<Skill[]>(`/api/skills/user/${userId}`),

  // Update user's skills (replace all)
  updateUserSkills: (userId: number, skillIds: number[]) => 
    apiPut<Skill[]>(`/api/skills/user/${userId}`, { skill_ids: skillIds }),

  // Add single skill to user
  addUserSkill: (userId: number, skillId: number) => 
    apiPost<Skill[]>(`/api/skills/user/${userId}/${skillId}`),

  // Remove single skill from user
  removeUserSkill: (userId: number, skillId: number) => 
    apiDelete<Skill[]>(`/api/skills/user/${userId}/${skillId}`),
};
