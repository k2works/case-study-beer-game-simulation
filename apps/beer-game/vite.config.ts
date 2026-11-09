import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    strictPort: true,
    open: true,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
