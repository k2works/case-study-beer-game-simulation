import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createApi } from './api.js';
import { createBrowserStorage } from './storage.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('描画先（#root）が見つかりません');
}
createRoot(container).render(
  <StrictMode>
    <App api={createApi()} storage={createBrowserStorage()} />
  </StrictMode>,
);
