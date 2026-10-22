import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// All API calls stay relative: the dev server proxies them to the backend. The Origin header is
// forwarded untouched (changeOrigin: false), because the backend checks it against PUBLIC_BASE_URL.
const backend = 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: backend, changeOrigin: false },
      '/clientes': { target: backend, changeOrigin: false },
    },
  },
});
