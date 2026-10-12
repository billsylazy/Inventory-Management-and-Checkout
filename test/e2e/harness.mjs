// Shared helpers for the browser (end-to-end) tests.
//
// Each run starts its own server on a free port with a fresh demo database in
// a temp folder, so tests never touch your real data.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Starts `server/index.js --demo` (optionally with --https). */
export async function startServer({ https = false, host = '127.0.0.1' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-e2e-'));
  const port = await freePort();
  const httpsPort = https ? await freePort() : null;
  const args = ['--disable-warning=ExperimentalWarning', 'server/index.js', '--demo'];
  if (https) args.push('--https');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: host, HTTPS_PORT: String(httpsPort ?? '') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 20000);
    const check = setInterval(() => {
      const ready = https ? /HTTPS \(for phone cameras\)/.test(output) : /running at/.test(output);
      if (ready) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}):\n${output}`));
    });
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    httpsBase: httpsPort ? `https://127.0.0.1:${httpsPort}` : null,
    output: () => output,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function launch(extraArgs = []) {
  return chromium.launch({ args: extraArgs, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
}

/**
 * Collects anything that indicates a real problem: uncaught page errors,
 * console errors other than expected 4xx responses, and any 5xx response.
 */
export function trackErrors(page, label, sink) {
  page.on('pageerror', (err) => sink.push(`[${label}] page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(msg.text())) return;
    sink.push(`[${label}] console error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) sink.push(`[${label}] HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
  });
}

export async function signIn(browser, base, username, password = 'demo1234', { viewport = { width: 1280, height: 900 }, sink, contextOptions = {} } = {}) {
  const context = await browser.newContext({ viewport, ...contextOptions });
  const page = await context.newPage();
  if (sink) trackErrors(page, username, sink);
  await page.goto(`${base}/`);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await settle(page);
  return page;
}

/** Types a code into the first scan box and presses Enter (like a USB scanner). */
export async function scan(page, code, { within = page } = {}) {
  const input = within.locator('.scan-field input').first();
  await input.fill(code);
  await input.press('Enter');
  await page.waitForTimeout(350);
}

let navCounter = 0;
/** Loads a screen with a full page load (a bare hash change to the same URL would not re-render). */
export async function go(page, base, hash) {
  navCounter += 1;
  await page.goto(`${base}/?n=${navCounter}${hash}`);
  await settle(page);
}

/** Waits until the current screen has finished loading its data. */
export async function settle(page) {
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.state));
  await page.waitForLoadState('networkidle');
}

/**
 * Runs an action that changes screens (clicking a link or tab) and waits for
 * the new screen to finish rendering.
 */
export async function navigate(page, action) {
  const before = await page.evaluate(() => Number(document.documentElement.dataset.renders || 0));
  await action();
  await page.waitForFunction(
    (b) => Number(document.documentElement.dataset.renders || 0) > b && ['ready', 'error'].includes(document.documentElement.dataset.state),
    before,
  );
  await page.waitForLoadState('networkidle');
}

export async function drawSignature(page) {
  const canvas = page.locator('.sigpad canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 90);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) await page.mouse.move(box.x + 20 + i * 9, box.y + 90 + Math.sin(i / 2) * 25);
  await page.mouse.up();
}

/** A small JPEG made in the browser, for photo uploads. */
export async function jpegBuffer(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 90;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d33';
    ctx.fillRect(0, 0, 120, 90);
    ctx.fillStyle = '#fff';
    ctx.fillRect(30, 20, 60, 50);
    return c.toDataURL('image/jpeg', 0.9);
  });
  return { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
}

/** Waits for a toast message matching `pattern` and returns its text. */
export async function expectToast(page, pattern) {
  const toast = page.locator('.toast', { hasText: pattern }).last();
  await toast.waitFor({ timeout: 6000 });
  return toast.innerText();
}

// ---------------------------------------------------------------------------
// Fake webcam videos. Chromium can use a Y4M file as its camera
// (--use-file-for-fake-video-capture), which lets the tests exercise real
// camera scanning without a camera.

const W = 640;
const H = 480;

function writeY4m(file, luma) {
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma, chroma]);
  fs.writeFileSync(file, Buffer.concat([header, frame, frame]));
  return file;
}

/** A frame showing a QR code for `text` (like the labels the app prints). */
export function qrVideo(text, file) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  const scale = Math.floor(Math.min(W, H) * 0.6 / (size + quiet * 2));
  const total = (size + quiet * 2) * scale;
  const x0 = Math.floor((W - total) / 2);
  const y0 = Math.floor((H - total) / 2);
  const luma = Buffer.alloc(W * H, 200); // light grey "desk"
  for (let y = 0; y < total; y++) {
    for (let x = 0; x < total; x++) {
      const r = Math.floor(y / scale) - quiet;
      const c = Math.floor(x / scale) - quiet;
      const dark = r >= 0 && c >= 0 && r < size && c < size && qr.modules.get(r, c);
      luma[(y0 + y) * W + (x0 + x)] = dark ? 16 : 235;
    }
  }
  return writeY4m(file, luma);
}

// Code 128 symbol patterns (1 = bar, 0 = space), from JsBarcode (MIT).
const CODE128 = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100',
  '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100',
  '10011101100', '10011100110', '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010', '11011011000', '11011000110',
  '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010', '10100110000',
  '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100',
  '11110010010', '11011011110', '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100',
  '11010010000', '11010011100', '1100011101011',
];

/** A frame showing a Code 128 (set B) barcode, as found on many existing asset stickers. */
export function code128Video(text, file) {
  const values = [...text].map((ch) => ch.charCodeAt(0) - 32);
  const checksum = (104 + values.reduce((sum, v, i) => sum + v * (i + 1), 0)) % 103;
  const bits = ['0'.repeat(10), CODE128[104], ...values.map((v) => CODE128[v]), CODE128[checksum], CODE128[106], '0'.repeat(10)].join('');
  const scale = Math.floor((W * 0.7) / bits.length);
  const width = bits.length * scale;
  const x0 = Math.floor((W - width) / 2);
  const top = Math.floor(H * 0.3);
  const bottom = Math.floor(H * 0.7);
  const luma = Buffer.alloc(W * H, 200);
  for (let y = top - 20; y < bottom + 20; y++) {
    for (let x = x0; x < x0 + width; x++) luma[y * W + x] = 235; // white label
  }
  for (let y = top; y < bottom; y++) {
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== '1') continue;
      for (let k = 0; k < scale; k++) luma[y * W + x0 + i * scale + k] = 16;
    }
  }
  return writeY4m(file, luma);
}

export function fakeCameraArgs(videoFile) {
  return ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoFile}`];
}
