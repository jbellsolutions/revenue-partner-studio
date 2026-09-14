import { defineConfig } from 'vite'
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist/public', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5178, proxy: { '/api': { target: 'http://127.0.0.1:8788', ws: true } } }
})
