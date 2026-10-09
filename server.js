import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './src/app.js';
import { initializeDatabase } from './src/database.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(root, 'data');
const videoDirectory = path.join(root, 'storage', 'videos');

mkdirSync(dataDirectory, { recursive: true });
mkdirSync(videoDirectory, { recursive: true });

const database = initializeDatabase(path.join(dataDirectory, 'streamnest.sqlite'));
const app = createApp(database, {
  videoDirectory,
  sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000,
  duplicateWindowMs: Number(process.env.DUPLICATE_WINDOW_HOURS || 24) * 60 * 60 * 1000,
  adminApiKey: process.env.ADMIN_API_KEY || '',
  appOrigin: process.env.APP_ORIGIN || '',
  secureCookies: process.env.NODE_ENV === 'production',
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`VideoVault listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
