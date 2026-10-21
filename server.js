require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR, applyWaterfall, recordPrice, getSettings } = require('./db');
const { costRecipe, suggestPrice, normUnit, unitKind, matchIngredient, densityFor, toBase } = require('./lib/pricing');
const sources = require('./lib/sources');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const parseIng = (i) => i && { ...i, aliases: JSON.parse(i.aliases || '[]'), density: densityFor(i) };
const getIng = (id) => {
  const i = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  if (!i) throw bad('Ingredient not found', 404);
  return i;
};

function linesFor(recipeId) {
  return db.prepare(`SELECT ri.quantity, ri.unit, ri.ingredient_id, i.* FROM recipe_ingredients ri
    JOIN ingredients i ON i.id = ri.ingredient_id WHERE ri.recipe_id = ? ORDER BY ri.id`).all(recipeId)
    .map(({ quantity, unit, ingredient_id, ...ing }) => ({ quantity, unit, ingredient_id, ingredient: parseIng(ing) }));
}

function costDraft(recipe, lines) {
  const ings = new Map();
  const full = lines.map((l) => {
    const id = Number(l.ingredient_id);
    if (!ings.has(id)) ings.set(id, parseIng(db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id)));
    if (!ings.get(id)) throw bad(`Ingredient ${id} not found`);
    return { quantity: l.quantity, unit: l.unit, ingredient_id: id, ingredient: ings.get(id) };
  });
  return costRecipe(recipe, full);
}

// ---------- status & settings ----------
app.get('/api/status', (req, res) => {
  const s = sources.status();
  s.kroger.store_set = !!getSettings().kroger_location_id;
  if (s.kroger.enabled && !s.kroger.store_set) s.kroger.message = 'Keys are set, but no store is chosen. Kroger prices stay off until you pick a store below.';
  res.json(s);
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const { kroger_location_id, target_margin_pct } = req.body;
  if (kroger_location_id !== undefined) {
    if (!/^[0-9A-Za-z]{0,16}$/.test(kroger_location_id)) throw bad('Store location ID should be letters and digits only');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'kroger_location_id'").run(kroger_location_id);
  }
  if (target_margin_pct !== undefined) {
    const m = Number(target_margin_pct);
    if (!(m >= 0 && m < 100)) throw bad('Target margin must be between 0 and 99');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'target_margin_pct'").run(String(m));
  }
  res.json(getSettings());
});

