import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'inject-fb-key',
      transformIndexHtml(html) {
        const key = process.env.VITE_FIREBASE_API_KEY || '';
        return html.replace(
          '</head>',
          `<meta name="fb-api-key" content="${key}"></head>`
        );
      }
    }
  ],
  build: { chunkSizeWarningLimit: 1000 },
})
