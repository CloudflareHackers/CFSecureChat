import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Proxy signaling WebSocket and API requests to the Worker dev server
      '/ws': {
        target: 'https://localhost:8787',
        ws: true,
        secure: false,
        changeOrigin: true,
      },
      '/api': {
        target: 'https://localhost:8787',
        secure: false,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