// ---------- ingredients ----------
app.get('/api/ingredients', (req, res) => {
  res.json(db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM price_observations o WHERE o.ingredient_id = i.id) AS observations,
    (SELECT COUNT(*) FROM recipe_ingredients r WHERE r.ingredient_id = i.id) AS used_in
    FROM ingredients i ORDER BY name`).all().map(parseIng));
});

function ingredientFields(body) {
  const name = String(body.name || '').trim();
  if (!name) throw bad('Name is required');
  const aliases = (Array.isArray(body.aliases) ? body.aliases : String(body.aliases || '').split(','))
    .map((a) => String(a).trim()).filter(Boolean);
  const unitType = body.unit_type === 'count' ? 'count' : 'weight';
  return [name, JSON.stringify(aliases), String(body.category || '').trim() || null, unitType];
}

function createIngredient(body) {
  const fields = ingredientFields(body);
  if (db.prepare('SELECT 1 FROM ingredients WHERE name = ?').get(fields[0])) throw bad(`"${fields[0]}" already exists`);
  return db.prepare('INSERT INTO ingredients (name, aliases, category, unit_type) VALUES (?, ?, ?, ?)').run(...fields).lastInsertRowid;
}

app.post('/api/ingredients', (req, res) => {
  const id = db.transaction(() => {
    const id = createIngredient(req.body);
    if (req.body.price !== undefined && req.body.price !== '') {
      recordPrice(id, { ...req.body, source: 'manual', source_detail: 'entered by user' });
    }
    return id;
  })();
  res.json(parseIng(getIng(id)));
});

app.get('/api/ingredients/:id', (req, res) => {
  const ing = parseIng(getIng(req.params.id));
  ing.history = db.prepare('SELECT * FROM price_observations WHERE ingredient_id = ? ORDER BY observed_at DESC, id DESC').all(ing.id);
  ing.recipes = db.prepare(`SELECT DISTINCT r.id, r.name FROM recipes r JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    WHERE ri.ingredient_id = ?`).all(ing.id);
  res.json(ing);
});

app.put('/api/ingredients/:id', (req, res) => {
  const ing = getIng(req.params.id);
  const fields = ingredientFields(req.body);
  const dup = db.prepare('SELECT id FROM ingredients WHERE name = ? AND id != ?').get(fields[0], ing.id);
  if (dup) throw bad(`"${fields[0]}" already exists`);
  // Unit type change would invalidate stored $/kg history.
  if (fields[3] !== ing.unit_type && db.prepare('SELECT 1 FROM price_observations WHERE ingredient_id = ?').get(ing.id)) {
    throw bad('Cannot change weight/count type after prices are recorded');
  }
  db.prepare('UPDATE ingredients SET name = ?, aliases = ?, category = ?, unit_type = ? WHERE id = ?').run(...fields, ing.id);
  res.json(parseIng(getIng(ing.id)));
});

app.post('/api/ingredients/:id/prices', (req, res) => {
  const ing = getIng(req.params.id);
  const detail = String(req.body.source_detail || '').trim() || 'entered by user';
  const obs = recordPrice(ing.id, { ...req.body, source: 'manual', source_detail: detail });
  res.json({ observation: obs, ingredient: parseIng(getIng(ing.id)) });
});

// Accept a pending observation (web estimate or a price flagged by the sanity check).
app.post('/api/observations/:id/confirm', (req, res) => {
  const obs = db.prepare('SELECT * FROM price_observations WHERE id = ?').get(req.params.id);
  if (!obs) throw bad('Observation not found', 404);
  db.prepare('UPDATE price_observations SET confirmed = 1 WHERE id = ?').run(obs.id);
  applyWaterfall(obs.ingredient_id);
  res.json(parseIng(getIng(obs.ingredient_id)));
});

// ---------- recipes ----------
app.get('/api/recipes', (req, res) => {
  const target = Number(getSettings().target_margin_pct);
  res.json(db.prepare('SELECT * FROM recipes ORDER BY name').all().map((r) => {
    const { lines, ...c } = costRecipe(r, linesFor(r.id));
    return { ...r, ...c, line_count: lines.length, flagged: lines.filter((l) => l.status !== 'ok').length, target_margin_pct: target };
  }));
});

app.get('/api/recipes/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!r) throw bad('Recipe not found', 404);
  res.json({ ...r, ...costRecipe(r, linesFor(r.id)) });
});

function recipeFields(b) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('Recipe name is required');
  const num = (v, label, min = 0) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n) || n < min) throw bad(`${label} must be a number of at least ${min}`);
    return n;
  };
  const sp = b.selling_price_per_unit === '' || b.selling_price_per_unit == null ? null : num(b.selling_price_per_unit, 'Selling price');
  const waste = num(b.waste_pct ?? 0, 'Waste %');
  if (waste > 100) throw bad('Waste % must be 100 or less');
  return {
    name,
    yield_units: num(b.yield_units, 'Yield', 0.0001),
    unit_name: ['piece', 'box', 'kg'].includes(b.unit_name) ? b.unit_name : 'piece',
    waste_pct: waste,
    packaging_cost_per_unit: num(b.packaging_cost_per_unit ?? 0, 'Packaging cost'),
    selling_price_per_unit: sp,
  };
}

function checkLines(lines) {
  if (!Array.isArray(lines)) throw bad('lines must be an array');
  return lines.map((l) => {
    const ing = getIng(l.ingredient_id);
    const q = Number(l.quantity);
    if (!(q > 0)) throw bad(`Quantity for ${ing.name} must be greater than zero`);
    normUnit(l.unit);
    return { ingredient_id: ing.id, quantity: q, unit: l.unit };
  });
}

// Live preview for the editor: cost an unsaved draft without validation errors blocking.
app.post('/api/recipes/preview', (req, res) => {
  const { lines = [], ...r } = req.body;
  const usable = lines.filter((l) => l.ingredient_id && l.quantity !== '' && l.unit);
  const target = Number(req.body.target_margin_pct ?? getSettings().target_margin_pct);
  const c = costDraft(r, usable);
  res.json({ ...c, suggested_price: c.cost_per_unit == null ? null : suggestPrice(c.cost_per_unit, target) });
});

function saveRecipe(id, body) {
  const f = recipeFields(body);
  const lines = checkLines(body.lines || []);
  return db.transaction(() => {
    if (id) {
      if (!db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(id)) throw bad('Recipe not found', 404);
      db.prepare(`UPDATE recipes SET name = @name, yield_units = @yield_units, unit_name = @unit_name, waste_pct = @waste_pct,
        packaging_cost_per_unit = @packaging_cost_per_unit, selling_price_per_unit = @selling_price_per_unit WHERE id = ${Number(id)}`).run(f);
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    } else {
      id = db.prepare(`INSERT INTO recipes (name, yield_units, unit_name, waste_pct, packaging_cost_per_unit, selling_price_per_unit)
        VALUES (@name, @yield_units, @unit_name, @waste_pct, @packaging_cost_per_unit, @selling_price_per_unit)`).run(f).lastInsertRowid;
    }
    const ins = db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)');
    for (const l of lines) ins.run(id, l.ingredient_id, l.quantity, l.unit);
    return id;
  })();
}

app.post('/api/recipes', (req, res) => res.json({ id: saveRecipe(null, req.body) }));
app.put('/api/recipes/:id', (req, res) => res.json({ id: saveRecipe(Number(req.params.id), req.body) }));
app.delete('/api/recipes/:id', (req, res) => {
  db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- receipts ----------
const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(sources.RECEIPT_TYPES.includes(file.mimetype) ? null : bad('Upload a JPEG, PNG, WebP, GIF or PDF'), true),
});

app.get('/api/receipts', (req, res) => {
  res.json(db.prepare('SELECT id, store, date, status FROM receipts ORDER BY id DESC').all());
});

app.post('/api/receipts', (req, res, next) => {
  const s = sources.status().anthropic;
  if (!s.enabled) throw bad(s.message, 503);
  next();
}, upload.single('image'), async (req, res) => {
  if (!req.file) throw bad('No file uploaded');
  const ingredients = db.prepare('SELECT id, name, aliases, unit_type FROM ingredients').all();
  // Unreadable uploads are deleted; kept files back a receipt row for later review.
  const parsed = await sources.parseReceipt(req.file.path, req.file.mimetype, ingredients.map(parseIng))
    .catch((e) => { fs.unlinkSync(req.file.path); throw e; });
  const ids = new Set(ingredients.map((i) => i.id));
  // A null AI match means "none fits" and is kept. An id that does not exist falls back to local name/alias matching.
  for (const line of parsed.lines) {
    if (line.match_ingredient_id != null && !ids.has(line.match_ingredient_id)) line.match_ingredient_id = matchIngredient(line.name, ingredients);
  }
  const id = db.prepare('INSERT INTO receipts (image_path, store, date, raw_parse_json) VALUES (?, ?, ?, ?)')
    .run(path.basename(req.file.path), parsed.store, parsed.date, JSON.stringify(parsed)).lastInsertRowid;
  res.json({ id });
});

app.get('/api/receipts/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) throw bad('Receipt not found', 404);
  res.json({ ...r, parsed: JSON.parse(r.raw_parse_json || '{}') });
});

app.get('/api/receipts/:id/image', (req, res) => {
  const r = db.prepare('SELECT image_path FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) throw bad('Receipt not found', 404);
  res.sendFile(path.join(DATA_DIR, 'uploads', path.basename(r.image_path)));
});

// Body: { store, date, lines: [{ skip, ingredient_id | new_name, quantity, unit, total_price }] }
app.post('/api/receipts/:id/confirm', (req, res) => {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!r) throw bad('Receipt not found', 404);
  if (r.status === 'confirmed') throw bad('Receipt already confirmed');
  const store = String(req.body.store || '').trim() || null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  const results = db.transaction(() => {
    const out = [];
    for (const [n, l] of (req.body.lines || []).entries()) {
      if (l.skip) continue;
      const label = `Line ${n + 1}`;
      let id = Number(l.ingredient_id) || null;
      try {
        if (!id) {
          if (!String(l.new_name || '').trim()) throw bad('Pick an ingredient or enter a new name');
          id = createIngredient({ name: l.new_name, unit_type: unitKind(l.unit) === 'count' ? 'count' : 'weight' });
        }
        const obs = recordPrice(id, {
          price: l.total_price, quantity: l.quantity, unit: l.unit, source: 'receipt',
          source_detail: `${store || 'Unknown store'}, receipt #${r.id}`, observed_at: date ? `${date}T12:00:00.000Z` : undefined,
        });
        out.push({ ingredient: getIng(id).name, flag: obs.flag });
      } catch (e) {
        throw bad(`${label}: ${e.message}`);
      }
    }
    db.prepare("UPDATE receipts SET status = 'confirmed', store = ?, date = ? WHERE id = ?").run(store, date, r.id);
    return out;
  })();
  res.json({ saved: results.length, flagged: results.filter((x) => x.flag) });
});

