import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ポートと API の中継先は環境変数で変える。固定の値を置かない（人の開発サーバーと衝突させないため）。
// 既定は、ローカルの開発用。E2E は UI_PORT=5273、API_PORT=3100 のような専用のポートで動かす。
const uiPort = Number(process.env.UI_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3000);

export default defineConfig({
    plugins: [react()],
    server: {
        port: uiPort,
        strictPort: true,
        proxy: { '/api': `http://localhost:${apiPort}` },
    },
});
