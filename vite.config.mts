import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Le renderer est une app React classique : elle tourne aussi bien dans Electron
// que dans un navigateur (npm run dev:web) grâce au mode "démo" de src/renderer/api.ts.
export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['pdfjs-dist'] },
  worker: { format: 'es' },
  test: { include: ['../../test/**/*.test.ts'] },
});
