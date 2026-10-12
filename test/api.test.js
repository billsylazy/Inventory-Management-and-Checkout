import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PHOTO, SIGNATURE, seedCameraKit, setup } from './helpers.js';

describe('auth and permissions', () => {
  let t;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    t.addUser('stu');
  });
  after(() => t.close());

  test('rejects a wrong password and anonymous requests', async () => {
    const bad = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }),
    });
    assert.equal(bad.status, 401);
    const anon = await fetch(`${t.base}/api/assets`);
    assert.equal(anon.status, 401);
  });

  test('state-changing requests must be JSON (CSRF guard)', async () => {
    const res = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=password123',
    });
    assert.equal(res.status, 415);
  });

  test('students cannot use staff endpoints', async () => {
    const stu = await t.login('stu');
    assert.equal((await stu.post('/api/assets', { tag: 'X', name: 'X', category: 'Other' })).status, 403);
    assert.equal((await stu.get('/api/users')).status, 403);
    assert.equal((await stu.get('/api/reports/loss-damage')).status, 403);
    assert.equal((await stu.get('/api/audits')).status, 403);
    assert.equal((await stu.get('/api/assets')).status, 200);
  });

  test('password change clears the must-change flag', async () => {
    const admin = await t.login('admin');
    const created = await admin.post('/api/users', { username: 'newbie', name: 'New Student' });
    assert.equal(created.status, 201);
    assert.ok(created.body.temporary_password);
    const newbie = await t.login('newbie', created.body.temporary_password);
    assert.equal((await newbie.get('/api/auth/me')).body.user.must_change_password, true);
    const changed = await newbie.post('/api/auth/password', { current_password: created.body.temporary_password, new_password: 'a-much-better-pw' });
    assert.equal(changed.status, 200);
    assert.equal((await newbie.get('/api/auth/me')).body.user.must_change_password, false);
  });
});

