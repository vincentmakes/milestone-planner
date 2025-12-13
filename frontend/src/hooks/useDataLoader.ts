/**
 * useDataLoader Hook
 * Handles loading all application data after authentication
 */

import { useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { 
  getSites, 
  getStaff, 
  getEquipment, 
  getVacations, 
  loadAllProjects,
  getBankHolidays,
  buildHolidayDateSet,
  getInstanceSettings,
} from '@/api';

interface UseDataLoaderReturn {
  isLoading: boolean;
  error: string | null;
  loadAllData: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshSiteData: (siteId: number) => Promise<void>;
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
    setCurrentSite,
    setInstanceSettings,
  } = useAppStore();

  /**
   * Load all initial data
   */
  const loadAllData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      console.log('[DataLoader] Loading all data...');

      // Load core data in parallel
      const [sites, staff, equipment, vacations, instanceSettings] = await Promise.all([
        getSites(),
        getStaff(true), // Include all sites
        getEquipment(true), // Include all sites
        getVacations(),
        getInstanceSettings().catch(() => null), // Don't fail if settings not available
      ]);

      console.log('[DataLoader] Loaded:', {
        sites: sites.length,
        staff: staff.length,
        equipment: equipment.length,
        vacations: vacations.length,
        instanceSettings: instanceSettings ? 'yes' : 'no',
      });

      // Update store
      setSites(sites);
      setStaff(staff);
      setEquipment(equipment);
      setVacations(vacations);
      if (instanceSettings) {
        setInstanceSettings(instanceSettings);
      }

      // Restore current site from persisted storage or use first site
      if (sites.length > 0) {
        // Sort sites by ID for consistent ordering
        const sortedSites = [...sites].sort((a, b) => a.id - b.id);
        
        // Check for persisted site ID in localStorage
        let targetSite = sortedSites[0];
        console.log('[DataLoader] Default site (first by ID):', targetSite.name, 'id:', targetSite.id);
        
        try {
          const stored = localStorage.getItem('milestone-app-storage');
          console.log('[DataLoader] Raw localStorage:', stored);
          
          if (stored) {
            const parsed = JSON.parse(stored);
            const persistedSiteId = parsed?.state?.currentSiteId;
            console.log('[DataLoader] Looking for persisted site ID:', persistedSiteId, 'type:', typeof persistedSiteId);
            console.log('[DataLoader] Available sites:', sortedSites.map(s => ({ id: s.id, name: s.name, type: typeof s.id })));
            
            if (persistedSiteId != null) {
              // Ensure numeric comparison
              const siteIdNum = Number(persistedSiteId);
              const foundSite = sortedSites.find(s => Number(s.id) === siteIdNum);
              console.log('[DataLoader] Comparison: looking for', siteIdNum, 'type:', typeof siteIdNum);
              
              if (foundSite) {
                targetSite = foundSite;
                console.log('[DataLoader] ✓ Restored persisted site:', targetSite.name, 'id:', targetSite.id);
              } else {
                console.log('[DataLoader] ✗ Site ID', siteIdNum, 'not found in available sites');
              }
            } else {
              console.log('[DataLoader] No persistedSiteId in stored state');
            }
          } else {
            console.log('[DataLoader] No stored state in localStorage');
          }
        } catch (e) {
          console.warn('[DataLoader] Failed to restore persisted site:', e);
        }
        
        console.log('[DataLoader] Final selected site:', targetSite.name, 'id:', targetSite.id);
        setCurrentSite(targetSite);
        
        // Load bank holidays for restored site
        const holidays = await getBankHolidays(targetSite.id);
        const holidayDates = buildHolidayDateSet(holidays);
        setBankHolidays(holidays, holidayDates);
      }

      // Load projects with full details
      const projects = await loadAllProjects();
      setProjects(projects);
      console.log('[DataLoader] Loaded projects:', projects.length);

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
    setCurrentSite,
    setInstanceSettings,
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
   * Refresh data for a specific site (bank holidays)
   */
  const refreshSiteData = useCallback(async (siteId: number) => {
    try {
      const holidays = await getBankHolidays(siteId);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
    } catch (err) {
      console.error('[DataLoader] Failed to refresh site data:', err);
    }
  }, [setBankHolidays]);

  return {
    isLoading,
    error,
    loadAllData,
    refreshProjects,
    refreshSiteData,
  };
}
