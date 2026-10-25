import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_TAR = 64 * 1024 * 1024;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const field = (header, start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
function octal(value) {
  const raw = value.trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error('Unsupported tar numeric field');
  const number = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid tar size');
  return number;
}
function checkPax(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('Malformed tar metadata');
    const rawLength = bytes.subarray(offset, space).toString();
    if (!/^[1-9]\d*$/.test(rawLength)) throw new Error('Malformed tar metadata');
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length) throw new Error('Malformed tar metadata');
    const entry = bytes.subarray(space + 1, offset + length).toString();
    const key = entry.split('=', 1)[0];
    if (!/^(mtime|atime|ctime|LIBARCHIVE\.xattr\.[^=]+|SCHILY\.xattr\.[^=]+)$/.test(key)) {
      throw new Error('Unsupported tar metadata override; rebuild with the module packager');
    }
    offset += length;
  }
}

export async function inspectPackage(path) {
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > MAX_ARCHIVE) throw new Error('Module archive must be at most 16 MiB');
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR }); }
  catch { throw new Error('Module archive is invalid gzip or exceeds 64 MiB expanded'); }
  const files = new Map();
  const names = new Set();
  let firstDirectory;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksum = octal(field(header, 148, 8));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== checksum) throw new Error('Module archive has an invalid tar checksum');
    const size = octal(field(header, 124, 12));
    const end = offset + 512 + size;
    if (end > tar.length) throw new Error('Module archive is truncated');
    const content = tar.subarray(offset + 512, end);
    const type = String.fromCharCode(header[156]);
    if (type === 'x') checkPax(content);
    else {
      const prefix = field(header, 345, 155);
      const name = (prefix ? `${prefix}/` : '') + field(header, 0, 100);
      const parts = name.replace(/\/$/, '').split('/');
      if (parts[0] !== 'rocket-onair' || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('._'))
        || name.includes('\\') || names.has(parts.join('/'))) throw new Error('Module archive contains an unsafe or duplicate path');
      names.add(parts.join('/'));
      if (type === '5') {
        if (!name.endsWith('/') || size !== 0) throw new Error('Invalid module directory entry');
        firstDirectory ??= name;
      } else if (type === '0' || type === '\0') {
        if (parts.length < 2 || name.endsWith('/')) throw new Error('Invalid module file entry');
        files.set(name, content);
      }
      else throw new Error('Module archive contains a link or unsupported entry');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (firstDirectory !== 'rocket-onair/') throw new Error('Module archive needs its top-level directory entry');
  const json = (name) => {
    if (!files.has(`rocket-onair/${name}`)) throw new Error(`Module archive is missing ${name}`);
    try { return JSON.parse(files.get(`rocket-onair/${name}`).toString()); }
    catch { throw new Error(`Module archive has invalid ${name}`); }
  };
  const manifest = json('companion/manifest.json'), info = json('build-info.json'), pkg = json('package.json');
  if (manifest.id !== 'rocket-onair' || (manifest.type !== undefined && manifest.type !== 'connection')) throw new Error('Archive is not the rocket-onair connection module');
  if (!stableVersion.test(manifest.version) || manifest.version !== info.version || manifest.version !== pkg.version) throw new Error('Module archive versions disagree');
  if (info.dirty !== false || !/^[0-9a-f]{40}$/.test(info.commit ?? '') || !Number.isFinite(Date.parse(info.builtAt))) {
    throw new Error('Deploy only a package built from a clean committed checkout');
  }
  const bundle = files.get('rocket-onair/main.js');
  if (!bundle || info.bundleSha256 !== sha256(bundle)) throw new Error('Module bundle does not match its recorded SHA-256');
  return { bytes, manifest, info, archiveSha256: sha256(bytes) };
}