describe('parent-child assets, kits and compatibility', () => {
  let t;
  let admin;
  let gear;
  let studentId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    studentId = t.addUser('stu', 'student', { name: 'Stu Dent', student_id: 'S123' });
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
    await admin.post('/api/assets', { tag: 'TRI-1', name: 'Tripod', category: 'Tripod', compat: ['universal'] });
    await admin.post('/api/assets', { tag: 'BAT-SONY', name: 'NP-FW50', category: 'Battery', compat: ['battery:NP-FW50'] });
    await admin.post('/api/assets', { tag: 'CAM-2', name: 'Another body', category: 'Camera Body', compat: ['mount:EF'] });
  });
  after(() => t.close());

  test('an attached lens keeps its own tag and shows under its parent', async () => {
    const detail = (await admin.get(`/api/assets/${gear.camera.id}`)).body;
    assert.deepEqual(detail.children.map((c) => c.tag), ['LENS-1']);
    const lens = (await admin.get(`/api/assets/${gear.lens.id}`)).body;
    assert.equal(lens.parent.tag, 'CAM-1');
    assert.ok(lens.history.some((e) => e.type === 'attached'));
  });

  test('attaching cannot create a loop', async () => {
    const res = await admin.post(`/api/assets/${gear.camera.id}/attach`, { parent_tag: 'LENS-1' });
    assert.equal(res.status, 400);
  });

  test('suggests only compatible accessories for a camera body', async () => {
    const res = await admin.get(`/api/assets?compatible_with=${gear.camera.id}`);
    const tags = res.body.assets.map((a) => a.tag).sort();
    assert.deepEqual(tags, ['BAT-1', 'CHG-1', 'LENS-1', 'SD-1', 'TRI-1']);
    const lens = res.body.assets.find((a) => a.tag === 'LENS-1');
    assert.deepEqual(lens.match, ['mount:EF']);
  });

  test('scanning a kit checks out every item plus attached accessories', async () => {
    const scan = await admin.get('/api/scan?code=KIT-1');
    assert.equal(scan.body.type, 'kit');
    assert.equal(scan.body.kit.items.length, 4);

    const entries = [{ type: 'kit', id: gear.kit.id }];
    const preview = await admin.post('/api/checkout/preview', { borrower_id: studentId, entries });
    assert.equal(preview.body.can_checkout, true);
    assert.deepEqual(preview.body.lines.map((l) => l.asset.tag).sort(), ['BAT-1', 'CAM-1', 'CHG-1', 'LENS-1', 'SD-1']);
    assert.equal(preview.body.lines.find((l) => l.asset.tag === 'LENS-1').source, 'attached');
    assert.equal(preview.body.signature_required, true, 'camera worth $749 needs a signature');

    const noSig = await admin.post('/api/checkout', { borrower_id: studentId, entries });
    assert.equal(noSig.status, 400);

    const res = await admin.post('/api/checkout', {
      borrower_id: studentId, entries, signature: { signer_name: 'Stu Dent', signer_role: 'student', image: SIGNATURE },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.loan.items.length, 5);
    assert.equal(res.body.loan.signatures.length, 1);
    assert.match(res.body.loan.signatures[0].image_url, /^\/files\/signatures\//);

    const kit = (await admin.get(`/api/kits/${gear.kit.id}`)).body.kit;
    assert.equal(kit.status.code, 'checked_out');
    const cam = (await admin.get(`/api/assets/${gear.camera.id}`)).body.asset;
    assert.equal(cam.status.code, 'checked_out');
    assert.equal(cam.status.borrower.name, 'Stu Dent');
  });

  test('returning requires each kit item to be confirmed individually', async () => {
    const lookup = await admin.get('/api/returns/lookup?code=KIT-1');
    assert.equal(lookup.status, 200);
    const loan = lookup.body.loans[0];
    assert.equal(loan.open_count, 5);

    // Only two items confirmed: the loan stays open for the rest.
    const some = loan.items.filter((i) => ['CAM-1', 'LENS-1'].includes(i.asset.tag));
    const res = await admin.post('/api/returns', {
      items: some.map((i) => ({ loan_item_id: i.id, condition: 'excellent', confirmation: 'scan' })),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.loans[0].open_count, 3);
    assert.equal(res.body.loans[0].closed_at, null);
    const kit = (await admin.get(`/api/kits/${gear.kit.id}`)).body.kit;
    assert.equal(kit.status.label, '3 of 4 out');

    const missingCondition = await admin.post('/api/returns', { items: [{ loan_item_id: loan.items.find((i) => i.asset.tag === 'SD-1').id }] });
    assert.equal(missingCondition.status, 400);

    const rest = loan.items.filter((i) => !['CAM-1', 'LENS-1'].includes(i.asset.tag));
    const done = await admin.post('/api/returns', {
      items: rest.map((i) => ({ loan_item_id: i.id, condition: 'fair', confirmation: 'manual' })),
    });
    assert.equal(done.body.loans[0].open_count, 0);
    assert.ok(done.body.loans[0].closed_at);

    // Each item keeps its own history.
    const history = (await admin.get(`/api/assets/${gear.lens.id}`)).body.history.map((e) => e.type);
    assert.ok(history.includes('checked_out') && history.includes('returned'));
  });

  test('a kit item that is in repair is left out instead of blocking the kit', async () => {
    await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'repair' });
    const preview = await admin.post('/api/checkout/preview', { borrower_id: studentId, entries: [{ type: 'kit', id: gear.kit.id }] });
    const card = preview.body.lines.find((l) => l.asset.tag === 'SD-1');
    assert.equal(card.include, false);
    assert.equal(card.issues[0].level, 'warning');
    assert.equal(preview.body.can_checkout, true);

    const direct = await admin.post('/api/checkout/preview', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.card.id }] });
    assert.equal(direct.body.can_checkout, false);
    await admin.post(`/api/assets/${gear.card.id}/state`, { state: 'active' });
  });
});

