/** @jsxRuntime automatic @jsxImportSource react */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createBrowserClient } from './lib/api';
import { applyTheme, themeStore } from './lib/theme';
import './styles.css';

applyTheme(themeStore.get());
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App client={createBrowserClient()} />
    </StrictMode>,
  );
}