// ---------- Kroger ----------
app.get('/api/kroger/locations', async (req, res) => {
  if (!/^\d{5}$/.test(req.query.zip || '')) throw bad('Enter a 5-digit ZIP code');
  res.json(await sources.krogerLocations(req.query.zip));
});

app.get('/api/ingredients/:id/kroger', async (req, res) => {
  const ing = parseIng(getIng(req.params.id));
  const loc = getSettings().kroger_location_id;
  if (!loc) throw bad('Set your Kroger store location ID in Settings first');
  res.json(await sources.krogerSearch(String(req.query.term || ing.name), loc, ing));
});

// Body: { product_id, description, price, quantity, unit }
app.post('/api/ingredients/:id/kroger', (req, res) => {
  const ing = getIng(req.params.id);
  const loc = getSettings().kroger_location_id;
  const obs = recordPrice(ing.id, {
    price: req.body.price, quantity: req.body.quantity, unit: req.body.unit, source: 'kroger',
    source_detail: `Kroger store ${loc}: ${String(req.body.description || '').slice(0, 120)} (product ${String(req.body.product_id || '').slice(0, 20)})`,
  });
  res.json({ observation: obs, ingredient: parseIng(getIng(ing.id)) });
});

// ---------- Web estimate (Perplexity) ----------
// Only runs when Kroger has no match: either Kroger is off, it returned nothing, or the user said none of its results fit.
app.post('/api/ingredients/:id/web-estimate', async (req, res) => {
  const ing = parseIng(getIng(req.params.id));
  const loc = getSettings().kroger_location_id;
  if (!req.body.kroger_no_match && sources.status().kroger.enabled && loc) {
    const k = await sources.krogerSearch(ing.name, loc, ing);
    if (k.products.length) return res.status(409).json({ error: 'kroger_has_matches', products: k.products });
  }
  const est = await sources.webEstimate(ing);
  const obs = recordPrice(ing.id, {
    price: est.price_per_base, quantity: 1, unit: ing.unit_type === 'count' ? 'each' : 'kg', source: 'web_estimate',
    source_detail: est.offers.map((o) => o.source_url).join(' '), confirmed: false,
  });
  res.json({ ...est, observation: obs, ingredient: parseIng(getIng(ing.id)) });
});