describe('returns: condition logging, damage and analytics', () => {
  let t;
  let admin;
  let gear;
  let studentId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    studentId = t.addUser('stu', 'student', { name: 'Stu Dent' });
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  test('a damaged return with a photo is recorded and moves the item to repair', async () => {
    const out = await admin.post('/api/checkout', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.battery.id }] });
    assert.equal(out.status, 201);
    const item = out.body.loan.items[0];
    const res = await admin.post('/api/returns', {
      items: [{ loan_item_id: item.id, condition: 'damaged', notes: 'Swollen battery', photo: PHOTO, confirmation: 'scan' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.incidents, 1);
    const asset = (await admin.get(`/api/assets/${gear.battery.id}`)).body.asset;
    assert.equal(asset.condition, 'damaged');
    assert.equal(asset.state, 'repair');
    assert.equal(asset.status.code, 'unavailable');
    const photoUrl = res.body.loans[0].items[0].return_photo_url;
    assert.match(photoUrl, /^\/files\/photos\/[a-f0-9]{32}\.jpg$/);

    const report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.totals.damaged, 1);
    assert.equal(report.by_category[0].category, 'Battery');
    assert.equal(report.incidents[0].notes, 'Swollen battery');
  });

  test('a lost item is recorded with its value', async () => {
    const out = await admin.post('/api/checkout', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.card.id }] });
    const res = await admin.post(`/api/loan-items/${out.body.loan.items[0].id}/lost`, { notes: 'Fell out of bag' });
    assert.equal(res.status, 200);
    assert.ok(res.body.loan.closed_at);
    const report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.totals.lost, 1);
    assert.equal(report.totals.lost_value_cents, 1900);
    const csv = await admin.get('/api/reports/loss-damage.csv');
    assert.match(csv.body, /SD-1/);
  });

  test('rejects uploads that are not images', async () => {
    const out = await admin.post('/api/checkout', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.charger.id }] });
    const res = await admin.post('/api/returns', {
      items: [{ loan_item_id: out.body.loan.items[0].id, condition: 'fair', photo: 'data:image/jpeg;base64,PHNjcmlwdD4=' }],
    });
    assert.equal(res.status, 400);
  });
});

describe('grace period, restrictions and fines', () => {
  let t;
  let admin;
  let stu;
  let gear;
  let studentId;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    studentId = t.addUser('stu', 'student', { name: 'Stu Dent' });
    admin = await t.login('admin');
    stu = await t.login('stu');
    gear = await seedCameraKit(admin);
    await admin.patch('/api/settings', { grace_period_hours: 24, fine_per_day_cents: 100 });
  });
  after(() => t.close());

  test('overdue within the grace period only warns; after it, the student is restricted', async () => {
    const due = new Date(t.now().getTime() + 24 * 3600_000).toISOString();
    const out = await stu.post('/api/checkout', { entries: [{ type: 'asset', id: gear.battery.id }], due_at: due });
    assert.equal(out.status, 201, JSON.stringify(out.body));

    t.advance(30); // 6h overdue: inside grace
    let me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, false);
    assert.equal(me.restriction.warnings[0].code, 'grace');
    const ok = await stu.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.card.id }] });
    assert.equal(ok.body.can_checkout, true);

    t.advance(24); // 30h overdue: past grace
    me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, true);
    assert.equal(me.restriction.reasons[0].code, 'overdue');
    const blocked = await stu.post('/api/checkout', { entries: [{ type: 'asset', id: gear.card.id }] });
    assert.equal(blocked.status, 409);
    const start = new Date(t.now().getTime() + 48 * 3600_000).toISOString();
    const end = new Date(t.now().getTime() + 72 * 3600_000).toISOString();
    const booking = await stu.post('/api/reservations', { entries: [{ type: 'asset', id: gear.card.id }], start_at: start, end_at: end });
    assert.equal(booking.status, 403);
  });

  test('staff can override a restriction with a reason', async () => {
    const preview = await admin.post('/api/checkout/preview', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.card.id }] });
    assert.equal(preview.body.can_checkout, false);
    const res = await admin.post('/api/checkout', { borrower_id: studentId, entries: [{ type: 'asset', id: gear.card.id }], override_reason: 'Needed for final exam' });
    assert.equal(res.status, 201);
    assert.equal(res.body.loan.override_reason, 'Needed for final exam');
  });

  test('a late return creates a fine and lifts the restriction', async () => {
    const lookup = await admin.get(`/api/returns/lookup?code=${gear.battery.tag}`);
    const item = lookup.body.loans[0].items.find((i) => i.asset.tag === 'BAT-1');
    const res = await admin.post('/api/returns', { items: [{ loan_item_id: item.id, condition: 'excellent', confirmation: 'scan' }] });
    assert.equal(res.body.fines.length, 1);
    assert.equal(res.body.fines[0].amount_cents, 200); // 30 hours late -> 2 days
    const me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, false);
    assert.equal(me.restriction.warnings.find((w) => w.code === 'fines').amount_cents, 200);
  });

  test('unpaid fines can be made to block bookings, and waived', async () => {
    await admin.patch('/api/settings', { block_on_unpaid_fines: true });
    let me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, true);
    const fines = (await admin.get('/api/fines?status=unpaid')).body.fines;
    await admin.post(`/api/fines/${fines[0].id}`, { status: 'waived' });
    me = (await stu.get('/api/auth/me')).body;
    assert.equal(me.restriction.restricted, false);
  });

  test('students only see their own loans', async () => {
    const otherId = t.addUser('other');
    await admin.post('/api/checkout', { borrower_id: otherId, entries: [{ type: 'asset', id: gear.charger.id }] });
    const mine = (await stu.get('/api/loans?scope=all')).body.loans;
    assert.ok(mine.every((l) => l.borrower.id === studentId));
    const theirs = (await admin.get(`/api/loans?user_id=${otherId}`)).body.loans[0];
    assert.equal((await stu.get(`/api/loans/${theirs.id}`)).status, 403);
    assert.equal((await stu.get('/api/returns/lookup?code=CHG-1')).status, 403);
  });

  test('self check-out can be turned off', async () => {
    await admin.patch('/api/settings', { allow_student_self_checkout: false });
    const res = await stu.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.lens.id }] });
    assert.equal(res.status, 403);
    await admin.patch('/api/settings', { allow_student_self_checkout: true });
  });
});

