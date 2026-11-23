import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // funktioniert so auch in Unterordnern, z. B. GitHub Pages
  server: {
    // Spotify erlaubt http nur für 127.0.0.1, nicht für "localhost"
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
