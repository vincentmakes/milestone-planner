import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './utils/storage';
import { configureApiClient } from './api/client';
import { useWhatIfStore } from './stores/whatIfStore';
import { expireSession } from './stores';
import './styles/global.css';

// Initialize theme before render to prevent flash
initTheme();

// Configure API client with What If mode check and queue function
configureApiClient({
  isWhatIfMode: () => useWhatIfStore.getState().whatIfMode,
  queueWhatIfOperation: (op) => useWhatIfStore.getState().queueWhatIfOperation(op),
  // A 401 means the session expired or was revoked: back to the login screen.
  onUnauthorized: expireSession,
});

// Render the app
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
