import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, createContext } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { demoSignaturePng } from '../server/demo.js';

export const SIGNATURE = demoSignaturePng(7);
// 1x1 JPEG
export const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/**
 * Spins up an isolated app (in-memory DB, temp uploads, controllable clock)
 * and returns helpers for making signed-in requests.
 */
export async function setup() {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-test-'));
  let clock = new Date('2026-03-02T16:00:00.000Z');
  const ctx = createContext({ dbPath: ':memory:', uploadsDir, now: () => new Date(clock) });
  const app = createApp(ctx);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const addUser = (username, role = 'student', extra = {}) => {
    const { id } = ctx.db.run(
      `INSERT INTO users (username, name, role, student_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [username, extra.name ?? username, role, extra.student_id ?? null, hashPassword('password123'), clock.toISOString()],
    );
    return id;
  };

  async function login(username, password = 'password123') {
    let cookie = '';
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
    cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body) => {
      const r = await fetch(`${base}${url}`, {
        method,
        headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: r.status, body: json, headers: r.headers };
    };
    return {
      get: (url) => call('GET', url),
      post: (url, body = {}) => call('POST', url, body),
      patch: (url, body = {}) => call('PATCH', url, body),
      del: (url) => call('DELETE', url),
    };
  }

  return {
    ctx,
    base,
    addUser,
    login,
    advance(hours) {
      clock = new Date(clock.getTime() + hours * 3600_000);
    },
    now: () => new Date(clock),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      ctx.db.close();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}

/** Creates a camera body with lens attached, plus battery, charger and card. */
export async function seedCameraKit(admin, { prefix = '' } = {}) {
  const make = async (body) => {
    const r = await admin.post('/api/assets', body);
    if (r.status !== 201) throw new Error(`create ${body.tag}: ${JSON.stringify(r.body)}`);
    return r.body.asset;
  };
  const camera = await make({ tag: `${prefix}CAM-1`, name: 'Canon T7i', category: 'Camera Body', value: '749', compat: ['mount:EF', 'battery:LP-E17', 'media:SD'], location: 'Cabinet A' });
  const lens = await make({ tag: `${prefix}LENS-1`, name: 'EF-S 18-55mm', category: 'Lens', value: '249', compat: ['mount:EF'], location: 'Cabinet A', parent_tag: `${prefix}CAM-1` });
  const battery = await make({ tag: `${prefix}BAT-1`, name: 'LP-E17', category: 'Battery', value: '49', compat: ['battery:LP-E17'], location: 'Cabinet A' });
  const charger = await make({ tag: `${prefix}CHG-1`, name: 'LC-E17', category: 'Charger', value: '45', compat: ['battery:LP-E17'], location: 'Cabinet A' });
  const card = await make({ tag: `${prefix}SD-1`, name: 'SD 64GB', category: 'Memory Card', value: '19', compat: ['media:SD'], location: 'Cabinet A' });
  const kitRes = await admin.post('/api/kits', { tag: `${prefix}KIT-1`, name: 'Canon Kit' });
  const kit = kitRes.body.kit;
  for (const a of [camera, battery, charger, card]) await admin.post(`/api/kits/${kit.id}/items`, { tag: a.tag });
  return { camera, lens, battery, charger, card, kit };
}
