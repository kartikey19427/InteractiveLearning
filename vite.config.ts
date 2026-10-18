import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The FastAPI backend (backend/) runs on port 8000 in development.
    proxy: { '/api': 'http://localhost:8000' },
  },
})