describe('reservations and availability badges', () => {
  let t;
  let admin;
  let alice;
  let bob;
  let gear;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    t.addUser('alice');
    t.addUser('bob');
    admin = await t.login('admin');
    alice = await t.login('alice');
    bob = await t.login('bob');
    gear = await seedCameraKit(admin);
  });
  after(() => t.close());

  const hoursFromNow = (h) => new Date(t.now().getTime() + h * 3600_000).toISOString();

  test('a booking turns the badge yellow shortly before it starts', async () => {
    const res = await alice.post('/api/reservations', {
      entries: [{ type: 'asset', id: gear.camera.id }], start_at: hoursFromNow(48), end_at: hoursFromNow(72),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Lens is attached, so it is booked too.
    assert.deepEqual(res.body.reservation.items.map((i) => i.tag).sort(), ['CAM-1', 'LENS-1']);

    let cam = (await bob.get(`/api/assets/${gear.camera.id}`)).body.asset;
    assert.equal(cam.status.code, 'available', 'two days away: still green');
    t.advance(30);
    cam = (await bob.get(`/api/assets/${gear.camera.id}`)).body.asset;
    assert.equal(cam.status.code, 'reserved');
    assert.equal(cam.status.reserved_by, undefined, 'students do not see who booked it');
    const mine = (await alice.get(`/api/assets/${gear.camera.id}`)).body.asset;
    assert.equal(mine.status.label, 'Reserved for you');
  });

  test('overlapping bookings and conflicting check-outs are refused', async () => {
    const clash = await bob.post('/api/reservations', {
      entries: [{ type: 'asset', id: gear.camera.id }], start_at: hoursFromNow(10), end_at: hoursFromNow(30),
    });
    assert.equal(clash.status, 409);
    const out = await bob.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.camera.id }], due_at: hoursFromNow(30) });
    assert.equal(out.body.can_checkout, false);
    const shortLoan = await bob.post('/api/checkout/preview', { entries: [{ type: 'asset', id: gear.camera.id }], due_at: hoursFromNow(12) });
    assert.equal(shortLoan.body.can_checkout, true, 'a loan that ends before the booking starts is fine');
  });

  test('picking up a booking fulfils it', async () => {
    t.advance(20); // booking has started
    const res = await alice.post('/api/checkout', {
      entries: [{ type: 'asset', id: gear.camera.id }], due_at: hoursFromNow(20),
      signature: { signer_name: 'Alice', signer_role: 'student', image: SIGNATURE },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const list = (await alice.get('/api/reservations?past=1')).body.reservations;
    assert.equal(list[0].status, 'fulfilled');
  });

  test('an unclaimed booking is released after the pickup window', async () => {
    const res = await alice.post('/api/reservations', {
      entries: [{ type: 'asset', id: gear.charger.id }], start_at: hoursFromNow(1), end_at: hoursFromNow(100),
    });
    assert.equal(res.status, 201);
    t.advance(2);
    assert.equal((await bob.get(`/api/assets/${gear.charger.id}`)).body.asset.status.code, 'reserved');
    t.advance(24); // pickup window (24h) has passed
    assert.equal((await bob.get(`/api/assets/${gear.charger.id}`)).body.asset.status.code, 'available');
  });
});

