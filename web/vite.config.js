import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Trailing slash matters: a bare '/t' prefix-matches '/tickets' too, and
    // proxies it to the API instead of letting the SPA router handle it.
    proxy: { '/api': 'http://localhost:4000', '/t/': 'http://localhost:4000' },
  },
});
