import { defineConfig } from 'vite';
import { autoplay, joinBots } from './scripts/dev-bots.js';

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
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        // dev 専用: ゲームが作成されたら、ボット 4 人を参加させ、役割割当・開始後はオートプレイで進める
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            if (req.method !== 'POST' || req.url !== '/api/v1/games' || proxyRes.statusCode !== 201)
              return;
            const chunks: Buffer[] = [];
            proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
            proxyRes.on('end', () => {
              const { joinCode } = JSON.parse(Buffer.concat(chunks).toString()) as {
                joinCode: string;
              };
              const facilitatorCookie = (proxyRes.headers['set-cookie'] ?? [])
                .map((value) => value.split(';')[0])
                .join('; ');
              joinBots(joinCode)
                .then((bots) => autoplay(bots, facilitatorCookie))
                .catch((error: unknown) => console.error(String(error)));
            });
          });
        },
      },
    },
  },
});
