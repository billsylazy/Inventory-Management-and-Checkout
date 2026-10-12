# Inventory Management and Checkout

A web app for running a school media lab's equipment room: cameras, lenses, batteries, chargers, SD cards, tripods, mics and lights. Students and teachers use it from a phone or a Chromebook to check gear out and back in by scanning barcode/QR labels. Staff see what's out, what's overdue, and what keeps getting lost or broken.

It runs on Node.js with the built-in SQLite database, so there is nothing to compile and no separate database server.

## Quick start

You need **Node.js 22.13 or newer** (`node --version`).

```bash
npm install
npm run demo        # loads sample gear, kits, students and a few months of history
```

Open http://localhost:3000 and sign in:

| Who | Username | Password |
|---|---|---|
| Teacher / admin | `teacher` | `demo1234` |
| Student | `maya` (also `jordan`, `sam`, `alex`, `priya`, `diego`) | `demo1234` |

Jordan has an overdue lens, so he shows the restriction rules in action. Sam is a few hours late and still inside the grace period.

For real use, start with an empty database:

```bash
npm start
```

On first run the app creates an `admin` account and prints a one-time password in the terminal. You'll be asked to change it when you sign in. You can set `ADMIN_PASSWORD=...` instead to choose it yourself. Data is stored in `data/` (database and uploaded photos); back that folder up.

### Using phone cameras on the school network

Browsers only allow the camera on secure (`https://`) pages, or on `localhost`. To scan with phones over Wi-Fi, start the server with HTTPS:

```bash
npm run start:https          # or: npm run demo:https
```

The terminal prints an `https://<your-ip>:3443` address. The first time, phones show a certificate warning for the self-signed certificate; choose "Advanced → Proceed". To use a real certificate instead, set `TLS_CERT` and `TLS_KEY` to the file paths. Hosting behind any HTTPS service (Render, Railway, a school server with a certificate) also works; set `TRUST_PROXY=1` there.

USB and Bluetooth barcode scanners work everywhere with no setup: they type the code into the scan box and press Enter.

## Features

| Requested feature | Where it lives |
|---|---|
| **Parent-child asset linking** | On an item's page, *Attached accessories* lets staff scan a lens onto a camera body (or use *More → Attach to…*). Attached items go out and come back with their parent, but each keeps its own tag and its own tracking history. Loops are blocked. |
| **Kits** (one scan out, item-by-item return) | *Kits* page: create a kit with its own label, then scan items into it. At check-out, scanning the kit label adds every item plus anything attached to them. Members that are in repair or already out are left behind with a warning. At return, scanning the kit only loads the loan; **every item must be scanned or confirmed individually**, and anything not confirmed stays checked out. |
| **Compatible accessories** | Items carry compatibility tags such as `mount:EF`, `battery:LP-E17`, `media:SD`, or `universal`. Picking a camera body shows *Compatible accessories* on its page, offers a *Compatible gear* filter on the grid, and suggests free, compatible lenses, batteries and cards in check-out and booking. Category type (*main item* or *accessory*) is set in Settings. |
| **In-app barcode/QR scanner** | Every scan box has a camera button (QR, Code 128/39/93, EAN/UPC, Codabar, ITF, Data Matrix), with a beep and vibration on each scan. It uses the browser's native `BarcodeDetector` when available. *Print labels* generates QR stickers for items and kits. |
| **Visual thumbnail grid** | The *Equipment* home screen is a photo grid grouped by category, with search and filters. Staff can snap a product photo from their phone; items without one get a clear category illustration. Descriptions let you tell students what a thing is for. |
| **Real-time availability badges** | Every card shows **green Available**, **red Checked out / Overdue**, **yellow Reserved** (a booking starts soon), or gray *Out of service* (in repair, lost, retired). The grid refreshes itself every 20 seconds. |
| **Condition logging with photo** | Returning an item requires choosing **Excellent / Fair / Damaged**, with optional notes and a photo taken on the spot. Damaged items create a damage record and, by default, go to *In repair* until staff clear them. |
| **Digital signatures** | High-value gear (value ≥ threshold, default $500, or flagged per item) can't leave without a touch-screen signature from the student, a parent or a teacher. Signatures are stored with the loan and visible to staff on the loan page. |
| **Grace period & fines/restrictions** | Overdue items within the grace period (default 24 h) only warn. After that, the student can't book or check out new gear until the item comes back. Optional extras: a cooldown after a late return, per-day late fines, blocking on unpaid fines, and manual restrictions. Staff can override with a written reason, which is recorded. |
| **Quick inventory audit** | *Shelf audit*: pick a location (e.g. "Cabinet A") and scan everything on it. Live lists show what's **found**, **missing**, and **unexpected** (checked out on paper, marked lost, or belonging somewhere else). Finishing can mark missing items lost, relocate misplaced ones, and restore found "lost" items. Each audit is kept as a record. |
| **Loss & damage analytics** | *Loss & damage* report with a date range: totals, damage rate, incidents by category and by month, damage rate per category, most-affected items, and an incident log with photos. Exports to CSV. |

Also included: bookings with conflict checks and pickup windows, staff dashboard, student "My gear" page, CSV import for items and students, scanning a student ID card to pick the borrower, light/dark mode, and a phone-first layout.

## Roles

- **Students** browse the grid, book gear, check out and return their own gear (both can be turned off in Settings), and see their own loans.
- **Teachers / admins** do everything: check out to any student, process returns, manage items, kits and people, run audits, read reports, and change settings.

## Getting your inventory in

1. **Settings → Categories**: adjust categories. Mark which are *main items* (camera bodies, camcorders).
2. **Equipment → Import** a CSV (or add items one by one; use *Duplicate* for identical units):

   ```csv
   tag,name,category,brand,model,serial_number,value,location,compat,parent_tag,kit_tag
   CAM-001,Canon EOS Rebel T7i,Camera Body,Canon,T7i,0430210,749,Cabinet A,mount:EF;battery:LP-E17;media:SD,,KIT-01
   LENS-001,EF-S 18-55mm,Lens,Canon,,,249,Cabinet A,mount:EF,CAM-001,
   ```

3. **People → Import CSV** with `name,username,student_id,email,role`. Missing passwords are generated and shown once, so copy them out.
4. **Print labels** and stick them on.

## Development

```bash
npm run dev     # demo data, restarts on file changes
npm test        # API tests (node:test)
```

```
server/
  index.js            start-up, HTTPS, first admin, demo seeding
  app.js              Express app, security headers, file serving
  schema.js           SQLite schema (migrations)
  services/           business rules: availability, compatibility,
                      check-out/return, bookings, restrictions, assets
  routes/             JSON API
  demo.js             sample data
public/               single-page app (plain ES modules, no build step)
  js/views/           one file per screen
  js/scanner.js       camera + USB scanner input
  js/signature.js     signature pad
test/                 API tests
```

Configuration (environment variables): `PORT` (3000), `HOST`, `DATA_DIR`, `DB_PATH`, `UPLOADS_DIR`, `ADMIN_PASSWORD`, `HTTPS=1` (same as `--https`), `HTTPS_PORT` (3443), `TLS_CERT`, `TLS_KEY`, `TRUST_PROXY` (number of proxy hops, e.g. `1`).

Security notes: passwords are hashed with scrypt; sessions use HttpOnly SameSite cookies; every state-changing request must be JSON (CSRF protection); uploads are checked to be real JPEG/PNG/WebP files; damage photos and signatures are only served to staff.
