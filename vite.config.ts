/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

// Optional trusted HTTPS (needed for camera access from a physical tablet over the LAN).
// Create certificates with mkcert into .certs/ — see README "Camera on a tablet".
const certFile = process.env.HTTPS_CERT ?? '.certs/dev.pem';
const keyFile = process.env.HTTPS_KEY ?? '.certs/dev-key.pem';
const https = fs.existsSync(certFile) && fs.existsSync(keyFile) ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) } : undefined;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, https },
  preview: { port: 4173, https },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
