import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createContext } from '../server/app.js';
import { PHOTO, SIGNATURE, seedCameraKit, setup } from './helpers.js';

const hoursFrom = (t, h) => new Date(t.now().getTime() + h * 3600_000).toISOString();

describe('every staff-only endpoint refuses students', () => {
  let t;
  let stu;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    t.addUser('stu', 'student', { student_id: 'S1' });
    const admin = await t.login('admin');
    await seedCameraKit(admin);
    stu = await t.login('stu');
  });
  after(() => t.close());

  const calls = [
    ['post', '/api/assets'], ['patch', '/api/assets/1'], ['del', '/api/assets/1'], ['post', '/api/assets/import'],
    ['post', '/api/assets/1/photo'], ['post', '/api/assets/1/attach'], ['post', '/api/assets/1/detach'],
    ['post', '/api/assets/1/state'], ['post', '/api/assets/1/damage'], ['post', '/api/assets/1/duplicate'],
    ['post', '/api/kits'], ['patch', '/api/kits/1'], ['del', '/api/kits/1'], ['post', '/api/kits/1/items'], ['del', '/api/kits/1/items/1'],
    ['post', '/api/loans/1/extend'], ['post', '/api/loan-items/1/lost'],
    ['get', '/api/audits'], ['post', '/api/audits'], ['get', '/api/audits/1'],
    ['get', '/api/reports/loss-damage'], ['get', '/api/reports/loss-damage.csv'], ['get', '/api/reports/overview'],
    ['get', '/api/users'], ['post', '/api/users'], ['get', '/api/users/1'], ['patch', '/api/users/1'], ['post', '/api/users/import'],
    ['get', '/api/fines'], ['post', '/api/fines/1'],
    ['patch', '/api/settings'], ['post', '/api/categories'], ['patch', '/api/categories/Lens'], ['del', '/api/categories/Lens'],
  ];
  for (const [method, url] of calls) {
    test(`${method.toUpperCase()} ${url} -> 403`, async () => {
      const res = method === 'get' || method === 'del' ? await stu[method](url) : await stu[method](url, {});
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });
  }

  test('students cannot look people up by scanning an ID', async () => {
    assert.equal((await stu.get('/api/scan?code=S1')).status, 404);
  });

  test('unknown API routes 404 and anonymous requests 401', async () => {
    assert.equal((await stu.get('/api/nope')).status, 404);
    for (const url of ['/api/assets', '/api/kits', '/api/loans', '/api/reservations', '/api/settings', '/files/assets/0123456789abcdef0123456789abcdef.jpg']) {
      assert.equal((await fetch(`${t.base}${url}`)).status, 401, url);
    }
  });
});

