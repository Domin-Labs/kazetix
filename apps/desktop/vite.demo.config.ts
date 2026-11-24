// Browser demo of the real UI with the Tauri API mocked (demo/tauri-mock.ts) — used for screenshots.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const mock = new URL('./demo/tauri-mock.ts', import.meta.url).pathname;
export default defineConfig({
  plugins: [react()],
  server: { port: 1421, strictPort: true },
  resolve: { alias: { '@tauri-apps/api/core': mock, '@tauri-apps/api/event': mock, '@tauri-apps/api/window': mock } },
});
