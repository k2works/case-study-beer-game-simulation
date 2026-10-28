import { buildApp } from './api/app.js';

const app = await buildApp();
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
