import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ポートと API の中継先は、環境変数で変えられる（E2E は開発サーバーと別のポートで動かす）
const port = Number(process.env.UI_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3000);

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
  server: {
    port,
    strictPort: true,
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
});
