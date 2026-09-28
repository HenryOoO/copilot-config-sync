import * as crypto from 'crypto';

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function gzipBase64(data: Buffer): string {
  return zlibGzip(data).toString('base64');
}

export function gunzipBase64(encoded: string): Buffer {
  return zlibGunzip(Buffer.from(encoded, 'base64'));
}

function zlibGzip(data: Buffer): Buffer {
  // lazy import to keep module surface small
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('zlib') as typeof import('zlib');
  return zlib.gzipSync(data);
}

function zlibGunzip(data: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('zlib') as typeof import('zlib');
  return zlib.gunzipSync(data);
}
