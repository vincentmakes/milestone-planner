import { useEffect, useState } from 'react';
import { useAppStore } from './stores/appStore';
import { useAuth } from './hooks/useAuth';
import { useDataLoader } from './hooks/useDataLoader';
import { LoadingScreen } from './components/screens/LoadingScreen';
import { LoginScreen } from './components/screens/LoginScreen';
import { MainLayout } from './components/layout/MainLayout';
import { ModalContainer } from './components/modals';
import { ContextMenuContainer } from './components/gantt/ContextMenuContainer';
import { AdminApp } from './components/admin';
import './App.css';

function App() {
  const { isLoading, isAuthenticated } = useAuth();
  const { loadAllData, isLoading: isDataLoading } = useDataLoader();
  const whatIfMode = useAppStore((state) => state.whatIfMode);
  const instanceSettings = useAppStore((state) => state.instanceSettings);

  // Check if we're on the admin route
  const [isAdminRoute, setIsAdminRoute] = useState(false);

  useEffect(() => {
    // Check URL path for /admin
    const path = window.location.pathname;
    const isAdmin = path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
    setIsAdminRoute(isAdmin);
  }, []);

  // Load data when authenticated (only for main app)
  useEffect(() => {
    if (isAuthenticated && !isAdminRoute) {
      loadAllData();
    }
  }, [isAuthenticated, loadAllData, isAdminRoute]);

  // Update document title when instance settings change
  useEffect(() => {
    if (isAdminRoute) {
      document.title = 'Milestone Admin';
    } else {
      const title = instanceSettings?.instance_title || 'Milestone';
      document.title = title;
    }
  }, [instanceSettings, isAdminRoute]);

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

  // Render Admin app if on /admin route
  if (isAdminRoute) {
    return <AdminApp />;
  }

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

  // Render main application with modals
  return (
    <>
      <MainLayout />
      <ModalContainer />
      <ContextMenuContainer />
    </>
  );
}

export default App;
