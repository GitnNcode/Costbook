const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { pricePerBase, sanityCheck } = require('./lib/pricing');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'costbook.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  aliases TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  unit_type TEXT NOT NULL DEFAULT 'weight' CHECK (unit_type IN ('weight', 'count')),
  -- $ per kg for weight items, $ per each for count items
  current_price_per_kg REAL,
  price_source TEXT CHECK (price_source IN ('receipt', 'manual', 'kroger', 'web_estimate')),
  source_detail TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  price_updated_at TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  price REAL NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  price_per_kg REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('receipt', 'manual', 'kroger', 'web_estimate')),
  source_detail TEXT,
  observed_at TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  flag TEXT
);
CREATE INDEX IF NOT EXISTS obs_ing ON price_observations (ingredient_id, observed_at);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  image_path TEXT NOT NULL,
  store TEXT,
  date TEXT,
  raw_parse_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'confirmed'))
);
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  yield_units REAL NOT NULL DEFAULT 1,
  unit_name TEXT NOT NULL DEFAULT 'piece',
  waste_pct REAL NOT NULL DEFAULT 0,
  packaging_cost_per_unit REAL NOT NULL DEFAULT 0,
  selling_price_per_unit REAL
);
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('kroger_location_id', ''), ('target_margin_pct', '50'), ('last_price_refresh', '');
`);

const CONFIDENCE = { receipt: 'high', manual: 'high', kroger: 'medium', web_estimate: 'low' };

// Recompute an ingredient's current price from its observation history.
// Newest confirmed receipt/manual wins, then Kroger, then web estimate.
// If nothing is confirmed, show the newest pending observation as unconfirmed (excluded from totals).
function applyWaterfall(ingredientId) {
  const obs = db.prepare('SELECT * FROM price_observations WHERE ingredient_id = ? ORDER BY observed_at DESC, id DESC').all(ingredientId);
  const ok = obs.filter((o) => o.confirmed);
  const pick = ok.find((o) => o.source === 'receipt' || o.source === 'manual')
    || ok.find((o) => o.source === 'kroger')
    || ok.find((o) => o.source === 'web_estimate')
    || obs[0];
  db.prepare(`UPDATE ingredients SET current_price_per_kg = ?, price_source = ?, source_detail = ?, confidence = ?,
    price_updated_at = ?, confirmed = ? WHERE id = ?`).run(
    pick?.price_per_kg ?? null, pick?.source ?? null, pick?.source_detail ?? null, pick ? CONFIDENCE[pick.source] : null,
    pick?.observed_at ?? null, pick?.confirmed ?? 0, ingredientId,
  );
}

// Record a price. Throws on bad units. Out-of-range prices are saved but never auto-applied.
function recordPrice(ingredientId, { price, quantity, unit, source, source_detail, observed_at, confirmed = true }) {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredientId);
  if (!ing) throw new Error('Ingredient not found');
  const perBase = pricePerBase(price, quantity, unit, ing);
  const flag = sanityCheck(ing, perBase);
  const info = db.prepare(`INSERT INTO price_observations
    (ingredient_id, price, quantity, unit, price_per_kg, source, source_detail, observed_at, confirmed, flag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ingredientId, Number(price), Number(quantity), unit, perBase, source, source_detail ?? null,
    observed_at || new Date().toISOString(), confirmed && !flag ? 1 : 0, flag,
  );
  applyWaterfall(ingredientId);
  return db.prepare('SELECT * FROM price_observations WHERE id = ?').get(info.lastInsertRowid);
}

function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

function cacheGet(key, maxAgeDays) {
  const row = db.prepare('SELECT * FROM api_cache WHERE key = ?').get(key);
  if (!row || Date.now() - row.fetched_at > maxAgeDays * 864e5) return null;
  return JSON.parse(row.value);
}

function cacheSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO api_cache VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now());
}

function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM ingredients').get().n) return;
  // [name, aliases, category, unit_type, price, quantity, unit]  (sample prices, USD)
  const items = [
    ['Cashews', ['kaju'], 'nuts', 'weight', 22.0, 1, 'kg'],
    ['Sugar', ['cheeni'], 'sweetener', 'weight', 1.8, 1, 'kg'],
    ['Ghee', ['desi ghee', 'clarified butter'], 'dairy', 'weight', 17.0, 1, 'kg'],
    ['Green cardamom', ['elaichi', 'cardamom'], 'spice', 'weight', 6.6, 100, 'g'],
    ['Saffron', ['kesar'], 'spice', 'weight', 7.0, 2, 'g'],
    ['Silver varq', ['varq', 'vark', 'silver leaf'], 'decoration', 'count', 6.0, 24, 'each'],
    ['Besan', ['gram flour', 'chickpea flour'], 'flour', 'weight', 4.4, 1, 'kg'],
    ['Khoya', ['mawa', 'khoa'], 'dairy', 'weight', 13.0, 1, 'kg'],
    ['Maida', ['all-purpose flour', 'all purpose flour'], 'flour', 'weight', 1.5, 1, 'kg'],
    ['Baking soda', ['sodium bicarbonate'], 'other', 'weight', 3.0, 1, 'kg'],
    ['Whole milk', ['milk', 'doodh'], 'dairy', 'weight', 1.1, 1, 'kg'],
    ['Vegetable oil', ['oil'], 'oil', 'weight', 3.5, 1, 'kg'],
  ];
  const recipes = [
    ['Kaju katli', 40, 'piece', 3, 0.05, 0.9, [['Cashews', 500, 'g'], ['Sugar', 250, 'g'], ['Ghee', 15, 'g'], ['Green cardamom', 2, 'g'], ['Silver varq', 12, 'each']]],
    ['Besan ladoo', 30, 'piece', 2, 0.03, 0.75, [['Besan', 500, 'g'], ['Ghee', 250, 'g'], ['Sugar', 400, 'g'], ['Green cardamom', 3, 'g'], ['Cashews', 30, 'g']]],
    ['Gulab jamun (box of 12)', 3, 'box', 5, 0.6, 9.0, [['Khoya', 250, 'g'], ['Maida', 40, 'g'], ['Baking soda', 1, 'g'], ['Whole milk', 60, 'ml'],
      ['Sugar', 600, 'g'], ['Green cardamom', 2, 'g'], ['Saffron', 0.2, 'g'], ['Vegetable oil', 150, 'ml']]],
  ];
  db.transaction(() => {
    const ids = {};
    for (const [name, aliases, category, unitType, price, qty, unit] of items) {
      ids[name] = db.prepare('INSERT INTO ingredients (name, aliases, category, unit_type) VALUES (?, ?, ?, ?)')
        .run(name, JSON.stringify(aliases), category, unitType).lastInsertRowid;
      // Dated in the past so any real receipt or manual price is newer and wins.
      recordPrice(ids[name], { price, quantity: qty, unit, source: 'manual', source_detail: 'sample data', observed_at: '2025-01-01T00:00:00.000Z' });
    }
    for (const [name, yieldUnits, unitName, waste, pack, sell, lines] of recipes) {
      const rid = db.prepare(`INSERT INTO recipes (name, yield_units, unit_name, waste_pct, packaging_cost_per_unit, selling_price_per_unit)
        VALUES (?, ?, ?, ?, ?, ?)`).run(name, yieldUnits, unitName, waste, pack, sell).lastInsertRowid;
      for (const [ing, q, u] of lines) {
        db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)').run(rid, ids[ing], q, u);
      }
    }
  })();
}
seed();

module.exports = { db, DATA_DIR, applyWaterfall, recordPrice, getSettings, cacheGet, cacheSet };
