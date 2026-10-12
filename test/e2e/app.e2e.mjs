// End-to-end tests: drive the real app in Chromium against fresh demo data.
// Run with `npm run test:e2e`. Tests run in order and build on each other.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  drawSignature, expectToast, go, jpegBuffer, launch, navigate, scan, signIn, startServer,
} from './harness.mjs';

const T = { timeout: 90_000 };
const SHOTS = process.env.E2E_SCREENSHOTS || path.join(os.tmpdir(), 'inventory-e2e-failures');
let server;
let browser;
let base;
const errors = [];
let teacher; // desktop page signed in as staff

async function api(page, path) {
  const res = await page.context().request.get(`${base}/api${path}`);
  return res.json();
}
const idOf = async (page, tag) => (await api(page, `/scan?code=${encodeURIComponent(tag)}`)).asset.id;
const view = (page) => page.locator('.view');
const button = (page, name) => view(page).getByRole('button', { name, exact: true });
const modal = (page) => page.locator('.modal');
const modalButton = (page, name) => page.locator('.modal .modal-actions').getByRole('button', { name, exact: true });

function assertNoErrors() {
  const found = errors.splice(0);
  assert.deepEqual(found, [], `Unexpected errors:\n${found.join('\n')}`);
}

describe('media lab app in a real browser', () => {
  before(async () => {
    server = await startServer();
    base = server.base;
    browser = await launch();
    teacher = await signIn(browser, base, 'teacher', 'demo1234', { sink: errors });
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });
  // On failure, save a screenshot of every open page to help diagnose it.
  afterEach(async (t) => {
    if (!t.passed && browser) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const pages = browser.contexts().flatMap((c) => c.pages());
      for (const [i, p] of pages.entries()) {
        await p.screenshot({ path: path.join(SHOTS, `${t.name.replace(/\W+/g, '-').slice(0, 60)}-${i}.png`) }).catch(() => {});
      }
      console.log(`# screenshots saved to ${SHOTS}`);
    }
  });

  test('sign-in rejects a wrong password and explains why', T, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.fill('input[name=username]', 'teacher');
    await page.fill('input[name=password]', 'not-it');
    await page.click('button[type=submit]');
    await assert.doesNotReject(page.locator('.banner.danger', { hasText: 'Wrong username or password' }).waitFor());
    await context.close();
  });

  test('equipment grid: counts, status/category filters, search, kits tab', T, async () => {
    await go(teacher, base, '#/');
    assert.match(await view(teacher).locator('.page-header .sub').innerText(), /46 items in inventory/);
    assert.equal(await teacher.locator('.brand').innerText(), 'Media Lab');

    await button(teacher, 'Checked out').click();
    const badges = await view(teacher).locator('.asset-card .badge').allInnerTexts();
    assert.equal(badges.length, 9);
    assert.ok(badges.every((b) => /Checked out|Overdue/.test(b)), badges.join());
    await button(teacher, 'All').click();

    await view(teacher).getByRole('button', { name: 'Lens' }).click();
    const lensNames = await view(teacher).locator('.asset-card .meta').allInnerTexts();
    assert.equal(lensNames.length, 8);
    assert.ok(lensNames.every((m) => m.includes('Lens')));
    await button(teacher, 'All types').click();

    await view(teacher).locator('input[type=search]').fill('LP-E17');
    await teacher.waitForTimeout(300);
    const tags = await view(teacher).locator('.asset-card .tag-code').allInnerTexts();
    assert.ok(tags.includes('BAT-001') && tags.includes('CHG-001') && tags.includes('CAM-001'), tags.join());
    assert.ok(!tags.includes('BAT-007'));
    await view(teacher).locator('input[type=search]').fill('');

    await navigate(teacher, () => view(teacher).getByRole('tab', { name: 'Kits' }).click());
    assert.equal(await view(teacher).locator('.asset-card').count(), 3);
    assertNoErrors();
  });

  test('item page shows status, attached lens, compatible gear and history', T, async () => {
    await go(teacher, base, `#/item/${await idOf(teacher, 'CAM-002')}`);
    assert.equal(await view(teacher).locator('h1').innerText(), 'Canon EOS Rebel T7i');
    assert.match(await view(teacher).locator('.banner').first().innerText(), /Checked out to Maya Patel/);
    assert.match(await view(teacher).locator('section', { hasText: 'Attached accessories' }).innerText(), /LENS-002/);
    const compat = await view(teacher).locator('section', { hasText: 'Compatible accessories' }).locator('.tag-code').allInnerTexts();
    assert.ok(compat.includes('LENS-003') && compat.includes('BAT-003'), compat.join());
    assert.ok(!compat.some((t) => t.startsWith('LENS-006')), 'Sony E-mount lens must not be suggested for a Canon body');
    assert.ok(await view(teacher).locator('.timeline li').count() > 2);

    await view(teacher).getByRole('link', { name: 'Compatible gear' }).click();
    await teacher.waitForSelector('.view .banner.info');
    assert.match(await view(teacher).locator('.banner.info').innerText(), /works with/);
    assertNoErrors();
  });

  test('add an item with the form (tags, value, parent) and see it rendered safely', T, async () => {
    await go(teacher, base, '#/item/new');
    const form = view(teacher).locator('form');
    await form.locator('input[name=tag]').fill('TEST-001');
    await form.locator('input[name=name]').fill('Test <b>Lens</b> <img src=x onerror="window.__xss=1">');
    await form.locator('select[name=category]').selectOption('Lens');
    await form.locator('input[name=value]').fill('99.50');
    await form.locator('input[name=location]').fill('Cabinet B');
    const compat = form.getByPlaceholder('Add a tag and press Enter, e.g. mount:EF');
    await compat.fill('mount:E');
    await compat.press('Enter');
    await form.locator('input[name=parent_tag]').fill('CAM-005');
    await form.locator('input[type=file]').setInputFiles(await jpegBuffer(teacher));
    await form.getByRole('button', { name: 'Add item' }).click();
    await teacher.waitForURL(/#\/item\/\d+$/);
    await teacher.waitForSelector('.view h1');
    assert.equal(await view(teacher).locator('h1').innerText(), 'Test <b>Lens</b> <img src=x onerror="window.__xss=1">');
    assert.equal(await teacher.evaluate(() => window.__xss), undefined, 'HTML in a name must not run');
    assert.match(await view(teacher).locator('.facts').innerText(), /\$99\.50[\s\S]*Cabinet B[\s\S]*CAM-005/);
    assert.ok(await view(teacher).locator('.thumb-hero img').count() === 1, 'photo uploaded with the form');
    assert.match(await view(teacher).locator('.chips').innerText(), /mount:E/);
    assertNoErrors();
  });

  test('edit, repair, lost/found, damage report, duplicate and delete from the item page', T, async () => {
    const id = await idOf(teacher, 'TEST-001');
    await go(teacher, base, `#/item/${id}/edit`);
    await view(teacher).locator('input[name=name]').fill('Test Lens');
    await view(teacher).getByRole('button', { name: 'Save changes' }).click();
    await teacher.waitForURL(new RegExp(`#/item/${id}$`));
    await teacher.waitForSelector('.view h1:text("Test Lens")');

    const more = async (action) => {
      await button(teacher, 'More').click();
      await modal(teacher).getByRole('button', { name: action }).click();
    };
    await more('Send to repair');
    await modalButton(teacher, 'Save').click();
    await teacher.waitForSelector('.view .badge.lg:text("In repair")');

    await more('Repaired — back in service');
    await modalButton(teacher, 'Back in service').click();
    await teacher.waitForSelector('.view .badge.lg:text("Available")');

    await more('Mark as lost');
    await modal(teacher).locator('textarea').fill('Not in the cabinet');
    await modalButton(teacher, 'Save').click();
    await teacher.waitForSelector('.view .badge.lg:text("Lost")');
    await more('Found — back in service');
    await modalButton(teacher, 'Back in service').click();
    await teacher.waitForSelector('.view .badge.lg:text("Available")');

    await more('Report damage');
    await modal(teacher).locator('textarea').fill('Front element scratched');
    await modal(teacher).locator('input[type=file]').setInputFiles(await jpegBuffer(teacher));
    await modalButton(teacher, 'Report damage').click();
    await teacher.waitForSelector('.view .badge.lg:text("In repair")');
    const history = await view(teacher).locator('.timeline').innerText();
    assert.match(history, /Damage reported/);
    assert.ok(await view(teacher).locator('.timeline img').count() >= 1, 'damage photo in history');

    await more('Duplicate (same model, new tag)');
    await modal(teacher).locator('input').fill('TEST-002');
    await modalButton(teacher, 'Create copy').click();
    await teacher.waitForSelector('.view .tag-code:text("TEST-002")');

    await more('Delete');
    await modalButton(teacher, 'Delete').click();
    await teacher.waitForURL(/#\/$/);
    await expectToast(teacher, /deleted/);
    const gone = await teacher.context().request.get(`${base}/api/scan?code=TEST-002`);
    assert.equal(gone.status(), 404);
    assertNoErrors();
  });

  test('attach an accessory by scanning it, then detach it', T, async () => {
    await go(teacher, base, `#/item/${await idOf(teacher, 'CAM-005')}`);
    const section = view(teacher).locator('section', { hasText: 'Attached accessories' });
    await scan(teacher, 'LENS-007', { within: section });
    await teacher.waitForSelector('.view section:has-text("Attached accessories") .tag-code:text("LENS-007")');
    const lensRow = view(teacher).locator('section', { hasText: 'Attached accessories' }).locator('.list-item', { hasText: 'LENS-007' });
    await lensRow.getByRole('button', { name: 'Detach' }).click();
    await teacher.waitForTimeout(600);
    assert.equal(await view(teacher).locator('section', { hasText: 'Attached accessories' }).locator('.tag-code', { hasText: 'LENS-007' }).count(), 0);
    // Scanning a kit label into the attach box is refused with a message.
    await scan(teacher, 'KIT-01', { within: view(teacher).locator('section', { hasText: 'Attached accessories' }) });
    assertNoErrors();
  });

  test('kits: create, scan items in, remove one, rename and delete', T, async () => {
    await go(teacher, base, '#/kits');
    await button(teacher, 'New kit').click();
    await modal(teacher).getByPlaceholder('e.g. KIT-04').fill('KIT-09');
    await modal(teacher).getByPlaceholder('e.g. Canon Doc Kit').fill('Interview Kit');
    await modalButton(teacher, 'Create kit').click();
    await teacher.waitForURL(/#\/kit\/\d+$/);
    await teacher.waitForSelector('.view h1:text("Interview Kit")');
    await scan(teacher, 'MIC-003');
    await scan(teacher, 'TRI-001');
    await teacher.waitForSelector('.view .list .tag-code:text("TRI-001")');
    assert.equal(await view(teacher).locator('.list .list-item').count(), 2);
    await view(teacher).locator('.list-item', { hasText: 'MIC-003' }).getByTitle('Remove from kit').click();
    await teacher.waitForTimeout(500);
    assert.equal(await view(teacher).locator('.list .list-item').count(), 1);
    await button(teacher, 'Edit').click();
    await modal(teacher).getByPlaceholder('e.g. Canon Doc Kit').fill('Tripod Kit');
    await modalButton(teacher, 'Save').click();
    await teacher.waitForSelector('.view h1:text("Tripod Kit")');
    await button(teacher, 'Delete').click();
    await navigate(teacher, () => modalButton(teacher, 'Delete kit').click());
    assert.equal(await view(teacher).locator('.asset-card').count(), 3);
    assertNoErrors();
  });

  test('staff check-out: borrower search, kit scan, suggestions, signature, receipt', T, async () => {
    await go(teacher, base, '#/checkout');
    await view(teacher).getByPlaceholder('Type a name, username or student ID').fill('diego');
    await view(teacher).locator('button.list-item', { hasText: 'Diego Martinez' }).click();
    await teacher.waitForSelector('.view .borrower-card:has-text("Diego Martinez")');

    await scan(teacher, 'NOPE-404');
    await expectToast(teacher, /Nothing matches/);

    await scan(teacher, 'KIT-03');
    await teacher.waitForSelector('.view .cart-group');
    const lines = await view(teacher).locator('.cart-group .tag-code').allInnerTexts();
    assert.deepEqual(lines.sort(), ['BAT-007', 'CAM-004', 'CHG-004', 'KIT-03', 'LENS-006', 'MIC-001', 'SD-003'].sort());
    const attachedLine = view(teacher).locator('.cart-group .list-item.indent');
    assert.match(await attachedLine.innerText(), /attached to CAM-004/);

    // Compatible accessory suggestion for the Sony body: add the Sigma lens, then remove it.
    const sigma = view(teacher).locator('.suggest-strip .asset-card', { hasText: 'LENS-007' });
    await sigma.click();
    await teacher.waitForSelector('.view .cart-group .tag-code:text("LENS-007")');
    await view(teacher).locator('.cart-group', { hasText: 'LENS-007' }).getByTitle('Remove').click();
    await teacher.waitForTimeout(500);
    assert.equal(await view(teacher).locator('.cart-group .tag-code', { hasText: 'LENS-007' }).count(), 0);

    const confirm = teacher.locator('.sticky-actions .btn-primary');
    assert.equal(await teacher.locator('.sigpad').isVisible(), true, 'a $899 camera needs a signature');
    assert.equal(await confirm.isDisabled(), true, 'cannot check out before signing');
    await view(teacher).getByRole('radio', { name: 'Parent' }).click();
    await drawSignature(teacher);
    await teacher.waitForTimeout(200);
    assert.equal(await confirm.isEnabled(), true);
    assert.match(await confirm.innerText(), /Check out 6/);
    await confirm.click();
    await teacher.waitForSelector('.view .success-hero');
    assert.match(await view(teacher).locator('.success-hero').innerText(), /6 items to Diego Martinez[\s\S]*Signed by Diego Martinez \(parent\)/);
    assertNoErrors();
  });

  test('restricted borrower is blocked until staff give an override reason', T, async () => {
    await button(teacher, 'Check out more').click();
    await teacher.waitForSelector('.view input[placeholder="Type a name, username or student ID"]');
    // Scanning a student ID card in the item box picks the borrower.
    await scan(teacher, 'S10235');
    await teacher.waitForSelector('.view .borrower-card:has-text("Jordan Lee")');
    await scan(teacher, 'TRI-003');
    await teacher.waitForSelector('.view .banner.danger');
    assert.match(await view(teacher).locator('.banner.danger').first().innerText(), /Jordan Lee can’t book or check out[\s\S]*LENS-004/);
    const confirm = teacher.locator('.sticky-actions .btn-primary');
    assert.equal(await confirm.isDisabled(), true);
    await view(teacher).getByPlaceholder('e.g. Needed for the final project, parent called').fill('Final exam shoot');
    await teacher.waitForTimeout(900);
    assert.equal(await confirm.isEnabled(), true);
    await confirm.click();
    await teacher.waitForSelector('.view .success-hero');
    const loans = await api(teacher, `/loans?user_id=3`);
    assert.equal(loans.loans.find((l) => l.items.some((i) => i.asset.tag === 'TRI-003')).override_reason, 'Final exam shoot');
    assertNoErrors();
  });

  test('picking up a booking: load it, sign, and the booking is fulfilled', T, async () => {
    await go(teacher, base, '#/checkout');
    await scan(teacher, 'S10237');
    await teacher.waitForSelector('.view .borrower-card:has-text("Alex Kim")');
    await view(teacher).getByRole('button', { name: 'Load booking' }).click();
    await teacher.waitForSelector('.view .cart-group .tag-code:text("BAT-005")');
    assert.match(await view(teacher).locator('.cart-group').first().innerText(), /Picks up your booking/);
    await drawSignature(teacher);
    await teacher.locator('.sticky-actions .btn-primary').click();
    await teacher.waitForSelector('.view .success-hero');
    const bookings = await api(teacher, '/reservations?user_id=5&past=1');
    assert.ok(bookings.reservations.some((r) => r.status === 'fulfilled'));
    assertNoErrors();
  });

  test('return: student ID loads loans; each item confirmed; condition, photo, lost, undo', T, async () => {
    await go(teacher, base, '#/return');
    await scan(teacher, 'S10239');
    await teacher.waitForSelector('.view .return-item');
    assert.equal(await view(teacher).locator('.return-item').count(), 6);
    assert.equal(await view(teacher).locator('.return-item.confirmed').count(), 0, 'loading never confirms items');

    await scan(teacher, 'CAM-004');
    await scan(teacher, 'lens-006'); // tags are case-insensitive
    assert.equal(await view(teacher).locator('.return-item.confirmed').count(), 2);
    await view(teacher).locator('.return-item', { hasText: 'BAT-007' }).getByRole('button', { name: 'Confirm' }).click();
    await view(teacher).locator('.return-item', { hasText: 'SD-003' }).getByRole('button', { name: 'Confirm' }).click();
    assert.equal(await view(teacher).locator('.return-item.confirmed').count(), 4);
    await view(teacher).locator('.return-item', { hasText: 'SD-003' }).getByRole('button', { name: 'Undo' }).click();
    assert.equal(await view(teacher).locator('.return-item.confirmed').count(), 3);

    const submit = teacher.locator('.sticky-actions .btn-primary');
    assert.equal(await submit.isDisabled(), true, 'conditions are required');
    for (const tag of ['CAM-004', 'LENS-006']) {
      await view(teacher).locator('.return-item', { hasText: tag }).getByRole('radio', { name: 'Excellent' }).click();
    }
    const battery = view(teacher).locator('.return-item', { hasText: 'BAT-007' });
    await battery.getByRole('radio', { name: 'Damaged' }).click();
    await battery.locator('input.input').fill('Swollen casing');
    await battery.locator('input[type=file]').setInputFiles(await jpegBuffer(teacher));
    await battery.locator('.photo-preview img').waitFor();

    await view(teacher).locator('.return-item', { hasText: 'MIC-001' }).getByRole('button', { name: 'Lost' }).click();
    await modal(teacher).locator('textarea').fill('Left at the park');
    await modal(teacher).locator('input[type=checkbox]').check();
    await modalButton(teacher, 'Mark lost').click();
    await teacher.waitForSelector('.view .return-item:has-text("MIC-001") :text("Marked lost")');

    assert.match(await submit.innerText(), /Return 3/);
    await submit.click();
    await teacher.waitForSelector('.view .banner:has-text("3 items checked back in")');
    assert.match(await view(teacher).locator('.banner').first().innerText(), /1 damage report recorded[\s\S]*2 items still out/);
    const bat = (await api(teacher, '/scan?code=BAT-007')).asset;
    assert.equal(bat.state, 'repair');
    assert.equal(bat.condition, 'damaged');
    assertNoErrors();
  });

  test('loans: dashboard tabs, loan detail, change due date, jump to return', T, async () => {
    await go(teacher, base, '#/loans');
    assert.equal(await view(teacher).locator('.kpi').count(), 4);
    await navigate(teacher, () => view(teacher).getByRole('tab', { name: 'Overdue' }).click());
    const overdue = await view(teacher).locator('.list-item .title').allInnerTexts();
    assert.ok(overdue.includes('Jordan Lee') && overdue.includes('Sam Rivera'), overdue.join());
    await navigate(teacher, () => view(teacher).locator('.list-item', { hasText: 'Sam Rivera' }).click());
    await button(teacher, 'Change due date').click();
    await modalButton(teacher, 'Save').click();
    await expectToast(teacher, /Due date updated/);
    await teacher.waitForTimeout(400);
    assert.doesNotMatch(await view(teacher).locator('.facts').innerText(), /Overdue/);
    await navigate(teacher, () => view(teacher).getByRole('link', { name: 'Return items' }).click());
    assert.equal(await view(teacher).locator('.return-item').count(), 2);
    assertNoErrors();
  });

  test('bookings: cancel one, book for a student, see availability', T, async () => {
    await go(teacher, base, '#/bookings');
    const priyaCard = view(teacher).locator('section.card', { hasText: 'Priya Shah' });
    await priyaCard.getByRole('button', { name: 'Cancel booking' }).click();
    await modalButton(teacher, 'Cancel booking').click();
    await teacher.waitForSelector('.view section.card:has-text("Priya Shah") .badge:text("Cancelled")');

    await navigate(teacher, () => view(teacher).getByRole('link', { name: 'Book gear' }).first().click());
    await view(teacher).getByPlaceholder('Type a name, username or student ID').fill('maya');
    await view(teacher).locator('button.list-item', { hasText: 'Maya Patel' }).click();
    await teacher.waitForTimeout(600);
    // Unavailable items are dimmed with a reason.
    const lost = view(teacher).locator('.asset-card', { hasText: 'SD-006' });
    assert.equal(await lost.count(), 0, 'lost items are not offered');
    const out = view(teacher).locator('.asset-card', { hasText: 'LENS-004' });
    assert.match(await out.innerText(), /Not free/);
    await view(teacher).locator('.asset-card', { hasText: 'CAM-001' }).click();
    await teacher.waitForSelector('.view .card:has-text("Works with Canon EOS Rebel T7i")');
    await view(teacher).locator('.suggest-strip .asset-card', { hasText: 'LENS-003' }).click();
    assert.match(await view(teacher).locator('.chips').first().innerText(), /CAM-001[\s\S]*LENS-003/);
    await teacher.locator('.sticky-actions .btn-primary').click();
    await teacher.waitForURL(/#\/bookings$/);
    await teacher.waitForSelector('.view section.card:has-text("Maya Patel")');
    assertNoErrors();
  });

  test('shelf audit: found / missing / unexpected, undo, finish and summary', T, async () => {
    await go(teacher, base, '#/audit');
    await view(teacher).locator('select').selectOption('Cabinet B');
    await button(teacher, 'Start audit').click();
    await teacher.waitForSelector('.view .audit-progress');
    const expected = Number((await view(teacher).locator('.card .row .bold').first().innerText()).match(/of (\d+)/)[1]);
    assert.ok(expected > 3);
    await scan(teacher, 'LENS-007');
    assert.match(await view(teacher).locator('.last-scan').innerText(), /Found/);
    await scan(teacher, 'CAM-005');
    await scan(teacher, 'CAM-001'); // lives in Cabinet A
    assert.match(await view(teacher).locator('.last-scan').innerText(), /Belongs in Cabinet A/);
    await scan(teacher, 'NOT-A-TAG');
    assert.match(await view(teacher).locator('.last-scan').innerText(), /Unknown tag/);
    assert.match(await view(teacher).locator('.card .row').first().innerText(), new RegExp(`2 of ${expected} found`));
    await view(teacher).getByRole('tab', { name: /Found/ }).click();
    await view(teacher).locator('.list-item', { hasText: 'CAM-005' }).getByTitle('Undo scan').click();
    await teacher.waitForTimeout(400);
    assert.match(await view(teacher).locator('.card .row').first().innerText(), new RegExp(`1 of ${expected} found`));

    await button(teacher, 'Finish').click();
    await modal(teacher).locator('label', { hasText: 'as lost' }).locator('input').check();
    await modalButton(teacher, 'Finish audit').click();
    await teacher.waitForSelector('.view h1:text("Audit: Cabinet B")');
    const kpis = await view(teacher).locator('.kpi .v').allInnerTexts();
    assert.deepEqual(kpis.map(Number), [expected, 1, expected - 1, 1]);
    assert.equal((await api(teacher, '/scan?code=CAM-005')).asset.state, 'lost');

    // A second audit can be thrown away before it is finished.
    await go(teacher, base, '#/audit');
    await button(teacher, 'Start audit').click();
    await teacher.waitForSelector('.view .audit-progress');
    await button(teacher, 'Discard this audit').click();
    await modalButton(teacher, 'Discard').click();
    await teacher.waitForURL(/#\/audit$/);
    assert.equal(await view(teacher).locator('section', { hasText: 'In progress' }).count(), 0);
    assertNoErrors();
  });

  test('loss & damage report: ranges, tooltip, table view, CSV download', T, async () => {
    await go(teacher, base, '#/reports');
    assert.equal(await view(teacher).locator('.kpi').count(), 4);
    const lost = Number(await view(teacher).locator('.kpi .v').first().innerText());
    assert.ok(lost >= 4, `lost count ${lost}`);
    await view(teacher).locator('.hbar .seg').first().hover();
    await teacher.waitForSelector('.chart-tip:not([hidden])');
    assert.match(await teacher.locator('.chart-tip').innerText(), /Lost[\s\S]*Damaged/);
    await view(teacher).locator('summary', { hasText: 'Show as a table' }).click();
    assert.ok(await view(teacher).locator('details[open] tbody tr').count() >= 12);
    await view(teacher).getByRole('link', { name: 'Last 30 days' }).click();
    await teacher.waitForSelector('.view .chip.on:text("Last 30 days")');
    const href = await view(teacher).getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    const csv = await teacher.context().request.get(`${base}${href}`);
    assert.equal(csv.status(), 200);
    assert.match(csv.headers()['content-type'], /text\/csv/);
    assert.match(await csv.text(), /^Date,Type,Tag,Item/);
    assertNoErrors();
  });

  test('people: filters, add, import, restrict, reset password, fines', T, async () => {
    await go(teacher, base, '#/people');
    await navigate(teacher, () => view(teacher).getByRole('link', { name: 'Restricted', exact: true }).click());
    assert.deepEqual(await view(teacher).locator('.list-item .title').allInnerTexts(), ['Jordan Lee']);
    await navigate(teacher, () => view(teacher).getByRole('link', { name: 'Everyone', exact: true }).click());
    await view(teacher).getByPlaceholder('Search by name or ID').fill('S1023');
    await teacher.waitForTimeout(300);
    assert.ok(await view(teacher).locator('.list-item').count() >= 5);

    await button(teacher, 'Add person').click();
    await modal(teacher).getByPlaceholder('Full name').fill('Robin Ortiz');
    await modal(teacher).getByPlaceholder('e.g. mpatel').fill('rortiz');
    await modal(teacher).getByPlaceholder('Number on their ID card').fill('S20001');
    await modalButton(teacher, 'Add').click();
    await modal(teacher).locator('code').waitFor();
    const tempPassword = await modal(teacher).locator('code').innerText();
    assert.match(tempPassword, /^\w+-\d{4}-\w+$/);
    await modalButton(teacher, 'Close').click();
    process.env.E2E_ROBIN_PASSWORD = tempPassword;

    await button(teacher, 'Import CSV').click();
    await modal(teacher).locator('textarea').first().fill('name,username,student_id\nAda Lovelace,ada,S20002\nBroken Row,,\n');
    await modalButton(teacher, 'Import').click();
    await modal(teacher).locator('.banner').waitFor();
    assert.match(await modal(teacher).locator('.banner').innerText(), /Added 1 person[\s\S]*Line 3/);
    assert.match(await modal(teacher).locator('textarea[readonly]').inputValue(), /ada,/);
    await modalButton(teacher, 'Close').click();

    // Diego's lost mic carries a replacement fine from the return test.
    await go(teacher, base, '#/people/7');
    const fine = view(teacher).locator('section', { hasText: 'Fines' });
    assert.match(await fine.innerText(), /\$99[\s\S]*Replacement cost/);
    await fine.getByRole('button', { name: 'Paid' }).click();
    await teacher.waitForSelector('.view section:has-text("Fines") .badge:text("paid")');
    await view(teacher).locator('section', { hasText: 'Fines' }).getByRole('button', { name: 'Undo' }).click();
    await view(teacher).locator('section', { hasText: 'Fines' }).getByRole('button', { name: 'Waive' }).click();
    await teacher.waitForSelector('.view section:has-text("Fines") .badge:text("waived")');

    await button(teacher, 'Restrict').click();
    await modal(teacher).getByPlaceholder('Reason (shown to the student)').fill('Broke lab rules');
    await modalButton(teacher, 'Restrict').click();
    await teacher.waitForSelector('.view .banner.danger:has-text("Broke lab rules")');
    await button(teacher, 'Lift restriction').click();
    await teacher.waitForTimeout(600);
    assert.equal(await view(teacher).locator('.banner.danger').count(), 0);

    await button(teacher, 'Reset password').click();
    await teacher.waitForSelector('.view .banner.success code');
    await button(teacher, 'Deactivate').click();
    await teacher.waitForSelector('.view button:has-text("Reactivate")');
    await button(teacher, 'Reactivate').click();
    await teacher.waitForSelector('.view button:has-text("Deactivate")');
    assertNoErrors();
  });

  test('settings: validation, saving, categories', T, async () => {
    await go(teacher, base, '#/settings');
    const grace = view(teacher).locator('label.field', { hasText: 'Grace period' }).locator('input');
    await grace.fill('-5');
    await button(teacher, 'Save settings').click();
    await teacher.waitForSelector('.view .banner.danger');
    await grace.fill('24');
    await view(teacher).locator('label.field', { hasText: 'Program name' }).locator('input').fill('MVHS Media Lab');
    await view(teacher).locator('label.field', { hasText: 'Late fine per day' }).locator('input').fill('0.50');
    await button(teacher, 'Save settings').click();
    await expectToast(teacher, /Settings saved/);
    await teacher.waitForSelector('.brand:has-text("MVHS Media Lab")');
    const s = (await api(teacher, '/settings')).settings;
    assert.equal(s.fine_per_day_cents, 50);

    await view(teacher).getByPlaceholder('New category, e.g. Drone').fill('Drone');
    await view(teacher).locator('.row', { has: teacher.getByPlaceholder('New category, e.g. Drone') }).getByRole('button', { name: 'Add' }).click();
    await teacher.waitForSelector('.view td:text("Drone")');
    await view(teacher).getByTitle('Delete Drone').click();
    await modalButton(teacher, 'Delete').click();
    await teacher.waitForTimeout(500);
    assert.equal(await view(teacher).locator('td', { hasText: /^Drone$/ }).count(), 0);
    await view(teacher).getByTitle('Delete Lens').click();
    await modalButton(teacher, 'Delete').click();
    await expectToast(teacher, /Move them to another category first/);
    await view(teacher).locator('label.field', { hasText: 'Late fine per day' }).locator('input').fill('0');
    await button(teacher, 'Save settings').click();
    assertNoErrors();
  });

  test('labels: preset from an item, filter, select, print', T, async () => {
    await go(teacher, base, '#/labels?tags=CAM-001,KIT-01');
    assert.equal(await view(teacher).locator('.asset-label').count(), 2);
    await view(teacher).locator('select').selectOption('Kits');
    await button(teacher, 'Select shown').click();
    assert.equal(await view(teacher).locator('.asset-label').count(), 4);
    const img = view(teacher).locator('.asset-label img').first();
    await img.evaluate((el) => (el.complete ? null : new Promise((r) => { el.onload = r; })));
    assert.ok(await img.evaluate((el) => el.naturalWidth > 0), 'QR image loaded');
    await button(teacher, 'Clear').click();
    assert.equal(await view(teacher).locator('.asset-label').count(), 0);
    await teacher.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await button(teacher, 'Print').click();
    assert.equal(await teacher.evaluate(() => window.__printed), true);
    assertNoErrors();
  });

  test('student on a phone: nav, My gear, self check-out and return, booking', T, async () => {
    const maya = await signIn(browser, base, 'maya', 'demo1234', { viewport: { width: 390, height: 844 }, sink: errors, contextOptions: { hasTouch: true, isMobile: true } });
    const nav = await maya.locator('.bottomnav a').allInnerTexts();
    assert.deepEqual(nav.map((t) => t.trim()), ['Equipment', 'Bookings', 'Check out', 'My gear', 'More']);
    assert.equal(await maya.locator('.sidebar').isVisible(), false);
    // Students do not see staff-only data.
    assert.equal(await maya.locator('.view .asset-card .extra:has-text("Jordan")').count(), 0);

    await maya.locator('.bottomnav a', { hasText: 'My gear' }).click();
    await maya.waitForSelector('.view h1:text("My gear")');
    assert.match(await view(maya).locator('section', { hasText: 'Checked out to you' }).innerText(), /CAM-002[\s\S]*Due/);

    await go(maya, base, '#/checkout');
    await scan(maya, 'TRI-001');
    await maya.waitForSelector('.view .cart-group');
    assert.equal(await maya.locator('.sigpad').isVisible(), false, 'a $69 tripod needs no signature');
    await maya.locator('.sticky-actions .btn-primary').click();
    await maya.waitForSelector('.view .success-hero');

    await maya.locator('.bottomnav a', { hasText: 'More' }).click();
    await modal(maya).getByRole('link', { name: 'Return' }).click();
    await maya.waitForSelector('.view .return-item');
    assert.ok(await view(maya).locator('.return-item').count() >= 7, 'her open loans are preloaded');
    await scan(maya, 'TRI-001');
    await view(maya).locator('.return-item.confirmed').getByRole('radio', { name: 'Fair' }).click();
    await maya.locator('.sticky-actions .btn-primary').click();
    await maya.waitForSelector('.view .banner:has-text("1 item checked back in")');

    // Students cannot return someone else's gear.
    await scan(maya, 'LENS-004');
    await expectToast(maya, /checked out to someone else/);

    await go(maya, base, '#/bookings/new');
    await view(maya).locator('.asset-card', { hasText: 'CAM-001' }).click();
    await maya.waitForSelector('.view .card:has-text("Works with Canon EOS Rebel T7i")');
    await view(maya).getByRole('tab', { name: /Kits/ }).click();
    await view(maya).locator('.asset-card', { hasText: 'KIT-01' }).click();
    await maya.locator('.sticky-actions .btn-primary').click();
    await maya.waitForURL(/#\/bookings$/);
    const card = view(maya).locator('section.card').first();
    assert.match(await card.innerText(), /Canon EOS Rebel T7i/);
    await card.getByRole('button', { name: 'Cancel booking' }).click();
    await modalButton(maya, 'Cancel booking').click();
    await maya.waitForTimeout(600);
    await maya.context().close();
    assertNoErrors();
  });

  test('restricted student sees why and cannot book', T, async () => {
    const jordan = await signIn(browser, base, 'jordan', 'demo1234', { viewport: { width: 390, height: 844 }, sink: errors });
    assert.match(await view(jordan).locator('.banner.danger').innerText(), /can’t book or check out[\s\S]*LENS-004/);
    await go(jordan, base, '#/bookings/new');
    await view(jordan).locator('.asset-card', { hasText: 'TRI-001' }).click();
    await jordan.locator('.sticky-actions .btn-primary').click();
    await expectToast(jordan, /restricted/);
    await jordan.context().close();
    assertNoErrors();
  });

  test('turning off self-service hides check-out for students', T, async () => {
    await jsonPatch(teacher, '/settings', { allow_student_self_checkout: false });
    const sam = await signIn(browser, base, 'sam', 'demo1234', { sink: errors });
    assert.equal(await sam.locator('.sidebar a', { hasText: 'Check out' }).count(), 0);
    await go(sam, base, '#/checkout');
    assert.match(await view(sam).locator('.banner').innerText(), /Self check-out is turned off/);
    await sam.context().close();
    await jsonPatch(teacher, '/settings', { allow_student_self_checkout: true });
    assertNoErrors();
  });

  test('new person must choose a password before using the app', T, async () => {
    const robin = await signIn(browser, base, 'rortiz', process.env.E2E_ROBIN_PASSWORD, { sink: errors });
    assert.match(robin.url(), /#\/account$/);
    assert.match(await view(robin).locator('.banner.warning').innerText(), /choose your own password/);
    await robin.goto(`${base}/#/`);
    await robin.waitForURL(/#\/account$/);
    const inputs = view(robin).locator('input[type=password]');
    await inputs.nth(0).fill(process.env.E2E_ROBIN_PASSWORD);
    await inputs.nth(1).fill('robin-new-pass');
    await inputs.nth(2).fill('robin-typo-pass');
    await view(robin).getByRole('button', { name: 'Change password' }).click();
    await robin.waitForSelector('.view .banner.danger:has-text("don’t match")');
    await inputs.nth(2).fill('robin-new-pass');
    await view(robin).getByRole('button', { name: 'Change password' }).click();
    await robin.waitForSelector('.view h1:text("Equipment")');

    await robin.locator('.sidebar a', { hasText: 'Sign out' }).click();
    await robin.waitForSelector('input[name=username]');
    await robin.fill('input[name=username]', 'S20001'); // the student ID on their card works too
    await robin.fill('input[name=password]', 'robin-new-pass');
    await robin.click('button[type=submit]');
    await robin.waitForSelector('.view h1:text("Equipment")');
    await robin.context().close();
    assertNoErrors();
  });

  test('an expired session returns to the sign-in screen with a message', T, async () => {
    const page = await signIn(browser, base, 'alex', 'demo1234', { sink: errors });
    await page.context().clearCookies();
    await page.locator('.sidebar a', { hasText: 'Bookings' }).click();
    await page.waitForSelector('input[name=username]');
    await expectToast(page, /session ended/);
    await page.context().close();
    assertNoErrors();
  });

  test('every page fits a small phone screen without sideways scrolling', T, async () => {
    const small = await signIn(browser, base, 'teacher', 'demo1234', { viewport: { width: 360, height: 740 }, sink: errors });
    const cam = await idOf(small, 'CAM-001');
    const pages = ['#/', '#/?tab=kits', `#/item/${cam}`, '#/item/new', '#/kits', '#/kit/1', '#/checkout', '#/return', '#/loans',
      '#/loan/1', '#/bookings', '#/bookings/new', '#/audit', '#/reports', '#/people', '#/people/3', '#/settings', '#/labels', '#/account'];
    const overflowing = [];
    for (const hash of pages) {
      await go(small, base, hash);
      const { scrollWidth, innerWidth } = await small.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      if (scrollWidth > innerWidth + 1) overflowing.push(`${hash} (${scrollWidth}px)`);
    }
    assert.deepEqual(overflowing, []);
    await small.context().close();
    assertNoErrors();
  });
});

async function jsonPatch(page, path, body) {
  const res = await page.context().request.patch(`${base}/api${path}`, { data: body });
  assert.equal(res.status(), 200);
}
