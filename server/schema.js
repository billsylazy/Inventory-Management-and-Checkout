// Database migrations. Each entry runs once, in order; the index of the last
// applied migration is stored in SQLite's `user_version` pragma.
//
// All timestamps are stored as ISO-8601 UTC strings (Date#toISOString), so
// they compare correctly as plain text.

export const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- "main" categories (camera bodies, camcorders...) get accessory suggestions;
  -- "accessory" categories are what gets suggested.
  CREATE TABLE categories (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'accessory' CHECK (kind IN ('main', 'accessory')),
    icon TEXT NOT NULL DEFAULT 'box',
    sort INTEGER NOT NULL DEFAULT 100
  );

  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    email                TEXT,
    student_id           TEXT UNIQUE COLLATE NOCASE,  -- printed on ID cards, scannable at the desk
    role                 TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'student')),
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    restricted_until     TEXT,                        -- manual restriction set by staff
    restriction_note     TEXT,
    active               INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE kits (
    id          INTEGER PRIMARY KEY,
    tag         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE assets (
    id                 INTEGER PRIMARY KEY,
    tag                TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- barcode / QR value
    name               TEXT NOT NULL,
    category           TEXT NOT NULL,
    brand              TEXT,
    model              TEXT,
    serial_number      TEXT,
    description        TEXT,
    photo              TEXT,
    value_cents        INTEGER NOT NULL DEFAULT 0,
    requires_signature INTEGER NOT NULL DEFAULT 0,
    location           TEXT,
    condition          TEXT NOT NULL DEFAULT 'excellent' CHECK (condition IN ('excellent', 'fair', 'damaged')),
    state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'repair', 'lost', 'retired')),
    parent_id          INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    kit_id             INTEGER REFERENCES kits(id) ON DELETE SET NULL,
    notes              TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE INDEX assets_parent ON assets(parent_id);
  CREATE INDEX assets_kit ON assets(kit_id);

  -- Compatibility tags such as "mount:EF", "battery:LP-E6", "media:SD".
  -- Two assets are compatible when they share a tag; "universal" accessories
  -- (tripods, bags...) fit every main item.
  CREATE TABLE asset_compat (
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (asset_id, tag)
  );
  CREATE INDEX asset_compat_tag ON asset_compat(tag);

  CREATE TABLE reservations (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    start_at   TEXT NOT NULL,
    end_at     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'fulfilled', 'cancelled')),
    note       TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE reservation_items (
    reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    asset_id       INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    kit_id         INTEGER REFERENCES kits(id) ON DELETE SET NULL,
    PRIMARY KEY (reservation_id, asset_id)
  );
  CREATE INDEX reservation_items_asset ON reservation_items(asset_id);

  CREATE TABLE loans (
    id              INTEGER PRIMARY KEY,
    borrower_id     INTEGER NOT NULL REFERENCES users(id),
    issued_by       INTEGER REFERENCES users(id),
    reservation_id  INTEGER REFERENCES reservations(id),
    checked_out_at  TEXT NOT NULL,
    due_at          TEXT NOT NULL,
    closed_at       TEXT,
    override_reason TEXT,   -- set when staff overrode a restriction or booking conflict
    notes           TEXT
  );
  CREATE INDEX loans_borrower ON loans(borrower_id);

  CREATE TABLE loan_items (
    id            INTEGER PRIMARY KEY,
    loan_id       INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    asset_id      INTEGER NOT NULL REFERENCES assets(id),
    kit_id        INTEGER REFERENCES kits(id) ON DELETE SET NULL,
    condition_out TEXT,
    outcome       TEXT CHECK (outcome IN ('returned', 'lost')),  -- NULL while still out
    closed_at     TEXT,
    closed_by     INTEGER REFERENCES users(id),
    condition_in  TEXT CHECK (condition_in IN ('excellent', 'fair', 'damaged')),
    return_notes  TEXT,
    return_photo  TEXT,
    confirmation  TEXT CHECK (confirmation IN ('scan', 'manual'))
  );
  CREATE INDEX loan_items_loan ON loan_items(loan_id);
  -- An asset can only be on one open loan at a time.
  CREATE UNIQUE INDEX loan_items_one_open ON loan_items(asset_id) WHERE outcome IS NULL;

  CREATE TABLE signatures (
    id          INTEGER PRIMARY KEY,
    loan_id     INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    signer_name TEXT NOT NULL,
    signer_role TEXT NOT NULL CHECK (signer_role IN ('student', 'parent', 'teacher')),
    image       TEXT NOT NULL,
    signed_at   TEXT NOT NULL
  );

  -- Per-asset tracking history (checkouts, returns, attach/detach, audits...).
  CREATE TABLE asset_events (
    id         INTEGER PRIMARY KEY,
    asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    actor_id   INTEGER REFERENCES users(id),
    loan_id    INTEGER REFERENCES loans(id) ON DELETE SET NULL,
    message    TEXT NOT NULL,
    photo      TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX asset_events_asset ON asset_events(asset_id, created_at);

  -- Loss & damage records that feed the analytics report.
  CREATE TABLE incidents (
    id           INTEGER PRIMARY KEY,
    asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('damaged', 'lost')),
    loan_item_id INTEGER REFERENCES loan_items(id) ON DELETE SET NULL,
    borrower_id  INTEGER REFERENCES users(id),
    reported_by  INTEGER REFERENCES users(id),
    notes        TEXT,
    photo        TEXT,
    cost_cents   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    resolution   TEXT
  );
  CREATE INDEX incidents_created ON incidents(created_at);

  CREATE TABLE fines (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    loan_item_id INTEGER REFERENCES loan_items(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'waived')),
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    resolved_by  INTEGER REFERENCES users(id)
  );
  CREATE INDEX fines_user ON fines(user_id);

  CREATE TABLE audits (
    id          INTEGER PRIMARY KEY,
    location    TEXT,          -- NULL audits every location
    started_by  INTEGER REFERENCES users(id),
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    summary     TEXT           -- JSON snapshot written when the audit is finished
  );

  CREATE TABLE audit_scans (
    audit_id   INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (audit_id, asset_id)
  );
  `,
];

export const DEFAULT_CATEGORIES = [
  { name: 'Camera Body', kind: 'main', icon: 'camera', sort: 10 },
  { name: 'Camcorder', kind: 'main', icon: 'video', sort: 20 },
  { name: 'Lens', kind: 'accessory', icon: 'lens', sort: 30 },
  { name: 'Battery', kind: 'accessory', icon: 'battery', sort: 40 },
  { name: 'Charger', kind: 'accessory', icon: 'charger', sort: 50 },
  { name: 'Memory Card', kind: 'accessory', icon: 'sdcard', sort: 60 },
  { name: 'Tripod', kind: 'accessory', icon: 'tripod', sort: 70 },
  { name: 'Microphone', kind: 'accessory', icon: 'mic', sort: 80 },
  { name: 'Lighting', kind: 'accessory', icon: 'light', sort: 90 },
  { name: 'Bag', kind: 'accessory', icon: 'bag', sort: 100 },
  { name: 'Cable', kind: 'accessory', icon: 'cable', sort: 110 },
  { name: 'Other', kind: 'accessory', icon: 'box', sort: 999 },
];
