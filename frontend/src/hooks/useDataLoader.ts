/**
 * useDataLoader Hook
 * Handles loading all application data after authentication
 */

import { useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { 
  getSites, 
  getStaff, 
  getEquipment, 
  getVacations, 
  loadAllProjects,
  getBankHolidays,
  buildHolidayDateSet,
  getCompanyEvents,
  buildEventDateSet,
  getInstanceSettings,
  getCustomColumnsWithValues,
  skillsApi,
} from '@/api';

interface UseDataLoaderReturn {
  isLoading: boolean;
  error: string | null;
  loadAllData: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSiteData: (siteId: number) => Promise<void>;
  refreshCustomColumns: (siteId: number) => Promise<void>;
  refreshStaff: () => Promise<void>;
}

export function useDataLoader(): UseDataLoaderReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const {
    setSites,
    setProjects,
    setStaff,
    setEquipment,
    setVacations,
    setBankHolidays,
    setCompanyEvents,
    setCurrentSite,
    setInstanceSettings,
    setSkills,
  } = useAppStore();

  const {
    setCustomColumns,
    setCustomColumnValues,
  } = useCustomColumnStore();

  // Get persisted site ID from store (restored by Zustand persist)
  const persistedSiteId = useAppStore((s) => s._persistedSiteId);

  /**
   * Load all initial data
   */
  const loadAllData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Load core data in parallel
      const [sites, staff, equipment, vacations, instanceSettings, skills] = await Promise.all([
        getSites(),
        getStaff(true), // Include all sites
        getEquipment(true), // Include all sites
        getVacations(),
        getInstanceSettings().catch(() => null), // Don't fail if settings not available
        skillsApi.getAll().catch(() => []), // Don't fail if skills not available
      ]);

      // Update store
      setSites(sites);
      setStaff(staff);
      setEquipment(equipment);
      setVacations(vacations);
      setSkills(skills);
      if (instanceSettings) {
        setInstanceSettings(instanceSettings);
      }

      // Restore current site from persisted storage or use first site
      if (sites.length > 0) {
        // Sort sites by ID for consistent ordering
        const sortedSites = [...sites].sort((a, b) => a.id - b.id);
        
        // Check for persisted site ID from store (restored by Zustand persist)
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
    setVacations,
    setBankHolidays,
    setCompanyEvents,
    setCurrentSite,
    setInstanceSettings,
    setSkills,
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

  return {
    isLoading,
    error,
    loadAllData,
    refreshProjects,
    refreshSiteData,
    refreshCustomColumns,
    refreshStaff,
  };
}
