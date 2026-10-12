import zlib from 'node:zlib';
import { hashPassword } from './auth.js';
import { createAsset, setAssetState } from './services/assets.js';
import { commitCheckout, markLoanItemLost, processReturn } from './services/loans.js';
import { createReservation } from './services/reservations.js';
import { HttpError, addDays, addHours } from './util.js';

// ---------------------------------------------------------------------------
// Demo data: a small high-school media lab with a few months of history so
// every screen (badges, kits, restrictions, analytics) has something to show.

const USERS = [
  { username: 'teacher', name: 'Mr. Chang', role: 'admin', email: 'teacher@example.edu' },
  { username: 'maya', name: 'Maya Patel', student_id: 'S10234' },
  { username: 'jordan', name: 'Jordan Lee', student_id: 'S10235' },
  { username: 'sam', name: 'Sam Rivera', student_id: 'S10236' },
  { username: 'alex', name: 'Alex Kim', student_id: 'S10237' },
  { username: 'priya', name: 'Priya Shah', student_id: 'S10238' },
  { username: 'diego', name: 'Diego Martinez', student_id: 'S10239' },
];

const A = (tag, name, category, brand, value, compat, location, extra = {}) => ({
  tag, name, category, brand, value_cents: Math.round(value * 100), compat, location, ...extra,
});

