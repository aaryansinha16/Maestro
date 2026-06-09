import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Resolve the conductor's address for the dev-server proxy. Reads
// VITE_API_PROXY_TARGET first (e.g. http://localhost:3001 when the
// default port collides with another dev server), then falls back to
// `http://localhost:${MAESTRO_PORT}` from the repo-root .env, then to
// localhost:3000. Loading via Vite's `loadEnv` rather than `process.env`
// directly so it picks up the same .env discovery the conductor uses.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const explicit = env.VITE_API_PROXY_TARGET
  const port = env.MAESTRO_PORT
  const target = explicit || (port ? `http://localhost:${port}` : 'http://localhost:3000')
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  }
})
