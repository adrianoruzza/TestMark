import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({command, isPreview}) => {
  // Production builds & preview target the GitHub Pages project subpath /TestMark/
  // (https://adrianoruzza.github.io/TestMark/). Override via VITE_BASE_PATH if needed.
  // Development server stays at '/' for local & preview convenience.
  const base =
    command === 'build' || isPreview
      ? process.env.VITE_BASE_PATH || '/TestMark/'
      : '/';

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        manifestFilename: 'manifest.webmanifest',
        includeAssets: [
          'favicon.ico',
          'testmark-favicon-32-v3.png',
          'testmark-apple-touch-icon-v3.png',
          'testmark-icon-192-v3.png',
          'testmark-icon-512-v3.png',
          'testmark-icon-maskable-512-v3.png',
        ],
        manifest: {
          id: base,
          name: 'TestMark',
          short_name: 'TestMark',
          description:
            'Registro digitale docente per il monitoraggio delle prove, interrogazioni e consegne degli studenti.',
          lang: 'it',
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          theme_color: '#1d4ed8',
          background_color: '#f8fafc',
          icons: [
            {
              src: 'testmark-icon-192-v3.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'testmark-icon-512-v3.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'testmark-icon-maskable-512-v3.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cacheId: 'testmark-v4',
          cleanupOutdatedCaches: true,
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,woff,woff2}'],
          globIgnores: ['404.html', 'assets/aistudio/**'],
          navigateFallback: 'index.html',
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-stylesheets',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-webfonts',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      // Copies src/assets into dist/ and generates dist/404.html from dist/index.html
      // so direct reloads on GitHub Pages subpaths never return a 404 page.
      {
        name: 'copy-unbundled-src-assets-and-gh-pages-fallback',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          const indexHtml = path.join(distDir, 'index.html');
          const notFoundHtml = path.join(distDir, '404.html');
          if (fs.existsSync(indexHtml)) {
            fs.copyFileSync(indexHtml, notFoundHtml);
          }
        },
      },
    ],
    build: {
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