describe('uploaded files', () => {
  let t;
  let admin;
  let stu;
  let gear;
  let stuId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    stuId = t.addUser('stu');
    admin = await t.login('admin');
    stu = await t.login('stu');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('item photos are visible to everyone signed in, signatures only to staff', async () => {
    const photo = await admin.post(`/api/assets/${gear.camera.id}/photo`, { image: PHOTO });
    assert.match(photo.body.photo_url, /^\/files\/assets\/[a-f0-9]{32}\.jpg$/);
    assert.equal((await stu.get(photo.body.photo_url)).status, 200);

    const loan = (await admin.post('/api/checkout', {
      borrower_id: stuId, entries: [{ type: 'asset', id: gear.camera.id }],
      signature: { signer_name: 'Stu', signer_role: 'parent', image: SIGNATURE },
    })).body.loan;
    const sigUrl = (await admin.get(`/api/loans/${loan.id}`)).body.loan.signatures[0].image_url;
    assert.equal((await admin.get(sigUrl)).status, 200);
    assert.equal((await stu.get(sigUrl)).status, 403);
    assert.equal((await stu.get(`/api/loans/${loan.id}`)).body.loan.signatures[0].image_url, null);
  });

  test('replacing a photo deletes the old file; bad paths 404', async () => {
    const first = (await admin.get(`/api/assets/${gear.camera.id}`)).body.asset.photo_url;
    const second = (await admin.post(`/api/assets/${gear.camera.id}/photo`, { image: PHOTO })).body.photo_url;
    assert.notEqual(first, second);
    assert.equal((await admin.get(first)).status, 404);
    assert.equal((await admin.get('/files/assets/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await admin.get('/files/secret/0123456789abcdef0123456789abcdef.jpg')).status, 404);
  });

  test('signatures must be PNG and photos must really be images', async () => {
    const res = await admin.post('/api/checkout', {
      borrower_id: stuId, entries: [{ type: 'asset', id: gear.lens.id }],
      signature: { signer_name: 'x', signer_role: 'student', image: PHOTO },
    });
    // The lens is attached to the checked-out camera, so it is unavailable anyway;
    // use a fresh item for the signature format check.
    assert.ok([400, 409].includes(res.status));
    const big = await admin.post('/api/assets', { tag: 'BIG-1', name: 'Pricey', category: 'Other', value: '900' });
    const bad = await admin.post('/api/checkout', {
      borrower_id: stuId, entries: [{ type: 'asset', id: big.body.asset.id }],
      signature: { signer_name: 'x', signer_role: 'student', image: PHOTO },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /PNG/);
    const fake = await admin.post(`/api/assets/${big.body.asset.id}/photo`, { image: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` });
    assert.equal(fake.status, 400);
    const huge = await admin.post(`/api/assets/${big.body.asset.id}/photo`, { image: `data:image/jpeg;base64,${Buffer.alloc(7 * 1024 * 1024, 0xff).toString('base64')}` });
    assert.ok([400, 413].includes(huge.status), String(huge.status));
  });

  test('QR label endpoint returns SVG', async () => {
    const res = await admin.get('/api/qr.svg?code=CAM-1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(res.body, /<svg/);
  });
});

describe('items: validation, attach rules, state changes', () => {
  let t;
  let admin;
  let gear;
  let stuId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    stuId = t.addUser('stu');
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('rejects duplicate tags (including kit tags), unknown categories and bad tags', async () => {
    assert.equal((await admin.post('/api/assets', { tag: 'cam-1', name: 'x', category: 'Lens' })).status, 409, 'case-insensitive duplicate');
    assert.equal((await admin.post('/api/assets', { tag: 'KIT-1', name: 'x', category: 'Lens' })).status, 409);
    assert.equal((await admin.post('/api/kits', { tag: 'CAM-1', name: 'x' })).status, 409);
    assert.equal((await admin.post('/api/assets', { tag: 'NEW-1', name: 'x', category: 'Spaceship' })).status, 400);
    assert.equal((await admin.post('/api/assets', { tag: 'HAS SPACE ', name: 'x', category: 'Lens' })).status, 201, 'inner spaces are fine; ends are trimmed');
    assert.equal((await admin.post('/api/assets', { tag: 'tab\tx', name: 'x', category: 'Lens' })).status, 400);
    assert.equal((await admin.post('/api/assets', { tag: 'OK-2', category: 'Lens' })).status, 400);
    const priced = await admin.post('/api/assets', { tag: 'OK-3', name: 'x', category: 'Lens', value: '$1,200.50' });
    assert.equal(priced.body.asset.value_cents, 120050);
    assert.equal((await admin.post('/api/assets', { tag: 'OK-4', name: 'x', category: 'Lens', value: 'lots' })).status, 400);
  });

  test('stores HTML-looking names as plain text', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const res = await admin.post('/api/assets', { tag: 'XSS-1', name, category: 'Other' });
    assert.equal(res.body.asset.name, name);
  });

  test('edits are logged; compat tags are normalised and de-duplicated', async () => {
    const res = await admin.patch(`/api/assets/${gear.card.id}`, { name: 'SD 64GB V30', compat: ['media : SD', 'MEDIA:sd', ' universal '] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.asset.compat, ['media:SD', 'universal']);
    assert.match(res.body.history[0].message, /Updated name, compatibility tags/);
  });

  test('attaching moves an accessory between parents and is refused while only one is on loan', async () => {
    await admin.post('/api/assets', { tag: 'CAM-2', name: 'Body 2', category: 'Camera Body' });
    let res = await admin.post(`/api/assets/${gear.lens.id}/attach`, { parent_tag: 'CAM-2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.parent.tag, 'CAM-2');
    const cam1 = (await admin.get(`/api/assets/${gear.camera.id}`)).body;
    assert.equal(cam1.children.length, 0);
    assert.ok(cam1.history.some((e) => e.type === 'detached'));

    await admin.post('/api/checkout', { borrower_id: stuId, entries: [{ type: 'asset', id: gear.battery.id }] });
    res = await admin.post(`/api/assets/${gear.battery.id}/attach`, { parent_tag: 'CAM-1' });
    assert.equal(res.status, 409);
    res = await admin.post(`/api/assets/${gear.lens.id}/attach`, { parent_tag: 'NOPE' });
    assert.equal(res.status, 404);
    res = await admin.post(`/api/assets/${gear.lens.id}/attach`, { parent_id: gear.lens.id });
    assert.equal(res.status, 400);
    res = await admin.post(`/api/assets/${gear.lens.id}/detach`);
    assert.equal(res.body.parent, null);
  });

  test('state changes: blocked while on loan; lost/found and repair resolve incidents', async () => {
    assert.equal((await admin.post(`/api/assets/${gear.battery.id}/state`, { state: 'lost' })).status, 409);
    assert.equal((await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'stolen' })).status, 400);

    await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'lost', notes: 'not on shelf' });
    let report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.totals.lost, 1);
    assert.equal(report.totals.unresolved, 1);
    const found = await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'active', condition: 'fair' });
    assert.equal(found.body.asset.state, 'active');
    assert.equal(found.body.asset.condition, 'fair');
    report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.totals.unresolved, 0);
    assert.equal(report.incidents[0].resolution, 'found');

    const dmg = await admin.post(`/api/assets/${gear.charger.id}/damage`, { notes: 'Cracked', photo: PHOTO });
    assert.equal(dmg.body.asset.state, 'repair');
    assert.equal(dmg.body.asset.condition, 'damaged');
    assert.equal((await admin.post(`/api/assets/${gear.charger.id}/damage`, {})).status, 400, 'description required');
    await admin.post(`/api/assets/${gear.charger.id}/state`, { state: 'active' });
    report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.incidents.find((i) => i.type === 'damaged').resolution, 'repaired');
  });

  test('retired items leave the catalogue; items with history cannot be deleted', async () => {
    await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'retired' });
    const list = (await admin.get('/api/assets')).body.assets.map((a) => a.tag);
    assert.ok(!list.includes('SD-1'));
    const all = (await admin.get('/api/assets?include_retired=1')).body.assets.map((a) => a.tag);
    assert.ok(all.includes('SD-1'));
    assert.equal((await admin.del(`/api/assets/${gear.battery.id}`)).status, 409);
    const tmp = (await admin.post('/api/assets', { tag: 'TMP-1', name: 'Temp', category: 'Other' })).body.asset;
    assert.equal((await admin.del(`/api/assets/${tmp.id}`)).status, 200);
    assert.equal((await admin.get(`/api/assets/${tmp.id}`)).status, 404);
  });

  test('duplicate copies details, tags and photo under a new tag', async () => {
    await admin.post(`/api/assets/${gear.camera.id}/photo`, { image: PHOTO });
    const res = await admin.post(`/api/assets/${gear.camera.id}/duplicate`, { tag: 'CAM-9' });
    assert.equal(res.status, 201);
    assert.equal(res.body.asset.name, 'Canon T7i');
    assert.deepEqual([...res.body.asset.compat].sort(), ['battery:LP-E17', 'media:SD', 'mount:EF']);
    assert.ok(res.body.asset.photo_url);
    assert.equal((await admin.get(res.body.asset.photo_url)).status, 200);
    assert.equal((await admin.post(`/api/assets/${gear.camera.id}/duplicate`, { tag: 'CAM-9' })).status, 409);
  });

  test('search matches compat tags and filters by status/category/location', async () => {
    const byTag = (await admin.get('/api/assets?q=LP-E17')).body.assets.map((a) => a.tag).sort();
    assert.ok(byTag.includes('BAT-1') && byTag.includes('CHG-1') && byTag.includes('CAM-1'));
    const out = (await admin.get('/api/assets?status=checked_out')).body.assets.map((a) => a.tag);
    assert.deepEqual(out, ['BAT-1']);
    const lenses = (await admin.get('/api/assets?category=lens')).body.assets;
    assert.ok(lenses.every((a) => a.category === 'Lens'));
    const like = (await admin.get(`/api/assets?q=${encodeURIComponent('%')}`)).body.assets;
    assert.equal(like.length, 0, '% is matched literally');
  });
});

describe('kits management', () => {
  let t;
  let admin;
  let gear;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('moving an item between kits, removing it, renaming and deleting a kit', async () => {
    const kit2 = (await admin.post('/api/kits', { tag: 'KIT-2', name: 'Second' })).body.kit;
    let res = await admin.post(`/api/kits/${kit2.id}/items`, { tag: 'BAT-1' });
    assert.equal(res.body.moved_from, gear.kit.id);
    assert.equal((await admin.get(`/api/kits/${gear.kit.id}`)).body.kit.item_count, 3);
    assert.equal((await admin.post(`/api/kits/${kit2.id}/items`, { tag: 'KIT-1' })).status, 400, 'a kit tag is not an item');
    assert.equal((await admin.post(`/api/kits/${kit2.id}/items`, { tag: 'NOPE' })).status, 404);
    res = await admin.del(`/api/kits/${kit2.id}/items/${gear.battery.id}`);
    assert.equal(res.body.kit.item_count, 0);
    assert.equal((await admin.del(`/api/kits/${kit2.id}/items/${gear.battery.id}`)).status, 404);
    res = await admin.patch(`/api/kits/${kit2.id}`, { name: 'Renamed', tag: 'KIT-2B' });
    assert.equal(res.body.kit.tag, 'KIT-2B');
    assert.equal((await admin.patch(`/api/kits/${kit2.id}`, { tag: 'KIT-1' })).status, 409);
    assert.equal((await admin.del(`/api/kits/${gear.kit.id}`)).status, 200);
    const cam = (await admin.get(`/api/assets/${gear.camera.id}`)).body;
    assert.equal(cam.kit, null, 'items stay but leave the deleted kit');
    assert.ok(cam.history.some((e) => /deleted/.test(e.message)));
  });

  test('an empty kit cannot be checked out', async () => {
    const empty = (await admin.post('/api/kits', { tag: 'KIT-E', name: 'Empty' })).body.kit;
    const stuId = t.addUser('stu');
    const res = await admin.post('/api/checkout/preview', { borrower_id: stuId, entries: [{ type: 'kit', id: empty.id }] });
    assert.equal(res.status, 400);
  });
});

describe('loans: limits, extensions, lost items, double check-out', () => {
  let t;
  let admin;
  let stu;
  let gear;
  let stuId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    stuId = t.addUser('stu', 'student', { name: 'Stu Dent' });
    admin = await t.login('admin');
    stu = await t.login('stu');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('students cannot pick a due date beyond the limit or in the past', async () => {
    let res = await stu.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.card.id }], due_at: hoursFrom(t, 24 * 30) });
    assert.equal(res.body.can_checkout, false);
    assert.ok(res.body.errors.some((e) => e.code === 'due_too_far'));
    res = await stu.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.card.id }], due_at: hoursFrom(t, -1) });
    assert.ok(res.body.errors.some((e) => e.code === 'due_past'));
    res = await admin.post('/api/checkout/preview', { borrower_id: stuId, entries: [{ type: 'asset', id: gear.card.id }], due_at: hoursFrom(t, 24 * 30) });
    assert.equal(res.body.can_checkout, true, 'staff may set longer loans');
    res = await stu.post('/api/checkout/preview', { borrower_id: 999, entries: [] });
    assert.equal(res.status, 403, 'students cannot check out for someone else');
  });

  test('the same item cannot be checked out twice, even at the same moment', async () => {
    const body = { borrower_id: stuId, entries: [{ type: 'asset', id: gear.card.id }] };
    const results = await Promise.all([admin.post('/api/checkout', body), admin.post('/api/checkout', body), admin.post('/api/checkout', body)]);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  });

  test('extending a loan moves the due date; closed loans cannot be extended', async () => {
    const loan = (await admin.get(`/api/loans?user_id=${stuId}`)).body.loans[0];
    const due = hoursFrom(t, 24 * 10);
    const res = await admin.post(`/api/loans/${loan.id}/extend`, { due_at: due });
    assert.equal(res.body.loan.due_at, due);
    assert.equal((await admin.post(`/api/loans/${loan.id}/extend`, { due_at: hoursFrom(t, -2) })).status, 400);
    await admin.post('/api/returns', { items: [{ loan_item_id: loan.items[0].id, condition: 'excellent' }] });
    assert.equal((await admin.post(`/api/loans/${loan.id}/extend`, { due_at: due })).status, 409);
    assert.equal((await admin.post('/api/returns', { items: [{ loan_item_id: loan.items[0].id, condition: 'excellent' }] })).status, 409, 'cannot return twice');
  });

  test('marking an item lost can add a replacement fine', async () => {
    const out = await admin.post('/api/checkout', { borrower_id: stuId, entries: [{ type: 'asset', id: gear.charger.id }] });
    const res = await admin.post(`/api/loan-items/${out.body.loan.items[0].id}/lost`, { notes: 'gone', charge_replacement: true });
    assert.equal(res.status, 200);
    const fines = (await admin.get(`/api/users/${stuId}`)).body.fines;
    assert.equal(fines[0].amount_cents, 4500);
    assert.match(fines[0].reason, /Replacement cost/);
    assert.equal((await admin.post(`/api/loan-items/${out.body.loan.items[0].id}/lost`, {})).status, 409);
    const lostAsset = (await admin.get(`/api/assets/${gear.charger.id}`)).body.asset;
    assert.equal(lostAsset.state, 'lost');
  });

  test('a student return lookup by student ID is staff-only; unknown codes 404', async () => {
    assert.equal((await stu.get('/api/returns/lookup?code=stu')).status, 404);
    assert.equal((await admin.get('/api/returns/lookup?code=stu')).status, 409, 'nothing out');
    assert.equal((await admin.get('/api/returns/lookup?code=ZZZ')).status, 404);
    assert.equal((await admin.get('/api/returns/lookup?code=CAM-1')).status, 409, 'not checked out');
  });

  test('late-return cooldown restricts for the configured number of days', async () => {
    await admin.patch('/api/settings', { late_return_penalty_days: 2, grace_period_hours: 0 });
    const out = await stu.post('/api/checkout', { entries: [{ type: 'asset', id: gear.lens.id }], due_at: hoursFrom(t, 2) });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    t.advance(5);
    await stu.post('/api/returns', { items: [{ loan_item_id: out.body.loan.items[0].id, condition: 'excellent', confirmation: 'scan' }] });
    let me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.reasons[0].code, 'late_return');
    t.advance(49);
    me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, false);
  });
});

describe('bookings', () => {
  let t;
  let admin;
  let alice;
  let bob;
  let gear;
  let aliceId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    aliceId = t.addUser('alice');
    t.addUser('bob');
    admin = await t.login('admin');
    alice = await t.login('alice');
    bob = await t.login('bob');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('validates dates and length', async () => {
    const entries = [{ type: 'asset', id: gear.card.id }];
    assert.equal((await alice.post('/api/reservations', { entries, start_at: hoursFrom(t, 10), end_at: hoursFrom(t, 5) })).status, 400);
    assert.equal((await alice.post('/api/reservations', { entries, start_at: hoursFrom(t, -10), end_at: hoursFrom(t, -5) })).status, 400);
    assert.equal((await alice.post('/api/reservations', { entries, start_at: hoursFrom(t, 1), end_at: hoursFrom(t, 24 * 9) })).status, 400);
    assert.equal((await alice.post('/api/reservations', { entries: [], start_at: hoursFrom(t, 1), end_at: hoursFrom(t, 5) })).status, 400);
    assert.equal((await alice.post('/api/reservations', { entries, start_at: 'tomorrow-ish', end_at: hoursFrom(t, 5) })).status, 400);
    assert.equal((await alice.post('/api/reservations', { entries, user_id: 999, start_at: hoursFrom(t, 1), end_at: hoursFrom(t, 5) })).status, 403);
  });

  test('a kit booking holds every item; others see them as unavailable', async () => {
    const res = await alice.post('/api/reservations', { entries: [{ type: 'kit', id: gear.kit.id }], start_at: hoursFrom(t, 2), end_at: hoursFrom(t, 30) });
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.items.length, 5, 'kit items plus the attached lens');
    const avail = (await bob.get(`/api/availability?start=${encodeURIComponent(hoursFrom(t, 3))}&end=${encodeURIComponent(hoursFrom(t, 4))}`)).body.unavailable;
    assert.equal(Object.keys(avail).length, 5);
    const mine = (await alice.get(`/api/availability?start=${encodeURIComponent(hoursFrom(t, 3))}&end=${encodeURIComponent(hoursFrom(t, 4))}`)).body.unavailable;
    assert.equal(Object.keys(mine).length, 0, 'your own booking is not a conflict');
    const kit = (await bob.get(`/api/kits/${gear.kit.id}`)).body.kit;
    assert.equal(kit.status.code, 'reserved');
  });

  test('only the owner or staff can cancel, and only once', async () => {
    const r = (await alice.get('/api/reservations')).body.reservations[0];
    assert.equal((await bob.post(`/api/reservations/${r.id}/cancel`)).status, 403);
    assert.equal((await bob.get(`/api/reservations/${r.id}`)).status, 403);
    assert.equal((await alice.post(`/api/reservations/${r.id}/cancel`)).status, 200);
    assert.equal((await alice.post(`/api/reservations/${r.id}/cancel`)).status, 409);
    assert.equal((await bob.get(`/api/kits/${gear.kit.id}`)).body.kit.status.code, 'available');
  });

  test('staff can book for a student and see all bookings; students see only theirs', async () => {
    const res = await admin.post('/api/reservations', { user_id: aliceId, entries: [{ type: 'asset', id: gear.card.id }], start_at: hoursFrom(t, 50), end_at: hoursFrom(t, 60) });
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.user.id, aliceId);
    assert.equal((await bob.get('/api/reservations')).body.reservations.length, 0);
    assert.ok((await admin.get('/api/reservations')).body.reservations.length >= 1);
    assert.ok((await alice.get('/api/reservations?past=1')).body.reservations.some((r) => r.state === 'cancelled'));
  });

  test('booking can be switched off', async () => {
    await admin.patch('/api/settings', { allow_student_reservations: false });
    const res = await bob.post('/api/reservations', { entries: [{ type: 'asset', id: gear.charger.id }], start_at: hoursFrom(t, 2), end_at: hoursFrom(t, 4) });
    assert.equal(res.status, 403);
    await admin.patch('/api/settings', { allow_student_reservations: true });
  });
});

describe('audits: undo, restore, discard', () => {
  let t;
  let admin;
  let gear;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('an audit of everything can undo scans and bring lost items back', async () => {
    await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'lost' });
    const audit = (await admin.post('/api/audits', {})).body.audit;
    assert.equal(audit.location, null);
    assert.equal(audit.expected_count, 4);
    await admin.post(`/api/audits/${audit.id}/scan`, { code: 'cam-1' });
    let res = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'SD-1' });
    assert.equal(res.body.asset.reason.code, 'lost');
    res = await admin.del(`/api/audits/${audit.id}/scan/${gear.camera.id}`);
    assert.equal(res.body.audit.found.length, 0);
    res = await admin.post(`/api/audits/${audit.id}/finish`, { restore_found_lost: true });
    assert.equal(res.body.audit.summary.unexpected.length, 1);
    assert.equal((await admin.get(`/api/assets/${gear.card.id}`)).body.asset.state, 'active');
    assert.equal((await admin.post(`/api/audits/${audit.id}/scan`, { code: 'CAM-1' })).status, 409);
    assert.equal((await admin.post(`/api/audits/${audit.id}/finish`, {})).status, 409);
    assert.equal((await admin.del(`/api/audits/${audit.id}`)).status, 409);
    const list = (await admin.get('/api/audits')).body.audits;
    assert.equal(list[0].counts.unexpected, 1);
  });

  test('an unfinished audit can be discarded', async () => {
    const audit = (await admin.post('/api/audits', { location: 'Cabinet A' })).body.audit;
    assert.equal((await admin.del(`/api/audits/${audit.id}`)).status, 200);
    assert.equal((await admin.get(`/api/audits/${audit.id}`)).status, 404);
  });
});

describe('people, sessions and settings', () => {
  let t;
  let admin;
  let adminId;
  before(async () => {
    t = await setup();
    adminId = t.addUser('admin', 'admin');
    t.addUser('stu', 'student', { name: 'Stu Dent', student_id: 'S77' });
    admin = await t.login('admin');
    await admin.post('/api/assets', { tag: 'TAG-1', name: 'x', category: 'Other' });
  });
  after(() => t.close());

  test('usernames and student IDs must be unique and must not clash with equipment tags', async () => {
    assert.equal((await admin.post('/api/users', { name: 'A', username: 'STU' })).status, 409);
    assert.equal((await admin.post('/api/users', { name: 'A', username: 'a1', student_id: 's77' })).status, 409);
    assert.equal((await admin.post('/api/users', { name: 'A', username: 'a2', student_id: 'TAG-1' })).status, 409);
    assert.equal((await admin.post('/api/users', { name: 'A', username: 'has space' })).status, 400);
    assert.equal((await admin.post('/api/users', { name: 'A', username: 'a3', password: 'short' })).status, 400);
    const ok = await admin.post('/api/users', { name: 'A', username: 'a4', password: 'long-enough-pw' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.temporary_password, null);
  });

  test('students can sign in with the student ID on their card', async () => {
    const res = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'S77', password: 'password123' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.username, 'stu');
  });

  test('admins cannot lock themselves out', async () => {
    assert.equal((await admin.patch(`/api/users/${adminId}`, { role: 'student' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${adminId}`, { active: false })).status, 400);
  });

  test('deactivating or resetting a password ends that person’s sessions', async () => {
    const stuRow = (await admin.get('/api/users?q=Stu')).body.users[0];
    let stu = await t.login('stu');
    assert.equal((await stu.get('/api/auth/me')).status, 200);
    const reset = await admin.patch(`/api/users/${stuRow.id}`, { reset_password: true });
    assert.ok(reset.body.temporary_password);
    assert.equal((await stu.get('/api/auth/me')).status, 401);
    stu = await t.login('stu', reset.body.temporary_password);
    assert.equal((await stu.get('/api/auth/me')).body.user.must_change_password, true);
    await admin.patch(`/api/users/${stuRow.id}`, { active: false });
    assert.equal((await stu.get('/api/auth/me')).status, 401);
    await assert.rejects(() => t.login('stu', reset.body.temporary_password));
    await admin.patch(`/api/users/${stuRow.id}`, { active: true });
    const inactive = (await admin.get('/api/users?include_inactive=1')).body.users;
    assert.ok(inactive.length >= 3);
  });

  test('manual restriction shows up for the student and can be lifted', async () => {
    const stuRow = (await admin.get('/api/users?q=Stu')).body.users[0];
    const until = hoursFrom(t, 48);
    let res = await admin.patch(`/api/users/${stuRow.id}`, { restricted_until: until, restriction_note: 'Left gear in the hallway' });
    assert.equal(res.body.user.restriction.reasons[0].code, 'manual');
    assert.equal(res.body.user.restriction.reasons[0].message, 'Left gear in the hallway');
    res = await admin.patch(`/api/users/${stuRow.id}`, { restricted_until: null, restriction_note: null });
    assert.equal(res.body.user.restriction.restricted, false);
  });

  test('wrong current password is rejected when changing password', async () => {
    const res = await admin.post('/api/auth/password', { current_password: 'nope', new_password: 'another-password' });
    assert.equal(res.status, 400);
  });

  test('settings are validated', async () => {
    assert.equal((await admin.patch('/api/settings', { grace_period_hours: -1 })).status, 400);
    assert.equal((await admin.patch('/api/settings', { grace_period_hours: 1.5 })).status, 400);
    assert.equal((await admin.patch('/api/settings', { allow_student_self_checkout: 'yes' })).status, 400);
    assert.equal((await admin.patch('/api/settings', { made_up: 1 })).status, 400);
    assert.equal((await admin.patch('/api/settings', { school_name: '' })).status, 400);
    const ok = await admin.patch('/api/settings', { school_name: 'Film Lab', loan_days_default: 5 });
    assert.equal(ok.body.settings.school_name, 'Film Lab');
    assert.equal((await admin.get('/api/auth/me')).body.settings.loan_days_default, 5);
  });

  test('categories can be added, edited and removed only when unused', async () => {
    assert.equal((await admin.post('/api/categories', { name: 'Drone', kind: 'main', icon: 'drone' })).status, 201);
    assert.equal((await admin.post('/api/categories', { name: 'drone' })).status, 409);
    assert.equal((await admin.post('/api/categories', { name: 'Gimbal', icon: 'not-an-icon' })).status, 400);
    assert.equal((await admin.patch('/api/categories/Drone', { kind: 'accessory' })).status, 200);
    assert.equal((await admin.del('/api/categories/Other')).status, 400, 'TAG-1 uses Other');
    assert.equal((await admin.del('/api/categories/Drone')).status, 200);
    const cats = (await admin.get('/api/categories')).body.categories.map((c) => c.name);
    assert.ok(!cats.includes('Drone'));
  });

  test('CSV export neutralises spreadsheet formulas', async () => {
    const asset = (await admin.post('/api/assets', { tag: 'F-1', name: '=HYPERLINK("http://x")', category: 'Other' })).body.asset;
    await admin.post(`/api/assets/${asset.id}/state`, { state: 'lost', notes: '+cmd' });
    const csv = (await admin.get('/api/reports/loss-damage.csv')).body;
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
    assert.match(csv, /'\+cmd/);
    assert.equal((await admin.get(`/api/reports/loss-damage?from=${encodeURIComponent(hoursFrom(t, 5))}`)).status, 400);
  });

  test('sign-in is rate limited after repeated failures', async () => {
    const attempt = () => fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt()).status);
    assert.equal(statuses.slice(0, 10).every((s) => s === 401), true);
    assert.equal(statuses[10], 429);
  });
});

describe('data survives a restart', () => {
  test('reopening the database keeps records and re-running migrations is harmless', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-persist-'));
    try {
      const file = path.join(dir, 'inv.db');
      let ctx = createContext({ dbPath: file, uploadsDir: path.join(dir, 'up') });
      ctx.db.run("INSERT INTO kits (tag, name, created_at) VALUES ('K-1', 'Kit', '2026-01-01T00:00:00.000Z')");
      ctx.db.close();
      ctx = createContext({ dbPath: file, uploadsDir: path.join(dir, 'up') });
      assert.equal(ctx.db.get('SELECT name FROM kits WHERE tag = ?', ['K-1']).name, 'Kit');
      assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM categories').n, 12);
      ctx.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hosting: health check and backups', () => {
  let t;
  let admin;
  let stu;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    t.addUser('stu');
    admin = await t.login('admin');
    stu = await t.login('stu');
    await admin.post('/api/assets', { tag: 'BK-1', name: 'Backed up', category: 'Other' });
  });
  after(() => t.close());

  test('the health check answers without signing in', async () => {
    const res = await fetch(`${t.base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  test('staff can download a working copy of the database; students cannot', async () => {
    assert.equal((await stu.get('/api/backup')).status, 403);
    const cookie = (await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password123' }),
    })).headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${t.base}/api/backup`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="?inventory-backup-\d{4}-\d{2}-\d{2}\.db"?/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-restore-'));
    try {
      fs.writeFileSync(path.join(dir, 'restored.db'), bytes);
      const restored = createContext({ dbPath: path.join(dir, 'restored.db'), uploadsDir: path.join(dir, 'up') });
      assert.equal(restored.db.get("SELECT name FROM assets WHERE tag = 'BK-1'").name, 'Backed up');
      restored.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
