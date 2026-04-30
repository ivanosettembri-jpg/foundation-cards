import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'inject-firebase-key',
      transformIndexHtml: (html) =>
        html.replace('__FIREBASE_API_KEY__', process.env.VITE_FIREBASE_API_KEY || ''),
    }
  ],
  build: { chunkSizeWarningLimit: 1000 },
})
