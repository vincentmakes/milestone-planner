/**
 * Main Layout
 * The primary application layout after authentication
 */

import { useEffect } from 'react';
import { useViewStore } from '@/stores/viewStore';
import { useAppStore } from '@/stores/appStore';
import { useKeyboardShortcuts } from '@/hooks';
import { useAllowedViews } from '@/hooks/useAllowedViews';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { selectSite } from '@/hooks/useDataLoader';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { GanttContainer } from '@/components/gantt';
import { ShiftTooltip } from '@/components/gantt/ShiftTooltip';
import { FlashNotice } from './FlashNotice';
import { KanbanView, WorkView, StaffView, EquipmentView, CrossSiteView, ArchivedView } from '@/components/views';
import styles from './MainLayout.module.css';

export function MainLayout() {
  const currentView = useViewStore((s) => s.currentView);
  const setCurrentView = useViewStore((s) => s.setCurrentView);
  const hasUser = useAppStore((s) => s.currentUser !== null);
  const sitesLoaded = useAppStore((s) => s.sites.length > 0);
  const currentSiteId = useAppStore((s) => s.currentSite?.id ?? null);
  const { visible } = useAllowedViews();
  const visibleSites = useVisibleSites();

  // Enable global keyboard shortcuts
  useKeyboardShortcuts();

  // The persisted view may not be allowed (anymore): a role edit took its
  // key away, or Cross-site lost its second visible site. Fall back to the
  // Gantt, which is always available. Every view waits for the sites to load,
  // so the first render before the data load does not drop Cross-site (hidden
  // while fewer than two sites are visible).
  useEffect(() => {
    if (!hasUser || !sitesLoaded || currentView === 'gantt') return;
    if (!visible.includes(currentView)) setCurrentView('gantt');
  }, [hasUser, currentView, visible, sitesLoaded, setCurrentView]);

  // A currentUser refresh (change:user / change:role) may take the current
  // site away: switch to the first visible one, like the site selector would.
  useEffect(() => {
    if (currentSiteId === null || visibleSites.length === 0) return;
    if (visibleSites.some((site) => site.id === currentSiteId)) return;
    const [first] = [...visibleSites].sort((a, b) => a.id - b.id);
    void selectSite(first);
  }, [currentSiteId, visibleSites]);

  // Render the appropriate view based on currentView
  const renderView = () => {
    switch (currentView) {
      case 'gantt':
        return <GanttContainer />;
      case 'kanban':
        return <KanbanView />;
      case 'work':
        return <WorkView />;
      case 'staff':
        return <StaffView />;
      case 'equipment':
        return <EquipmentView />;
      case 'crosssite':
        return <CrossSiteView />;
      case 'archived':
        return <ArchivedView />;
      default:
        return <GanttContainer />;
    }
  };

  return (
    <div className={styles.container}>
      <Header />
      
      <div className={styles.body}>
        <Sidebar />
        
        <main className={styles.main}>
          {renderView()}
        </main>
      </div>
      
      {/* Shift+hover tooltip for phases/subphases */}
      <ShiftTooltip />

      {/* Detached errors (context-menu deletes, refused links, failed card moves) */}
      <FlashNotice />
      
      {/* Modals are rendered by ModalContainer in App.tsx */}
    </div>
  );
}
