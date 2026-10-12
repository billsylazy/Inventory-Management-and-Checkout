import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, createContext, ensureAdmin } from './app.js';
import { seedDemo } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const env = process.env;

const dataDir = path.resolve(env.DATA_DIR ?? path.join(ROOT, 'data'));
const dbPath = path.resolve(env.DB_PATH ?? path.join(dataDir, demo ? 'demo.db' : 'inventory.db'));
const uploadsDir = path.resolve(env.UPLOADS_DIR ?? path.join(dataDir, demo ? 'demo-uploads' : 'uploads'));
const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? '0.0.0.0';

const ctx = createContext({ dbPath, uploadsDir });
const app = createApp(ctx, { trustProxy: env.TRUST_PROXY ?? 'loopback' });

if (demo) {
  const seeded = seedDemo(ctx);
  if (seeded) {
    console.log('\n  Demo data loaded. Sign in with:');
    console.log('    Teacher/admin: teacher / demo1234');
    console.log('    Student:       maya / demo1234   (also: jordan, sam, alex)\n');
  }
} else {
  const admin = ensureAdmin(ctx, { password: env.ADMIN_PASSWORD });
  if (admin) {
    console.log('\n  Created the first admin account:');
    console.log(`    username: ${admin.username}`);
    console.log(`    password: ${admin.password}${env.ADMIN_PASSWORD ? '' : '   (you will be asked to change it)'}\n`);
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

http.createServer(app).listen(port, host, () => {
  console.log(`  Inventory app running at http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`    on your network: http://${ip}:${port}`);
});

// Phone cameras only work on secure (https) pages, except on localhost.
// HTTPS=1 serves a second port with a self-signed certificate (or your own
// via TLS_CERT / TLS_KEY) so phones on the school Wi-Fi can scan barcodes.
if (env.HTTPS === '1' || env.TLS_CERT) {
  const httpsPort = Number(env.HTTPS_PORT ?? 3443);
  let key;
  let cert;
  if (env.TLS_CERT && env.TLS_KEY) {
    cert = fs.readFileSync(env.TLS_CERT);
    key = fs.readFileSync(env.TLS_KEY);
  } else {
    const certFile = path.join(dataDir, 'selfsigned-cert.pem');
    const keyFile = path.join(dataDir, 'selfsigned-key.pem');
    if (!fs.existsSync(certFile)) {
      const { generate } = await import('selfsigned');
      const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map((ip) => ({ type: 7, ip }))];
      const notAfter = new Date();
      notAfter.setFullYear(notAfter.getFullYear() + 2);
      const pems = await generate([{ name: 'commonName', value: 'Inventory App' }], {
        keySize: 2048,
        notAfterDate: notAfter,
        extensions: [{ name: 'subjectAltName', altNames }],
      });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(certFile, pems.cert);
      fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    }
    cert = fs.readFileSync(certFile);
    key = fs.readFileSync(keyFile);
  }
  https.createServer({ key, cert }, app).listen(httpsPort, host, () => {
    console.log(`  HTTPS (for phone cameras) at https://localhost:${httpsPort}`);
    for (const ip of lanAddresses()) console.log(`    on your network: https://${ip}:${httpsPort}`);
    if (!env.TLS_CERT) console.log('    (self-signed certificate: tap "Advanced" > "Proceed" the first time)');
  });
}
