import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const escapeAttribute = (value: string) => escapeHtml(value)
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const valueOr = (key: string, fallback: string) => {
    const value = String(process.env[key] ?? env[key] ?? '').trim();
    return value || fallback;
  };
  const productName = valueOr('VITE_PRODUCT_NAME', 'WorkOS');
  const productLogoUrl = valueOr('VITE_PRODUCT_LOGO_URL', '/workos-mark.svg');

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'workos-document-metadata',
        transformIndexHtml(html: string) {
          return html
            .replace(
              /<title>[\s\S]*?<\/title>/i,
              `<title>${escapeHtml(productName)}</title>`,
            )
            .replace(
              /(<link id="workos-favicon" rel="icon" type="image\/svg\+xml" href=")[^"]*(" \/>)/i,
              (_match, prefix: string, suffix: string) => `${prefix}${escapeAttribute(productLogoUrl)}${suffix}`,
            );
        },
      },
    ],
    define: {
      'import.meta.env.VITE_APP_MODE': JSON.stringify(env.APP_MODE || env.VITE_APP_MODE || 'demo'),
      'import.meta.env.VITE_DISABLE_DEMO_FALLBACK': JSON.stringify(env.DISABLE_DEMO_FALLBACK || env.VITE_DISABLE_DEMO_FALLBACK || 'false'),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: `http://localhost:${env.API_PORT || env.PORT || '4000'}`,
          changeOrigin: true,
        },
      },
    },
  };
});