const ASSETS = [
  A('CAM-001', 'Canon EOS Rebel T7i', 'Camera Body', 'Canon', 749, ['mount:EF', 'battery:LP-E17', 'media:SD'], 'Cabinet A', { serial_number: '043021001234' }),
  A('CAM-002', 'Canon EOS Rebel T7i', 'Camera Body', 'Canon', 749, ['mount:EF', 'battery:LP-E17', 'media:SD'], 'Cabinet A', { serial_number: '043021001977' }),
  A('CAM-003', 'Canon EOS R6', 'Camera Body', 'Canon', 2499, ['mount:RF', 'battery:LP-E6NH', 'media:SD'], 'Cabinet A', { serial_number: '0821004411', description: 'Full-frame mirrorless. Advanced Film students only.' }),
  A('CAM-004', 'Sony a6400', 'Camera Body', 'Sony', 899, ['mount:E', 'battery:NP-FW50', 'media:SD'], 'Cabinet B'),
  A('CAM-005', 'Sony ZV-E10', 'Camera Body', 'Sony', 699, ['mount:E', 'battery:NP-FW50', 'media:SD'], 'Cabinet B'),
  A('VID-001', 'Canon VIXIA HF G70', 'Camcorder', 'Canon', 1099, ['battery:BP-820', 'media:SD'], 'Cabinet B'),
  A('LENS-001', 'Canon EF-S 18-55mm f/4-5.6 IS STM', 'Lens', 'Canon', 249, ['mount:EF'], 'Cabinet A', { parent: 'CAM-001' }),
  A('LENS-002', 'Canon EF-S 18-55mm f/4-5.6 IS STM', 'Lens', 'Canon', 249, ['mount:EF'], 'Cabinet A', { parent: 'CAM-002' }),
  A('LENS-003', 'Canon EF 50mm f/1.8 STM', 'Lens', 'Canon', 125, ['mount:EF'], 'Cabinet A', { description: 'Great for portraits and low light.' }),
  A('LENS-004', 'Canon EF 70-300mm f/4-5.6 IS II', 'Lens', 'Canon', 549, ['mount:EF'], 'Cabinet A'),
  A('LENS-005', 'Canon RF 24-105mm f/4L IS USM', 'Lens', 'Canon', 1099, ['mount:RF'], 'Cabinet A', { parent: 'CAM-003' }),
  A('LENS-006', 'Sony E PZ 16-50mm f/3.5-5.6 OSS', 'Lens', 'Sony', 299, ['mount:E'], 'Cabinet B', { parent: 'CAM-004' }),
  A('LENS-007', 'Sigma 30mm f/1.4 DC DN (Sony E)', 'Lens', 'Sigma', 289, ['mount:E'], 'Cabinet B'),
  A('LENS-008', 'Sony E 10-18mm f/4 OSS', 'Lens', 'Sony', 749, ['mount:E'], 'Cabinet B', { parent: 'CAM-005' }),
  A('BAT-001', 'Canon LP-E17 Battery', 'Battery', 'Canon', 49, ['battery:LP-E17'], 'Charging Station'),
  A('BAT-002', 'Canon LP-E17 Battery', 'Battery', 'Canon', 49, ['battery:LP-E17'], 'Charging Station'),
  A('BAT-003', 'Canon LP-E17 Battery', 'Battery', 'Canon', 49, ['battery:LP-E17'], 'Charging Station'),
  A('BAT-004', 'Canon LP-E17 Battery', 'Battery', 'Canon', 49, ['battery:LP-E17'], 'Charging Station'),
  A('BAT-005', 'Canon LP-E6NH Battery', 'Battery', 'Canon', 79, ['battery:LP-E6NH'], 'Charging Station'),
  A('BAT-006', 'Canon LP-E6NH Battery', 'Battery', 'Canon', 79, ['battery:LP-E6NH'], 'Charging Station'),
  A('BAT-007', 'Sony NP-FW50 Battery', 'Battery', 'Sony', 49, ['battery:NP-FW50'], 'Charging Station'),
  A('BAT-008', 'Sony NP-FW50 Battery', 'Battery', 'Sony', 49, ['battery:NP-FW50'], 'Charging Station'),
  A('BAT-009', 'Sony NP-FW50 Battery', 'Battery', 'Sony', 49, ['battery:NP-FW50'], 'Charging Station'),
  A('BAT-010', 'Canon BP-820 Battery', 'Battery', 'Canon', 99, ['battery:BP-820'], 'Charging Station'),
  A('CHG-001', 'Canon LC-E17 Charger', 'Charger', 'Canon', 45, ['battery:LP-E17'], 'Charging Station'),
  A('CHG-002', 'Canon LC-E17 Charger', 'Charger', 'Canon', 45, ['battery:LP-E17'], 'Charging Station'),
  A('CHG-003', 'Canon LC-E6 Charger', 'Charger', 'Canon', 59, ['battery:LP-E6NH'], 'Charging Station'),
  A('CHG-004', 'Sony BC-TRW Charger', 'Charger', 'Sony', 39, ['battery:NP-FW50'], 'Charging Station'),
  A('CHG-005', 'Canon CG-800 Charger', 'Charger', 'Canon', 89, ['battery:BP-820'], 'Charging Station'),
  A('SD-001', 'SanDisk Extreme 64GB SD', 'Memory Card', 'SanDisk', 19, ['media:SD'], 'Cabinet A'),
  A('SD-002', 'SanDisk Extreme 64GB SD', 'Memory Card', 'SanDisk', 19, ['media:SD'], 'Cabinet A'),
  A('SD-003', 'SanDisk Extreme 64GB SD', 'Memory Card', 'SanDisk', 19, ['media:SD'], 'Cabinet B'),
  A('SD-004', 'SanDisk Extreme 128GB SD', 'Memory Card', 'SanDisk', 29, ['media:SD'], 'Cabinet B'),
  A('SD-005', 'SanDisk Extreme 128GB SD', 'Memory Card', 'SanDisk', 29, ['media:SD'], 'Cabinet B'),
  A('SD-006', 'SanDisk Extreme 128GB SD', 'Memory Card', 'SanDisk', 29, ['media:SD'], 'Cabinet B'),
  A('TRI-001', 'Manfrotto Compact Action Tripod', 'Tripod', 'Manfrotto', 69, ['universal'], 'Shelf C'),
  A('TRI-002', 'Manfrotto Compact Action Tripod', 'Tripod', 'Manfrotto', 69, ['universal'], 'Shelf C'),
  A('TRI-003', 'Neewer Video Tripod with Fluid Head', 'Tripod', 'Neewer', 119, ['universal'], 'Shelf C'),
  A('MIC-001', 'Rode VideoMic GO II', 'Microphone', 'Rode', 99, ['universal'], 'Cabinet B'),
  A('MIC-002', 'Rode Wireless GO II', 'Microphone', 'Rode', 299, ['universal'], 'Cabinet B'),
  A('MIC-003', 'Zoom H1n Audio Recorder', 'Microphone', 'Zoom', 119, ['universal'], 'Cabinet B'),
  A('LGT-001', 'Aputure MC RGB Light', 'Lighting', 'Aputure', 89, ['universal'], 'Shelf C'),
  A('LGT-002', 'Neewer 660 LED Panel', 'Lighting', 'Neewer', 129, ['universal'], 'Shelf C'),
  A('BAG-001', 'Lowepro Camera Shoulder Bag', 'Bag', 'Lowepro', 39, ['universal'], 'Shelf C'),
  A('BAG-002', 'Lowepro Camera Shoulder Bag', 'Bag', 'Lowepro', 39, ['universal'], 'Shelf C'),
  A('BAG-003', 'Peak Design Everyday Sling', 'Bag', 'Peak Design', 99, ['universal'], 'Shelf C'),
];

