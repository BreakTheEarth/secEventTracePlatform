import { existsSync, writeFileSync } from 'node:fs';

if (!existsSync('.env')) {
  writeFileSync('.env', [
    'HOST=127.0.0.1',
    'PORT=3001',
    'ADMIN_USERNAME=admin',
    'ADMIN_PASSWORD=admin',
    'DATABASE_PATH=./data/trace.sqlite',
    'SESSION_HOURS=8',
    'COOKIE_SECURE=false',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('已创建本地配置 .env；测试管理员账号为 admin / admin。');
}