// ---------- Describe ingredients in words (Perplexity, then Kroger for prices) ----------
// ["Maggie 2 bricks", "salt 5 g"] -> one proposal per line: ingredient, amount, Kroger matches, sourced web offers.
// All uncached lines go to Perplexity in one request. Nothing is saved until /accept.
const krogerReady = () => sources.status().kroger.enabled && !!getSettings().kroger_location_id;

async function describeAll(texts) {
  if (!Array.isArray(texts) || !texts.length || texts.length > 30) throw bad('Send 1 to 30 descriptions');
  texts = texts.map((t) => String(t || '').trim());
  if (texts.some((t) => t.length < 2 || t.length > 200)) throw bad('Each description must be 2 to 200 characters');
  const known = db.prepare('SELECT * FROM ingredients').all().map(parseIng);
  const same = (n) => known.find((i) => [i.name, ...i.aliases].some((x) => x.toLowerCase() === String(n || '').trim().toLowerCase()));
  const results = await sources.describeMany(texts, known);
  return Promise.all(results.map(async (d, n) => {
    if (d.error) return { text: texts[n], error: d.error };
    const existing = same(d.match_existing) || same(d.name) || null;
    const ing = existing || { name: d.name, aliases: d.aliases, unit_type: d.unit_type === 'count' ? 'count' : 'weight' };
    let amountError = null;
    try { toBase(d.quantity, d.unit, ing); } catch (e) { amountError = e.message; }
    const needsPrice = !existing || existing.current_price_per_kg == null;
    // Waterfall: Kroger first when it is set up; sourced web offers are the fallback when Kroger has no match.
    let kroger = { ready: krogerReady(), products: [], error: null };
    if (needsPrice && kroger.ready) {
      try {
        const r = await sources.krogerSearch(d.search_term || d.name, getSettings().kroger_location_id, ing);
        // Only products whose pack size converts to this ingredient's unit; the ingredient page handles the rest.
        kroger.products = r.products.filter((p) => p.price_per_base != null).slice(0, 5);
      } catch (e) {
        kroger.error = e.message;
      }
    }
    return {
      text: texts[n], ...d, existing_id: existing?.id ?? null, ingredient: ing, needs_price: needsPrice, amount_error: amountError,
      kroger, web: needsPrice ? sources.priceOffers(d.offers, ing) : { offers: [], price_per_base: null },
    };
  }));
}

