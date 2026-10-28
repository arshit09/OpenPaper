import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.OPENPAPER_PORT || 29880);
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/ws': { target, ws: true, changeOrigin: false },
      '/api': { target, changeOrigin: false },
      '/media': { target, changeOrigin: false },
      '/local-asset': { target, changeOrigin: false },
      '/__op': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
