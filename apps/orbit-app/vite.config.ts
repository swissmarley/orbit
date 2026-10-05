import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev server: proxy the API to this ORBIT_HOME's orbitd (address from
 * daemon.json — never the token: the browser signs in with
 * `orbit app --origin http://localhost:5173`, ADR-011).
 */
function daemonUrl(): string {
  const home = process.env.ORBIT_HOME ?? join(process.env.HOME ?? '', '.orbit');
  try {
    return (JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { url: string }).url;
  } catch {
    return 'http://127.0.0.1:7420';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/v1': { target: daemonUrl(), changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