describe('quick audit mode', () => {
  let t;
  let admin;
  let gear;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    const stuId = t.addUser('stu');
    admin = await t.login('admin');
    gear = await seedCameraKit(admin);
    await admin.post('/api/assets', { tag: 'TRI-9', name: 'Tripod', category: 'Tripod', location: 'Shelf C' });
    await admin.post('/api/checkout', { borrower_id: stuId, entries: [{ type: 'asset', id: gear.charger.id }] });
  });
  after(() => t.close());

  test('classifies scans as found, missing or unexpected and can mark missing items lost', async () => {
    const audit = (await admin.post('/api/audits', { location: 'Cabinet A' })).body.audit;
    // Charger is checked out, so only 4 items are expected on the shelf.
    assert.equal(audit.expected_count, 4);

    let r = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'CAM-1' });
    assert.equal(r.body.result, 'found');
    r = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'LENS-1' });
    assert.equal(r.body.result, 'found');
    r = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'TRI-9' });
    assert.equal(r.body.result, 'unexpected');
    assert.equal(r.body.asset.reason.code, 'location');
    r = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'CHG-1' });
    assert.equal(r.body.asset.reason.code, 'checked_out');
    r = await admin.post(`/api/audits/${audit.id}/scan`, { code: 'CAM-1' });
    assert.equal(r.body.duplicate, true);
    assert.equal((await admin.post(`/api/audits/${audit.id}/scan`, { code: 'NOPE' })).status, 404);
    assert.equal((await admin.post(`/api/audits/${audit.id}/scan`, { code: 'KIT-1' })).status, 400);

    assert.deepEqual(r.body.audit.missing.map((a) => a.tag).sort(), ['BAT-1', 'SD-1']);

    const fin = await admin.post(`/api/audits/${audit.id}/finish`, { mark_missing_lost: true, relocate_unexpected: true });
    assert.equal(fin.status, 200);
    assert.equal(fin.body.audit.summary.missing.length, 2);
    const bat = (await admin.get(`/api/assets/${gear.battery.id}`)).body.asset;
    assert.equal(bat.state, 'lost');
    const tripod = (await admin.get('/api/scan?code=TRI-9')).body.asset;
    assert.equal(tripod.location, 'Cabinet A');
    const report = (await admin.get('/api/reports/loss-damage')).body;
    assert.equal(report.totals.lost, 2);
  });
});

describe('CSV import', () => {
  let t;
  let admin;
  before(async () => {
    t = await setup();
    t.addUser('admin', 'admin');
    admin = await t.login('admin');
  });
  after(() => t.close());

  test('imports items with kits, parents and compatibility tags', async () => {
    const csv = [
      'tag,name,category,value,compat,parent_tag,kit_tag,location',
      'L-1,"Lens, 50mm",Lens,125,mount:EF,C-1,,Cab A',
      'C-1,Body,Camera Body,"$1,200.00",mount:EF;media:SD,,K-1,Cab A',
      'X-1,Mystery,Not A Category,1,,,,',
    ].join('\n');
    const res = await admin.post('/api/assets/import', { csv });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 2);
    assert.equal(res.body.errors.length, 1);
    const lens = (await admin.get('/api/scan?code=L-1')).body.asset;
    assert.equal(lens.name, 'Lens, 50mm');
    const body = (await admin.get('/api/scan?code=C-1')).body.asset;
    assert.equal(lens.parent_id, body.id);
    assert.equal(body.value_cents, 120000);
    const kit = (await admin.get('/api/scan?code=K-1')).body;
    assert.equal(kit.type, 'kit');
  });

  test('imports students with generated passwords', async () => {
    const res = await admin.post('/api/users/import', { csv: 'name,student_id\nAda Lovelace,S1\nGrace Hopper,S2\n' });
    assert.equal(res.body.created.length, 2);
    assert.ok(res.body.created[0].temporary_password);
    const ada = await t.login('S1', res.body.created[0].temporary_password);
    assert.equal((await ada.get('/api/auth/me')).body.user.name, 'Ada Lovelace');
  });
});