app.post('/api/describe', async (req, res) => res.json({ proposals: await describeAll(req.body.texts) }));

// Body: { text, name, kroger_product_id, use_web }. Creates the ingredient if new; if it has no price,
// records the chosen Kroger product (confirmed) or the web estimate (pending until accepted).
app.post('/api/describe/accept', async (req, res) => {
  const [d] = await describeAll([req.body.text]);
  if (d.error) throw bad(d.error);
  const name = String(req.body.name || d.ingredient.name).trim();
  const byName = db.prepare('SELECT * FROM ingredients WHERE name = ?').get(name);
  const product = d.kroger.products.find((p) => p.product_id === req.body.kroger_product_id);
  if (req.body.kroger_product_id && !product) throw bad('That Kroger product is no longer in the results. Look it up again.');
  const id = db.transaction(() => {
    const id = d.existing_id || byName?.id
      || createIngredient({ name, aliases: d.ingredient.aliases, category: d.category, unit_type: d.ingredient.unit_type });
    if (getIng(id).current_price_per_kg != null) return id;
    if (product) {
      recordPrice(id, {
        price: product.price, quantity: product.quantity, unit: product.unit, source: 'kroger',
        source_detail: `Kroger store ${getSettings().kroger_location_id}: ${product.description} ${product.size} (product ${product.product_id})`,
      });
    } else if (req.body.use_web && d.web.offers.length) {
      recordPrice(id, {
        price: d.web.price_per_base, quantity: 1, unit: d.ingredient.unit_type === 'count' ? 'each' : 'kg', source: 'web_estimate',
        source_detail: d.web.offers.map((o) => o.source_url).join(' '), confirmed: false,
      });
    }
    return id;
  })();
  res.json(parseIng(getIng(id)));
});

// ---------- Dashboard & manual price refresh ----------
// The dashboard reads only the database. Online lookups happen only when the owner presses "Update prices",
// so nothing spends API credit in the background.

// Ingredients a refresh would look up: used in a recipe and priced by Kroger or the web. Receipt and manual prices are real and stay.
function refreshable() {
  const rows = db.prepare(`SELECT * FROM ingredients i WHERE price_source IN ('kroger', 'web_estimate')
    AND EXISTS (SELECT 1 FROM recipe_ingredients r WHERE r.ingredient_id = i.id) ORDER BY name`).all().map(parseIng);
  return {
    kroger: krogerReady() ? rows.filter((i) => i.price_source === 'kroger') : [],
    web: sources.status().perplexity.enabled ? rows.filter((i) => i.price_source === 'web_estimate') : [],
  };
}

