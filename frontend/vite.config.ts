import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Custom plugin to handle tenant routes as SPA
function tenantSpaPlugin(): Plugin {
  return {
    name: 'tenant-spa-fallback',
    configureServer(server) {
      // Return a function to run AFTER Vite's internal middleware
      // but we use 'pre' enforcement to run before
      return () => {
        server.middlewares.use((req, res, next) => {
          const url = req.url || '';
          // Rewrite /t/* routes to root for SPA handling
          if (url.startsWith('/t/') && !url.includes('.')) {
            req.url = '/index.html';
          }
          next();
        });
      };
    },
    // Also handle in preview mode
    configurePreviewServer(server) {
      return () => {
        server.middlewares.use((req, res, next) => {
          const url = req.url || '';
          if (url.startsWith('/t/') && !url.includes('.')) {
            req.url = '/index.html';
          }
          next();
        });
      };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Tenant SPA plugin first
    tenantSpaPlugin(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 3333,
    host: true,
  },
});
