import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);

// ---------------------------------------------------------------------------
// Input validation helpers. Each throws a 400 with a readable message.

export function str(value, field, { required = false, max = 500, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} must be text`);
  let s = String(value);
  if (trim) s = s.trim();
  if (required && !s) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return s || null;
}

export function int(value, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

export function oneOf(value, field, options, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (!options.includes(value)) throw badRequest(`${field} must be one of: ${options.join(', ')}`);
  return value;
}

export function isoDate(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a valid date`);
  return d.toISOString();
}

export function idList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list`);
  return value.map((v) => int(v, field, { required: true, min: 1 }));
}

/** Tags/barcodes: printable, no whitespace at the ends, reasonable length. */
export function tagValue(value, field = 'Tag') {
  const s = str(value, field, { required: true, max: 64 });
  if (!/^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(s)) {
    throw badRequest(`${field} may only contain letters, numbers and symbols`);
  }
  return s;
}

export function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

export function addDays(iso, days) {
  return addHours(iso, days * 24);
}

export function formatMoney(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Image uploads arrive as data URLs (photos are resized in the browser first).

const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};

export const FILE_KINDS = ['assets', 'photos', 'signatures'];

/**
 * Decodes and writes an image data URL into `<uploadsDir>/<kind>/`.
 * Returns the stored relative path (e.g. "photos/3f2a….jpg").
 */
export function saveImage(uploadsDir, kind, dataUrl, { field = 'Photo', maxBytes = 6 * 1024 * 1024, types } = {}) {
  if (!FILE_KINDS.includes(kind)) throw new Error(`Unknown upload kind ${kind}`);
  if (typeof dataUrl !== 'string') throw badRequest(`${field} must be an image`);
  const match = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const allowed = types ?? Object.keys(IMAGE_TYPES);
  if (!match || !allowed.includes(match[1])) throw badRequest(`${field} must be a ${allowed.map((t) => t.split('/')[1].toUpperCase()).join(', ')} image`);
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw badRequest(`${field} is empty`);
  if (buffer.length > maxBytes) throw badRequest(`${field} is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const type = IMAGE_TYPES[match[1]];
  if (!type.magic(buffer)) throw badRequest(`${field} is not a valid image`);
  const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  const dir = path.join(uploadsDir, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return `${kind}/${name}`;
}

export function fileUrl(relPath) {
  return relPath ? `/files/${relPath}` : null;
}
