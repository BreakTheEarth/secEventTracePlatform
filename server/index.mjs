import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPlatform } from './app.mjs';

const dev = process.argv.includes('--dev');
const platform = createPlatform({
  databasePath: resolve(process.env.DATABASE_PATH || './data/trace.sqlite'),
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionHours: process.env.SESSION_HOURS,
  secureCookie: process.env.COOKIE_SECURE === 'true',
});
const { app } = platform;
let vite;
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
  if (!existsSync(resolve(distDirectory, 'index.html'))) {
    platform.close();
    throw new Error('未找到构建文件，请先执行 npm run build。');
  }
  app.use(express.static(distDirectory));
  app.use((req, res) => {
    if (req.method !== 'GET' || !req.accepts('html')) return res.sendStatus(404);
    res.sendFile(resolve(distDirectory, 'index.html'));
  });
}
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`\n  Trace · 安全运营事件平台\n  Local: http://${host}:${port}\n`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请修改 .env 中的 PORT。` : error.message);
  platform.close();
  process.exit(1);
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await vite?.close();
  server.close(() => { platform.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