app.get('/api/dashboard', (req, res) => {
  const s = getSettings();
  const recipes = db.prepare('SELECT * FROM recipes ORDER BY name').all().map((r) => ({ ...r, ...costRecipe(r, linesFor(r.id)) }));
  // Ingredient spend across one batch of every recipe.
  const spend = new Map();
  for (const r of recipes) {
    for (const l of r.lines) {
      if (l.cost == null) continue;
      const e = spend.get(l.ingredient_id) || { id: l.ingredient_id, name: l.ingredient.name, cost: 0, recipes: [] };
      e.cost += l.cost;
      e.recipes.push(r.name);
      spend.set(l.ingredient_id, e);
    }
  }
  const used = 'EXISTS (SELECT 1 FROM recipe_ingredients r WHERE r.ingredient_id = i.id)';
  // Newest unaccepted price per ingredient that is newer than what is applied (or nothing is applied yet).
  const pending = db.prepare(`SELECT o.id, o.ingredient_id, o.price_per_kg, o.source, o.flag, o.observed_at, i.name, i.unit_type,
      CASE WHEN i.confirmed = 1 THEN i.current_price_per_kg END AS current
    FROM price_observations o JOIN ingredients i ON i.id = o.ingredient_id
    WHERE o.confirmed = 0 AND (i.confirmed = 0 OR o.observed_at > COALESCE(i.price_updated_at, ''))
      AND o.id = (SELECT MAX(x.id) FROM price_observations x WHERE x.ingredient_id = o.ingredient_id AND x.confirmed = 0)
    ORDER BY i.name`).all();
  const r = refreshable();
  res.json({
    target_margin_pct: Number(s.target_margin_pct),
    last_price_refresh: s.last_price_refresh || null,
    recipes: recipes.map(({ lines, ...x }) => ({ ...x, flagged: lines.filter((l) => l.status !== 'ok').length })),
    top_ingredients: [...spend.values()].sort((a, b) => b.cost - a.cost),
    pending,
    no_price: db.prepare(`SELECT id, name FROM ingredients i WHERE current_price_per_kg IS NULL AND ${used} ORDER BY name`).all(),
    old_prices: db.prepare(`SELECT COUNT(*) n FROM ingredients i WHERE price_updated_at < ? AND ${used}`)
      .get(new Date(Date.now() - 90 * 864e5).toISOString()).n,
    refresh: { kroger: r.kroger.length, web: r.web.length },
  });
});

app.post('/api/refresh-prices', async (req, res) => {
  const { kroger, web } = refreshable();
  const loc = getSettings().kroger_location_id;
  const fits = (s, ing) => { try { return !!s && toBase(s.quantity, s.unit, ing) > 0; } catch { return false; } };
  const results = [];
  // ponytail: one lookup at a time; fine for a shop's handful of online-priced ingredients, Promise.all if it gets slow.
  for (const ing of kroger) {
    const out = { id: ing.id, name: ing.name, source: 'kroger', before: ing.current_price_per_kg };
    try {
      const last = db.prepare("SELECT * FROM price_observations WHERE ingredient_id = ? AND source = 'kroger' ORDER BY observed_at DESC, id DESC LIMIT 1").get(ing.id);
      const pid = last?.source_detail?.match(/\(product (\w+)\)/)?.[1];
      if (!pid) throw bad('No Kroger product saved for this one; pick it again on its page');
      const p = await sources.krogerProduct(pid, loc);
      // Pack size from Kroger when it fits this ingredient, else the size used last time.
      const size = fits(p.size_parsed, ing) ? p.size_parsed : { quantity: last.quantity, unit: last.unit };
      const obs = recordPrice(ing.id, {
        price: p.price, quantity: size.quantity, unit: size.unit, source: 'kroger',
        source_detail: `Kroger store ${loc}: ${p.description} ${p.size} (product ${p.product_id})`,
      });
      Object.assign(out, { after: obs.price_per_kg, flag: obs.flag });
    } catch (e) {
      out.error = e.message;
    }
    results.push(out);
  }
  for (const ing of web) {
    const out = { id: ing.id, name: ing.name, source: 'web_estimate', before: ing.current_price_per_kg };
    try {
      const est = await sources.webEstimate(ing, { fresh: true });
      // Web prices always wait for the owner's OK before they count.
      const obs = recordPrice(ing.id, {
        price: est.price_per_base, quantity: 1, unit: ing.unit_type === 'count' ? 'each' : 'kg', source: 'web_estimate',
        source_detail: est.offers.map((o) => o.source_url).join(' '), confirmed: false,
      });
      Object.assign(out, { after: obs.price_per_kg, pending: true });
    } catch (e) {
      out.error = e.message;
    }
    results.push(out);
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'last_price_refresh'").run(new Date().toISOString());
  res.json({ results });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is over 5 MB; retake the photo at lower resolution' : err.message });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Costbook running on http://localhost:${port}`));
