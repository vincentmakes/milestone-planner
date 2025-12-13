/**
 * Main Layout
 * The primary application layout after authentication
 */

import { useAppStore } from '@/stores/appStore';
import { useKeyboardShortcuts } from '@/hooks';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ResourcePanel } from './ResourcePanel';
import { GanttContainer } from '@/components/gantt';
import { ShiftTooltip } from '@/components/gantt/ShiftTooltip';
import { StaffView, EquipmentView, CrossSiteView, ArchivedView } from '@/components/views';
import styles from './MainLayout.module.css';

export function MainLayout() {
  const currentView = useAppStore((s) => s.currentView);

  // Enable global keyboard shortcuts
  useKeyboardShortcuts();

  // Render the appropriate view based on currentView
  const renderView = () => {
    switch (currentView) {
      case 'gantt':
        return <GanttContainer />;
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

  // Determine if ResourcePanel should be shown (not for crosssite/archived)
  const showResourcePanel = currentView === 'gantt';

  return (
    <div className={styles.container}>
      <Header />
      
      <div className={styles.body}>
        <Sidebar />
        
        <main className={styles.main}>
          {renderView()}
        </main>
        
        {showResourcePanel && <ResourcePanel />}
      </div>
      
      {/* Shift+hover tooltip for phases/subphases */}
      <ShiftTooltip />
      
      {/* Modals are rendered by ModalContainer in App.tsx */}
    </div>
  );
}
