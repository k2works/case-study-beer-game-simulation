import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { createHttpClient } from './api/http-client.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App api={createHttpClient()} />
    </BrowserRouter>
  </StrictMode>,
);
