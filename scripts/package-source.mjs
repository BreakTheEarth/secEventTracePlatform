import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root, collectSource, checkRelease } from './check-release.mjs';
import { writeSourceZip } from './source-zip.mjs';

const report = await checkRelease();
const name = `trace-security-operations-beta-${report.version}`;
const destination = join(root, 'release');
await mkdir(destination, { recursive: true });
const archive = join(destination, `${name}.zip`);
await writeSourceZip({ root, files: await collectSource(), prefix: name, destination: archive });
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${name}.zip\n`);
console.log(JSON.stringify({ archive, bytes: bytes.length, sha256, sourceFiles: report.files }, null, 2));
