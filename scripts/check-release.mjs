import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const sourceEntries = ['.env.example', '.gitignore', '.github', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE',
  'README.md', 'SECURITY.md', 'docs', 'index.html', 'package.json', 'package-lock.json', 'public', 'scripts', 'server', 'shared', 'src', 'tests'];

export async function collectSource() {
  const files = [];
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Source package cannot contain links: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) await walk(`${path}/${name}`);
    } else if (info.isFile()) files.push(path);
    else throw new Error(`Unsupported source entry: ${path}`);
  }
  for (const entry of sourceEntries) await walk(entry);
  return files;
}

export async function checkRelease({ includeBuild = true } = {}) {
  const files = await collectSource();
  const forbiddenText = new RegExp([
    ['my', 'hexin', '\\.com'].join(''),
    ['zhou', 'yuda'].join(''),
    ['同', '花', '顺'].join(''),
    ['sec', 'dashboard'].join(''),
    ['dd', 'ddocr'].join(''),
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{40,}',
  ].join('|'), 'i');
  const inspect = async path => {
    const text = await readFile(join(root, path), 'utf8');
    if (forbiddenText.test(text)) throw new Error(`Internal identifier, removed integration or private key material in ${path}`);
    if (path !== '.env.example' && /(?:^|\/)(?:data|output|release|node_modules|autologin)(?:\/|$)|\.sqlite(?:-|$)|\.key$|\.pem$/.test(path)) {
      throw new Error(`Private/runtime path in source list: ${path}`);
    }
  };
  for (const path of files) await inspect(path);
  if (includeBuild) {
    await inspect('dist/index.html');
    for (const file of await readdir(join(root, 'dist/assets'))) await inspect(`dist/assets/${file}`);
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.1.0-beta.1' || manifest.license !== 'MIT') throw new Error('Unexpected beta version or license.');
  const env = await readFile(join(root, '.env.example'), 'utf8');
  if (!env.includes('DATABASE_PATH=./data/trace.sqlite') || /TOKEN=|DLP_|DASHBOARD_/.test(env)) throw new Error('Unexpected environment template.');
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean);
    if (tracked.some(path => !files.includes(path))) throw new Error('Git contains files outside the source allowlist.');
  } catch (error) {
    if (error.status === undefined) throw error;
  }
  return { version: manifest.version, files: files.length, sourceBytes: (await Promise.all(files.map(async path => (await lstat(join(root, path))).size))).reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRelease().then(result => console.log(JSON.stringify({ status: 'ok', ...result }, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
