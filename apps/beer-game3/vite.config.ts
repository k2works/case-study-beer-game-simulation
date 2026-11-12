import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 開発のポートは、人の開発サーバー（3000 と 5173）と重ならない値にする。
const webPort = Number(process.env.WEB_PORT ?? 5273);
const apiPort = Number(process.env.PORT ?? 3100);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      // changeOrigin を false にして、ブラウザの Origin と Host を一致させる（別オリジン拒否の検査を通す）
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false },
      '/health': { target: `http://localhost:${apiPort}`, changeOrigin: false },
    },
  },
});
