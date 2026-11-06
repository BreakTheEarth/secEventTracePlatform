import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

// Small source archives use standard ZIP entries; no external zip executable is needed.
export async function writeSourceZip({ root, files, prefix, destination }) {
  const parts = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const path of files) {
    const name = Buffer.from(`${prefix}/${path}`, 'utf8');
    const bytes = await readFile(join(root, path));
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // ZIP date: 1980-01-01, stable across builds.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    directorySize += entry.length + name.length;
    offset += header.length + name.length + compressed.length;
  }
  if (files.length > 65535 || offset + directorySize > 0xffffffff) throw new Error('Source archive exceeds ZIP limits.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...parts, ...directory, end]));
}