const KITS = [
  { tag: 'KIT-01', name: 'Canon T7i Kit A', description: 'Camera with 18-55mm lens, battery, charger, SD card and bag.', items: ['CAM-001', 'BAT-001', 'CHG-001', 'SD-001', 'BAG-001'] },
  { tag: 'KIT-02', name: 'Canon T7i Kit B', description: 'Camera with 18-55mm lens, battery, charger, SD card and bag.', items: ['CAM-002', 'BAT-002', 'CHG-002', 'SD-002', 'BAG-002'] },
  { tag: 'KIT-03', name: 'Sony Vlog Kit', description: 'Sony a6400 with 16-50mm lens, battery, charger, SD card and on-camera mic.', items: ['CAM-004', 'BAT-007', 'CHG-004', 'SD-003', 'MIC-001'] },
];

/** Deterministic PRNG so the demo looks the same every time. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a scribbled "signature" into a small transparent PNG. */
export function demoSignaturePng(seed = 1) {
  const W = 360;
  const H = 110;
  const px = Buffer.alloc(W * H * 4);
  const rand = mulberry32(seed);
  const loops = 5 + Math.floor(rand() * 4);
  const dot = (cx, cy, r) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * W + x) * 4;
        px[i] = 30; px[i + 1] = 41; px[i + 2] = 82; px[i + 3] = 255;
      }
    }
  };
  for (let t = 0; t <= 1; t += 0.0008) {
    const x = 24 + t * 300 + 14 * Math.sin(t * loops * Math.PI * 2);
    const y = 58 + 26 * Math.cos(t * loops * Math.PI * 2) * (1 - t * 0.5) - 10 * Math.sin(t * Math.PI);
    dot(x, y, 1.6);
  }
  for (let x = 40; x < 330; x += 1) dot(x, 92 + Math.sin(x / 40) * 2, 1.1);

  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Loads demo data into an empty database. Returns false if items already exist. */
