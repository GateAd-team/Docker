import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './store';
import { CloudProvider } from './cloud';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CloudProvider>
      <StoreProvider>
        <App />
      </StoreProvider>
    </CloudProvider>
  </React.StrictMode>,
);
