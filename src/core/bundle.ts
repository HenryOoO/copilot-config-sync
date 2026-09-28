import * as fs from 'fs';
import * as path from 'path';
import { Bundle, BundleFile, CategoryId, CategoryPayload, Manifest } from './types';
import { gzipBase64, gunzipBase64, sha256 } from './hash';

/** Max size (base64 chars) of one category file in the gist before chunking. */
export const CHUNK_LIMIT = 900_000;

export interface ReadResult {
  bytes: Buffer;
  executable: boolean;
}

/**
 * Pack a category's files from disk into a payload. `resolve` maps a manifest
 * relative path to an absolute file path.
 */
export function packCategory(
  manifest: Manifest,
  category: CategoryId,
  resolve: (relPath: string) => string | undefined
): CategoryPayload | undefined {
  const cat = manifest.categories[category];
  if (!cat || cat.files.length === 0) {
    return undefined;
  }
  const files: BundleFile[] = [];
  for (const entry of cat.files) {
    const abs = resolve(entry.path);
    if (!abs) {
      continue;
    }
    const bytes = fs.readFileSync(abs);
    const hash = sha256(bytes);
    if (hash !== entry.hash) {
      // file changed since scan; use fresh hash
      entry.hash = hash;
      entry.size = bytes.length;
    }
    files.push({
      path: entry.path,
      content: gzipBase64(bytes),
      hash,
      executable: entry.executable,
    });
  }
  return files.length ? { files } : undefined;
}

/** Unpack a payload to disk under `baseDir`, restoring exec bits. */
export function unpackCategory(payload: CategoryPayload, baseDir: string): string[] {
  const written: string[] = [];
  for (const file of payload.files) {
    const abs = path.join(baseDir, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const bytes = gunzipBase64(file.content);
    fs.writeFileSync(abs, bytes);
    if (file.executable) {
      fs.chmodSync(abs, fs.statSync(abs).mode | 0o111);
    }
    written.push(abs);
  }
  return written;
}

/** Split a payload into chunks under the gist per-file size limit. */
export function chunkPayload(category: string, payload: CategoryPayload): Record<string, CategoryPayload> {
  const total = payload.files.reduce((n, f) => n + f.content.length, 0);
  if (total <= CHUNK_LIMIT) {
    return { [`${category}.json`]: payload };
  }
  const chunks: Record<string, CategoryPayload> = {};
  let current: BundleFile[] = [];
  let size = 0;
  let index = 1;
  const flush = () => {
    if (current.length) {
      chunks[`${category}-${index}.json`] = { files: current };
      index += 1;
      current = [];
      size = 0;
    }
  };
  for (const file of payload.files) {
    if (size + file.content.length > CHUNK_LIMIT) {
      flush();
    }
    current.push(file);
    size += file.content.length;
  }
  flush();
  return chunks;
}

/** Merge chunked category files back into one payload. */
export function mergeChunks(files: Record<string, unknown>, category: string): CategoryPayload | undefined {
  const names = Object.keys(files)
    .filter((k) => k === `${category}.json` || k.startsWith(`${category}-`))
    .sort();
  if (names.length === 0) {
    return undefined;
  }
  const merged: BundleFile[] = [];
  for (const name of names) {
    const payload = files[name] as CategoryPayload | undefined;
    if (payload?.files) {
      merged.push(...payload.files);
    }
  }
  return { files: merged };
}