export function seedDemo(ctx) {
  const { db } = ctx;
  if (db.get('SELECT COUNT(*) AS n FROM assets').n > 0) return false;
  const realNow = ctx.now;
  const now = realNow().toISOString();
  const at = (iso) => {
    ctx.now = () => new Date(iso);
  };
  const rand = mulberry32(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];

  try {
    db.transaction(() => {
      at(addDays(now, -220));
      const password = hashPassword('demo1234');
      const users = {};
      for (const u of USERS) {
        const { id } = db.run(
          `INSERT INTO users (username, name, email, student_id, role, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [u.username, u.name, u.email ?? null, u.student_id ?? null, u.role ?? 'student', password, ctx.now().toISOString()],
        );
        users[u.username] = { id, ...u, role: u.role ?? 'student' };
      }
      const teacher = users.teacher;
      const students = Object.values(users).filter((u) => u.role === 'student');

      const ids = {};
      for (const a of ASSETS) {
        const fields = { ...a };
        delete fields.parent;
        ids[a.tag] = createAsset(ctx, teacher, { ...fields, requires_signature: a.tag === 'MIC-002' });
      }
      for (const a of ASSETS.filter((x) => x.parent)) {
        db.run('UPDATE assets SET parent_id = ? WHERE id = ?', [ids[a.parent], ids[a.tag]]);
        db.run(
          "INSERT INTO asset_events (asset_id, type, actor_id, message, created_at) VALUES (?, 'attached', ?, ?, ?)",
          [ids[a.tag], teacher.id, `Attached to ${a.parent}`, ctx.now().toISOString()],
        );
      }
      const kits = {};
      for (const k of KITS) {
        const { id } = db.run('INSERT INTO kits (tag, name, description, created_at) VALUES (?, ?, ?, ?)', [k.tag, k.name, k.description, ctx.now().toISOString()]);
        kits[k.tag] = id;
        for (const tag of k.items) db.run('UPDATE assets SET kit_id = ? WHERE id = ?', [id, ids[tag]]);
      }

      // --- A few months of finished loans, one after another. -------------
      const options = [
        [{ type: 'kit', id: kits['KIT-01'] }],
        [{ type: 'kit', id: kits['KIT-02'] }],
        [{ type: 'kit', id: kits['KIT-03'] }],
        [{ type: 'asset', id: ids['CAM-003'] }, { type: 'asset', id: ids['BAT-005'] }, { type: 'asset', id: ids['SD-004'] }],
        [{ type: 'asset', id: ids['CAM-005'] }, { type: 'asset', id: ids['BAT-008'] }, { type: 'asset', id: ids['SD-005'] }],
        [{ type: 'asset', id: ids['VID-001'] }, { type: 'asset', id: ids['BAT-010'] }, { type: 'asset', id: ids['TRI-003'] }],
        [{ type: 'asset', id: ids['TRI-001'] }, { type: 'asset', id: ids['LGT-001'] }],
        [{ type: 'asset', id: ids['TRI-002'] }, { type: 'asset', id: ids['LGT-002'] }, { type: 'asset', id: ids['MIC-003'] }],
        [{ type: 'asset', id: ids['LENS-003'] }, { type: 'asset', id: ids['BAT-003'] }],
        [{ type: 'asset', id: ids['LENS-007'] }, { type: 'asset', id: ids['BAT-009'] }, { type: 'asset', id: ids['SD-006'] }],
        [{ type: 'asset', id: ids['MIC-002'] }, { type: 'asset', id: ids['BAG-003'] }],
        [{ type: 'asset', id: ids['LENS-004'] }, { type: 'asset', id: ids['BAT-004'] }],
      ];
      const damageNotes = {
        'Camera Body': ['Scratch on the rear screen', 'Battery door latch broken', 'Strap ring bent'],
        Camcorder: ['Flip screen hinge loose', 'Scratch on the rear screen'],
        Lens: ['Lens cap missing, front element smudged', 'Dent on the barrel', 'Zoom ring sticks'],
        Battery: ['Swollen casing', 'Contacts corroded', 'Won’t hold a charge'],
        Charger: ['Frayed cable', 'Cracked housing'],
        'Memory Card': ['Write-protect switch broken', 'Card is cracked', 'Card shows errors in camera'],
        Tripod: ['Leg clamp snapped', 'Quick-release plate missing'],
        Microphone: ['Windscreen torn', 'Frayed cable'],
        Lighting: ['Diffuser cracked', 'Mounting screw stripped'],
        Bag: ['Zipper broken', 'Strap ring bent'],
      };
      const signatureFor = (borrower) => ({ signer_name: borrower.name, signer_role: 'student', image: demoSignaturePng(borrower.id) });

      let t = addDays(now, -200);
      let lostDone = false;
      while (t < addDays(now, -25)) {
        const borrower = pick(students);
        const entries = pick(options);
        at(t);
        const loanDays = 1 + Math.floor(rand() * 4);
        const due = addDays(t, loanDays);
        let loan;
        try {
          loan = commitCheckout(ctx, teacher, { borrower_id: borrower.id, entries, due_at: due, signature: signatureFor(borrower) });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          t = addDays(t, 1); // e.g. an item in that set was lost; try another set
          continue;
        }
        const late = rand() < 0.15;
        const returnAt = late ? addHours(due, 20 + Math.floor(rand() * 60)) : addHours(t, 6 + Math.floor(rand() * loanDays * 20));
        at(returnAt);
        const items = [];
        for (const item of loan.items) {
          if (!lostDone && item.asset.tag === 'SD-006' && t > addDays(now, -60)) {
            markLoanItemLost(ctx, teacher, item.id, { notes: 'Student says it fell out of the bag on a field trip' });
            lostDone = true;
            continue;
          }
          const roll = rand();
          const condition = roll < 0.07 ? 'damaged' : roll < 0.25 ? 'fair' : 'excellent';
          items.push({
            loan_item_id: item.id, condition, confirmation: rand() < 0.85 ? 'scan' : 'manual',
            notes: condition === 'damaged' ? pick(damageNotes[item.asset.category] ?? ['Damaged']) : condition === 'fair' && rand() < 0.4 ? 'Minor scuffs' : null,
          });
        }
        if (items.length) processReturn(ctx, teacher, { items });
        // Repairs are done a couple of days later.
        at(addDays(returnAt, 2));
        for (const i of items.filter((x) => x.condition === 'damaged')) {
          const assetId = loan.items.find((li) => li.id === i.loan_item_id).asset.id;
          setAssetState(ctx, teacher, assetId, { state: 'active', condition: 'fair', notes: 'Repaired' });
        }
        t = addHours(addDays(returnAt, 2), 3 + Math.floor(rand() * 30));
      }

      // --- A shelf audit last week found a battery missing. ---------------
      at(addDays(now, -10));
      const auditStart = ctx.now().toISOString();
      const chargingIds = db.all("SELECT id, tag, name, category, location FROM assets WHERE location = 'Charging Station' AND state = 'active' ORDER BY tag");
      const missing = chargingIds.filter((a) => a.tag === 'BAT-004');
      const found = chargingIds.filter((a) => a.tag !== 'BAT-004');
      const { id: auditId } = db.run(
        'INSERT INTO audits (location, started_by, started_at, finished_at, summary) VALUES (?, ?, ?, ?, ?)',
        ['Charging Station', teacher.id, auditStart, addHours(auditStart, 0.2), JSON.stringify({
          expected_count: chargingIds.length, found, missing, unexpected: [], actions: ['1 missing item(s) marked lost'],
        })],
      );
      for (const a of found) db.run('INSERT INTO audit_scans (audit_id, asset_id, scanned_at) VALUES (?, ?, ?)', [auditId, a.id, auditStart]);
      setAssetState(ctx, teacher, ids['BAT-004'], { state: 'lost', notes: `Missing in audit #${auditId} in Charging Station` });

      // --- Current activity. ----------------------------------------------
      // Light came back damaged three days ago and is waiting for repair.
      at(addDays(now, -5));
      const lightLoan = commitCheckout(ctx, teacher, { borrower_id: users.priya.id, entries: [{ type: 'asset', id: ids['LGT-001'] }], due_at: addDays(now, -3) });
      at(addDays(now, -3));
      processReturn(ctx, teacher, { items: [{ loan_item_id: lightLoan.items[0].id, condition: 'damaged', notes: 'Diffuser panel cracked', confirmation: 'scan' }] });

      // Jordan's telephoto lens is three days overdue -> restricted.
      at(addDays(now, -6));
      commitCheckout(ctx, teacher, {
        borrower_id: users.jordan.id, entries: [{ type: 'asset', id: ids['LENS-004'] }], due_at: addDays(now, -3), signature: signatureFor(users.jordan),
      });
      // Sam's wireless mic is a few hours overdue -> still in the grace period.
      at(addDays(now, -2));
      commitCheckout(ctx, teacher, {
        borrower_id: users.sam.id, entries: [{ type: 'asset', id: ids['MIC-002'] }, { type: 'asset', id: ids['TRI-002'] }], due_at: addHours(now, -5), signature: signatureFor(users.sam),
      });
      // Maya has Kit B out for her documentary project.
      at(addDays(now, -1));
      commitCheckout(ctx, teacher, {
        borrower_id: users.maya.id, entries: [{ type: 'kit', id: kits['KIT-02'] }], due_at: addDays(now, 2), signature: signatureFor(users.maya),
      });

      // Bookings: Alex has the R6 tomorrow-ish; Priya booked a tripod next week.
      at(now);
      createReservation(ctx, users.alex, {
        start_at: addHours(now, 6), end_at: addDays(addHours(now, 6), 2),
        entries: [{ type: 'asset', id: ids['CAM-003'] }, { type: 'asset', id: ids['BAT-005'] }],
        note: 'Senior film shoot',
      });
      createReservation(ctx, users.priya, {
        start_at: addDays(now, 6), end_at: addDays(now, 8),
        entries: [{ type: 'asset', id: ids['TRI-003'] }, { type: 'asset', id: ids['LGT-002'] }],
      });
    });
  } finally {
    ctx.now = realNow;
  }
  return true;
}
