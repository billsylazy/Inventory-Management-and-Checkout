// Camera scanning tests. Chromium is given a fake webcam that shows a printed
// label (a QR code like the app's own labels, or a Code 128 barcode), and the
// tests check that pointing the in-app scanner at it really works.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  code128Video, fakeCameraArgs, go, launch, qrVideo, settle, signIn, startServer,
} from './harness.mjs';

const T = { timeout: 90_000 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-camera-'));
const errors = [];
const view = (page) => page.locator('.view');

async function openCamera(page, within = view(page)) {
  await within.locator('.scan-field .btn-primary').first().click();
  await page.waitForSelector('.scanner-overlay');
}

async function waitForScanResult(page) {
  const result = page.locator('.scanner-result.ok, .scanner-result.err');
  await result.waitFor({ timeout: 20_000 });
  return { ok: await result.evaluate((el) => el.classList.contains('ok')), text: await result.innerText() };
}

function lanAddress() {
  return Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
}

describe('in-app camera scanner', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a student checks out by pointing the phone camera at a QR label', T, async () => {
    const browser = await launch(fakeCameraArgs(qrVideo('LGT-002', path.join(tmp, 'qr.y4m'))));
    try {
      const page = await signIn(browser, server.base, 'maya', 'demo1234', {
        viewport: { width: 390, height: 844 }, sink: errors, contextOptions: { permissions: ['camera'] },
      });
      await go(page, server.base, '#/checkout');
      await openCamera(page);
      const result = await waitForScanResult(page);
      assert.equal(result.ok, true, result.text);
      assert.match(result.text, /Added LGT-002/);
      // Continuous mode: the same label staying in view is not added twice.
      await page.waitForTimeout(1500);
      await page.locator('.scanner-overlay').getByRole('button', { name: 'Done' }).click();
      await page.waitForSelector('.scanner-overlay', { state: 'detached' });
      assert.deepEqual(await view(page).locator('.cart-group .tag-code').allInnerTexts(), ['LGT-002']);
      // The camera is released when the scanner closes.
      const live = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject?.active).length);
      assert.equal(live, 0);
      await page.locator('.sticky-actions .btn-primary').click();
      await page.waitForSelector('.view .success-hero');
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors.splice(0), []);
  });

  test('a single-scan field (new item tag) fills in and closes by itself', T, async () => {
    const browser = await launch(fakeCameraArgs(qrVideo('NEW-777', path.join(tmp, 'qr2.y4m'))));
    try {
      const page = await signIn(browser, server.base, 'teacher', 'demo1234', { sink: errors, contextOptions: { permissions: ['camera'] } });
      await go(page, server.base, '#/item/new');
      await view(page).getByTitle('Scan an existing label').click();
      await page.waitForSelector('.scanner-overlay');
      await page.waitForSelector('.scanner-overlay', { state: 'detached', timeout: 20_000 });
      assert.equal(await view(page).locator('input[name=tag]').inputValue(), 'NEW-777');
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors.splice(0), []);
  });

  test('Code 128 barcodes work too — shelf audit with the camera', T, async () => {
    const browser = await launch(fakeCameraArgs(code128Video('TRI-001', path.join(tmp, 'c128.y4m'))));
    try {
      const page = await signIn(browser, server.base, 'teacher', 'demo1234', { sink: errors, contextOptions: { permissions: ['camera'] } });
      await go(page, server.base, '#/audit');
      await view(page).locator('select').selectOption('Shelf C');
      await view(page).getByRole('button', { name: 'Start audit' }).click();
      await settle(page);
      await page.waitForSelector('.view .audit-progress');
      await openCamera(page);
      const result = await waitForScanResult(page);
      assert.equal(result.ok, true, result.text);
      assert.match(result.text, /TRI-001: found/);
      await page.locator('.scanner-overlay').getByRole('button', { name: 'Done' }).click();
      assert.match(await view(page).locator('.last-scan').innerText(), /TRI-001/);
      assert.match(await view(page).locator('.card .row').first().innerText(), /^1 of/);
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors.splice(0), []);
  });

  test('scanning a tag that does not exist shows a red result and keeps the camera open', T, async () => {
    const browser = await launch(fakeCameraArgs(qrVideo('NO-SUCH-TAG', path.join(tmp, 'qr3.y4m'))));
    try {
      const page = await signIn(browser, server.base, 'maya', 'demo1234', { sink: errors, contextOptions: { permissions: ['camera'] } });
      await go(page, server.base, '#/checkout');
      await openCamera(page);
      const result = await waitForScanResult(page);
      assert.equal(result.ok, false);
      assert.match(result.text, /Nothing matches "NO-SUCH-TAG"/);
      assert.equal(await page.locator('.scanner-overlay').count(), 1);
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors.splice(0), []);
  });
});

describe('camera over the school network', () => {
  test('works over HTTPS with the self-signed certificate (npm run start:https)', T, async () => {
    const server = await startServer({ https: true });
    const browser = await launch(fakeCameraArgs(qrVideo('BAG-003', path.join(os.tmpdir(), `qr-https-${process.pid}.y4m`))));
    try {
      const page = await signIn(browser, server.httpsBase, 'maya', 'demo1234', {
        sink: errors, contextOptions: { permissions: ['camera'], ignoreHTTPSErrors: true },
      });
      assert.equal(await page.evaluate(() => window.isSecureContext), true);
      await go(page, server.httpsBase, '#/checkout');
      await openCamera(page);
      const result = await waitForScanResult(page);
      assert.equal(result.ok, true, result.text);
      assert.match(result.text, /Added BAG-003/);
    } finally {
      await browser.close();
      await server.stop();
    }
    assert.deepEqual(errors.splice(0), []);
  });

  test('over plain HTTP from another device it explains that HTTPS is needed', T, async (t) => {
    const ip = lanAddress();
    if (!ip) return t.skip('no network interface to test with');
    const server = await startServer({ host: '0.0.0.0' });
    const browser = await launch(fakeCameraArgs(qrVideo('BAG-003', path.join(os.tmpdir(), `qr-http-${process.pid}.y4m`))));
    try {
      const base = `http://${ip}:${server.port}`;
      const page = await signIn(browser, base, 'maya', 'demo1234', { sink: errors, contextOptions: { permissions: ['camera'] } });
      assert.equal(await page.evaluate(() => window.isSecureContext), false);
      await go(page, base, '#/checkout');
      await openCamera(page);
      assert.match(await page.locator('.scanner-overlay').innerText(), /secure \(https:\/\/\) connection/);
      await page.locator('.scanner-overlay').getByRole('button', { name: 'Done' }).click();
      // Typing / USB scanners still work without HTTPS.
      const input = view(page).locator('.scan-field input');
      await input.fill('BAG-003');
      await input.press('Enter');
      await page.waitForSelector('.view .cart-group .tag-code:text("BAG-003")');
    } finally {
      await browser.close();
      await server.stop();
    }
    assert.deepEqual(errors.splice(0), []);
  });
});
