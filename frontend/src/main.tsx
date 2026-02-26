import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initTheme, migrateLegacyStorage } from './utils/storage';
import { configureApiClient } from './api/client';
import { useWhatIfStore } from './stores/whatIfStore';
import './styles/global.css';

// Initialize theme before render to prevent flash
initTheme();

// Migrate any legacy storage keys from vanilla JS app
migrateLegacyStorage();

// Configure API client with What If mode check and queue function
configureApiClient({
  isWhatIfMode: () => useWhatIfStore.getState().whatIfMode,
  queueWhatIfOperation: (op) => useWhatIfStore.getState().queueWhatIfOperation(op),
});

// Create React Query client with sensible defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes (formerly cacheTime)
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

// Render the app
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
