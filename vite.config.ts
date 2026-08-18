import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served from https://baloghdaniel.github.io/betquiz/, so every asset URL needs
// the repo name as a prefix.
export default defineConfig({
  base: '/betquiz/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'BetQuiz',
        short_name: 'BetQuiz',
        description: 'A 1v1 trivia duel where everyone else bets mouthfuls on the winner.',
        theme_color: '#eef2f7',
        background_color: '#eef2f7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/betquiz/',
        scope: '/betquiz/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the shell only. Game state is inherently online -- serving a
        // stale room from cache would be worse than showing an offline error.
        globPatterns: ['**/*.{js,css,html,png}'],
        navigateFallback: 'index.html',
        runtimeCaching: [],
      },
    }),
  ],
})
