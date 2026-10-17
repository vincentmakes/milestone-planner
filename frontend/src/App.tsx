import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { useWhatIfStore } from './stores/whatIfStore';
import { useAuth } from './hooks/useAuth';
import { useDataLoader } from './hooks/useDataLoader';
import { LoadingScreen } from './components/screens/LoadingScreen';
import { LoginScreen } from './components/screens/LoginScreen';
import { LoadErrorScreen } from './components/screens/LoadErrorScreen';
import { MainLayout } from './components/layout/MainLayout';
import { ModalContainer } from './components/modals';
import { ContextMenuContainer } from './components/gantt/ContextMenuContainer';
import { AdminApp } from './components/admin';
import { WebSocketProvider } from './contexts/WebSocketContext';
import { ActivityFeed } from './components/common/ActivityFeed/ActivityFeed';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import './App.css';

/** The admin portal lives under /admin; everything else is the tenant app. */
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * The tenant application. Kept separate from App so the tenant auth check
 * (GET /api/auth/me) only runs outside the admin portal, which has its own
 * session and its own login.
 */
function TenantApp() {
  const { isLoading, isAuthenticated } = useAuth();
  const { loadAllData, isLoading: isDataLoading, error: loadError } = useDataLoader();
  const whatIfMode = useWhatIfStore((state) => state.whatIfMode);
  const instanceSettings = useAppStore((state) => state.instanceSettings);

  // Load data when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      loadAllData();
    }
  }, [isAuthenticated, loadAllData]);

  // Update document title when instance settings change
  useEffect(() => {
    document.title = instanceSettings?.instance_title || 'Milestone';
  }, [instanceSettings]);

  // Add/remove what-if-mode class on body
  useEffect(() => {
    if (whatIfMode) {
      document.body.classList.add('what-if-mode');
    } else {
      document.body.classList.remove('what-if-mode');
    }
    return () => {
      document.body.classList.remove('what-if-mode');
    };
  }, [whatIfMode]);

  // Show loading screen while checking auth
  if (isLoading) {
    return <LoadingScreen />;
  }

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Show loading screen while loading data
  if (isDataLoading) {
    return <LoadingScreen message="Loading data..." />;
  }

  // The initial load failed: an empty workspace would look like "no data".
  if (loadError) {
    return <LoadErrorScreen message={loadError} onRetry={loadAllData} />;
  }

  // Render main application with WebSocket provider for real-time updates
  return (
    <WebSocketProvider>
      <MainLayout />
      <ModalContainer />
      <ContextMenuContainer />
      <ActivityFeed />
    </WebSocketProvider>
  );
}

function AdminPortal() {
  useEffect(() => {
    document.title = 'Milestone Admin';
  }, []);
  return <AdminApp />;
}

function App() {
  // There is no client-side router: the path is fixed for the page's lifetime.
  // The confirm dialog (confirmAction) serves both the tenant app and the portal.
  return (
    <>
      {isAdminPath(window.location.pathname) ? <AdminPortal /> : <TenantApp />}
      <ConfirmDialog />
    </>
  );
}

export default App;
