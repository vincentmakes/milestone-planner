/**
 * useDataLoader Hook
 * Handles loading all application data after authentication
 */

import { useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { isForbidden } from '@/api/client';
import { can } from '@/utils/permissions';
import { visibleSitesFor } from './useVisibleSites';
import type { Site } from '@/types';
import type { PermissionKey } from '@/types/permissions';
import {
  getSites,
  getStaff,
  getEquipment,
  getEquipmentBlocks,
  getVacations,
  loadAllProjects,
  getBankHolidays,
  buildHolidayDateSet,
  getCompanyEvents,
  buildEventDateSet,
  getInstanceSettings,
  getCustomColumnsWithValues,
  skillsApi,
  tagsApi,
  tagGroupsApi,
  teamsApi,
  absenceTypesApi,
} from '@/api';

interface UseDataLoaderReturn {
  isLoading: boolean;
  error: string | null;
  loadAllData: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSiteData: (siteId: number) => Promise<void>;
  refreshCustomColumns: (siteId: number) => Promise<void>;
  refreshStaff: () => Promise<void>;
  refreshEquipmentBlocks: () => Promise<void>;
  refreshAbsenceTypes: () => Promise<void>;
  refreshTeams: () => Promise<void>;
  selectSite: (site: Site) => Promise<void>;
}

/**
 * A view-gated slice: requested only when the signed-in user holds `key`
 * (else empty, no request), and a 403 (the role changed meanwhile) is an
 * empty slice too. Any other failure propagates.
 */
export function loadGated<T>(key: PermissionKey, load: () => Promise<T[]>): Promise<T[]> {
  if (!can(useAppStore.getState().currentUser, key)) return Promise.resolve([]);
  return load().catch((err: unknown) => {
    if (isForbidden(err)) return [];
    throw err;
  });
}

/**
 * Make `site` the current site: clear the custom-column filters and load the
 * site's bank holidays, company events and custom columns. Each load failing
 * is logged and the others still run. Used by the header's site selector and
 * by MainLayout when the current site stops being visible.
 */
export async function selectSite(site: Site): Promise<void> {
  const app = useAppStore.getState();
  const columns = useCustomColumnStore.getState();
  app.setCurrentSite(site);
  columns.clearAllCustomColumnFilters();

  try {
    const holidays = await getBankHolidays(site.id);
    app.setBankHolidays(holidays, buildHolidayDateSet(holidays));
  } catch (err) {
    console.error('[DataLoader] Failed to load bank holidays:', err);
  }

  try {
    const events = await getCompanyEvents(site.id);
    app.setCompanyEvents(events, buildEventDateSet(events));
  } catch (err) {
    console.error('[DataLoader] Failed to load company events:', err);
  }

  try {
    const customColumnsData = await getCustomColumnsWithValues(site.id);
    columns.setCustomColumns(customColumnsData.columns);
    columns.setCustomColumnValues(customColumnsData.values);
  } catch (err) {
    console.error('[DataLoader] Failed to load custom columns:', err);
  }
}

export function useDataLoader(): UseDataLoaderReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Select the setters only (useShallow): destructuring the whole store
  // re-rendered the host (App) on every store change, e.g. each drag tick.
  const {
    setSites,
    setProjects,
    setStaff,
    setEquipment,
    setEquipmentBlocks,
    setVacations,
    setBankHolidays,
    setCompanyEvents,
    setCurrentSite,
    setInstanceSettings,
    setSkills,
    setTags,
    setTagGroups,
    setTeams,
    setAbsenceTypes,
  } = useAppStore(
    useShallow((s) => ({
      setSites: s.setSites,
      setProjects: s.setProjects,
      setStaff: s.setStaff,
      setEquipment: s.setEquipment,
      setEquipmentBlocks: s.setEquipmentBlocks,
      setVacations: s.setVacations,
      setBankHolidays: s.setBankHolidays,
      setCompanyEvents: s.setCompanyEvents,
      setCurrentSite: s.setCurrentSite,
      setInstanceSettings: s.setInstanceSettings,
      setSkills: s.setSkills,
      setTags: s.setTags,
      setTagGroups: s.setTagGroups,
      setTeams: s.setTeams,
      setAbsenceTypes: s.setAbsenceTypes,
    }))
  );

  const setCustomColumns = useCustomColumnStore((s) => s.setCustomColumns);
  const setCustomColumnValues = useCustomColumnStore((s) => s.setCustomColumnValues);

  /**
   * Load all initial data
   */
  const loadAllData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Load core data in parallel
      const [sites, staff, equipment, equipmentBlocks, vacations, instanceSettings, skills, tags, tagGroups, teams, absenceTypes] = await Promise.all([
        getSites(),
        getStaff(true), // Include all sites
        // Equipment is view-gated (views.equipment): empty without the key
        loadGated('views.equipment', () => getEquipment(true)), // Include all sites
        loadGated('views.equipment', () => getEquipmentBlocks()).catch(() => []),
        getVacations(),
        getInstanceSettings().catch(() => null), // Don't fail if settings not available
        skillsApi.getAll().catch(() => []), // Don't fail if skills not available
        tagsApi.getAll().catch(() => []), // Don't fail if tags not available
        tagGroupsApi.getAll().catch(() => []),
        teamsApi.getAll().catch(() => []), // Don't fail on servers without teams
        absenceTypesApi.getAll().catch(() => []), // Don't fail on servers without absence types
      ]);

      // Update store
      setSites(sites);
      setStaff(staff);
      setEquipment(equipment);
      setEquipmentBlocks(equipmentBlocks);
      setVacations(vacations);
      setSkills(skills);
      setTags(tags);
      setTagGroups(tagGroups);
      setTeams(teams);
      setAbsenceTypes(absenceTypes);
      if (instanceSettings) {
        setInstanceSettings(instanceSettings);
      }

      // Restore current site from persisted storage or use the first visible
      // site (sites.view_all: every site, else the user's own)
      const visibleSites = visibleSitesFor(useAppStore.getState().currentUser, sites);
      if (visibleSites.length > 0) {
        // Sort sites by ID for consistent ordering
        const sortedSites = [...visibleSites].sort((a, b) => a.id - b.id);
        
        // Read the persisted site ID now, not from a render-time selector:
        // this callback is memoised on stable setters only, so a captured
        // value would be the site from when the component mounted -- and a
        // reload after switching site would jump back to it.
        const persistedSiteId = useAppStore.getState()._persistedSiteId;
        let targetSite = sortedSites[0];
        
        if (persistedSiteId != null) {
          const foundSite = sortedSites.find(s => s.id === persistedSiteId);
          if (foundSite) {
            targetSite = foundSite;
          } else {
            // Site ID not found in available sites
          }
        }
        
        setCurrentSite(targetSite);
        
        // Load bank holidays for restored site
        const holidays = await getBankHolidays(targetSite.id);
        const holidayDates = buildHolidayDateSet(holidays);
        setBankHolidays(holidays, holidayDates);
        
        // Load company events for restored site
        const events = await getCompanyEvents(targetSite.id);
        const eventDates = buildEventDateSet(events);
        setCompanyEvents(events, eventDates);
        
        // Load custom columns and values for restored site
        try {
          const customColumnsData = await getCustomColumnsWithValues(targetSite.id);
          setCustomColumns(customColumnsData.columns);
          setCustomColumnValues(customColumnsData.values);
        } catch (err) {
          console.warn('[DataLoader] Failed to load custom columns:', err);
        }
      }

      // Load projects with full details
      const projects = await loadAllProjects();
      setProjects(projects);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load data';
      console.error('[DataLoader] Error:', message);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [
    setSites,
    setProjects,
    setStaff,
    setEquipment,
    setEquipmentBlocks,
    setVacations,
    setBankHolidays,
    setCompanyEvents,
    setCurrentSite,
    setInstanceSettings,
    setSkills,
    setTags,
    setTagGroups,
    setTeams,
    setAbsenceTypes,
    setCustomColumns,
    setCustomColumnValues,
  ]);

  /**
   * Refresh only projects data
   */
  const refreshProjects = useCallback(async () => {
    try {
      const projects = await loadAllProjects();
      setProjects(projects);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh projects:', err);
    }
  }, [setProjects]);

  /**
   * Refresh data for a specific site (bank holidays and company events)
   */
  const refreshSiteData = useCallback(async (siteId: number) => {
    try {
      const holidays = await getBankHolidays(siteId);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
      
      const events = await getCompanyEvents(siteId);
      const eventDates = buildEventDateSet(events);
      setCompanyEvents(events, eventDates);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh site data:', err);
    }
  }, [setBankHolidays, setCompanyEvents]);

  /**
   * Refresh custom columns for a specific site
   */
  const refreshCustomColumns = useCallback(async (siteId: number) => {
    try {
      const customColumnsData = await getCustomColumnsWithValues(siteId);
      setCustomColumns(customColumnsData.columns);
      setCustomColumnValues(customColumnsData.values);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh custom columns:', err);
    }
  }, [setCustomColumns, setCustomColumnValues]);

  /**
   * Refresh staff data (including their skills)
   */
  const refreshStaff = useCallback(async () => {
    try {
      const staff = await getStaff(true);
      setStaff(staff);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh staff:', err);
    }
  }, [setStaff]);

  /**
   * Refresh equipment blocks
   */
  const refreshEquipmentBlocks = useCallback(async () => {
    try {
      const blocks = await loadGated('views.equipment', () => getEquipmentBlocks());
      setEquipmentBlocks(blocks);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh equipment blocks:', err);
    }
  }, [setEquipmentBlocks]);

  /**
   * Refresh absence types (tenant-wide)
   */
  const refreshAbsenceTypes = useCallback(async () => {
    try {
      const absenceTypes = await absenceTypesApi.getAll();
      setAbsenceTypes(absenceTypes);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh absence types:', err);
    }
  }, [setAbsenceTypes]);

  /**
   * Refresh teams (every site)
   */
  const refreshTeams = useCallback(async () => {
    try {
      const teams = await teamsApi.getAll();
      setTeams(teams);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh teams:', err);
    }
  }, [setTeams]);

  return {
    isLoading,
    error,
    loadAllData,
    refreshProjects,
    refreshSiteData,
    refreshCustomColumns,
    refreshStaff,
    refreshEquipmentBlocks,
    refreshAbsenceTypes,
    refreshTeams,
    selectSite,
  };
}
