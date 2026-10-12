import { badRequest } from './util.js';

// Every tunable rule lives here so staff can adjust policy from the Settings
// page without touching code.
export const SETTINGS = {
  school_name: { type: 'string', default: 'Media Lab', label: 'Program name' },
  loan_days_default: { type: 'int', default: 3, min: 1, max: 90, label: 'Default loan length (days)' },
  max_loan_days: { type: 'int', default: 7, min: 1, max: 365, label: 'Longest loan a student can choose (days)' },
  grace_period_hours: { type: 'int', default: 24, min: 0, max: 720, label: 'Grace period after the due time (hours)' },
  late_return_penalty_days: { type: 'int', default: 0, min: 0, max: 90, label: 'Extra booking restriction after a late return (days)' },
  fine_per_day_cents: { type: 'int', default: 0, min: 0, max: 100000, label: 'Late fine per day, in cents (0 = no fines)' },
  block_on_unpaid_fines: { type: 'bool', default: false, label: 'Restrict students who have unpaid fines' },
  signature_threshold_cents: { type: 'int', default: 50000, min: 0, max: 100000000, label: 'Signature required for items worth at least, in cents (0 = only items flagged individually)' },
  allow_student_self_checkout: { type: 'bool', default: true, label: 'Students can check out and return gear themselves' },
  allow_student_reservations: { type: 'bool', default: true, label: 'Students can book gear in advance' },
  max_reservation_days: { type: 'int', default: 7, min: 1, max: 90, label: 'Longest booking a student can make (days)' },
  reservation_pickup_hours: { type: 'int', default: 24, min: 1, max: 168, label: 'Booking is released if not picked up within (hours)' },
  reserved_badge_hours: { type: 'int', default: 24, min: 0, max: 336, label: 'Show items as Reserved this many hours before a booking starts' },
  damaged_to_repair: { type: 'bool', default: true, label: 'Move items returned as Damaged to "In repair"' },
};

function parse(def, raw) {
  if (def.type === 'int') return Number.parseInt(raw, 10);
  if (def.type === 'bool') return raw === 'true';
  return raw;
}

export function getSettings(db) {
  const out = {};
  for (const [key, def] of Object.entries(SETTINGS)) out[key] = def.default;
  for (const row of db.all('SELECT key, value FROM settings')) {
    const def = SETTINGS[row.key];
    if (def) out[row.key] = parse(def, row.value);
  }
  return out;
}

export function updateSettings(db, patch) {
  if (!patch || typeof patch !== 'object') throw badRequest('Settings must be an object');
  const updates = [];
  for (const [key, value] of Object.entries(patch)) {
    const def = SETTINGS[key];
    if (!def) throw badRequest(`Unknown setting: ${key}`);
    let stored;
    if (def.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) {
        throw badRequest(`${def.label} must be a whole number between ${def.min} and ${def.max}`);
      }
      stored = String(n);
    } else if (def.type === 'bool') {
      if (typeof value !== 'boolean') throw badRequest(`${def.label} must be true or false`);
      stored = String(value);
    } else {
      const s = String(value ?? '').trim();
      if (!s || s.length > 100) throw badRequest(`${def.label} must be 1–100 characters`);
      stored = s;
    }
    updates.push([key, stored]);
  }
  db.transaction(() => {
    for (const [key, value] of updates) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    }
  });
  return getSettings(db);
}
