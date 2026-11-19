/**
 * E2E のポート。開発サーバー（`npm run dev`: API 3000、UI 5173）と別にして、
 * 動いている開発サーバー（古いコードのことがある）を E2E が再利用しないようにする。
 */
export const E2E_API_PORT = 3100;
export const E2E_UI_PORT = 5273;
export const E2E_API_URL = `http://localhost:${E2E_API_PORT}`;
export const E2E_ORIGIN = `http://localhost:${E2E_UI_PORT}`;
