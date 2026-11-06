import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root, sourceEntries, checkRelease } from './check-release.mjs';

const report = await checkRelease();
const work = await mkdtemp(join(tmpdir(), 'trace-beta-source-'));
const name = `trace-security-operations-beta-${report.version}`;
const destination = join(root, 'release');
try {
  const stage = join(work, name);
  await mkdir(stage);
  for (const entry of sourceEntries) await cp(join(root, entry), join(stage, entry), { recursive: true });
  await mkdir(destination, { recursive: true });
  const archive = join(destination, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', work, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
  console.log(JSON.stringify({ archive, bytes: bytes.length, sha256, sourceFiles: report.files }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
