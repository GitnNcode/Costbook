// Pure pricing logic: unit conversion, cost math, sanity ranges, name matching.
// No I/O here so it can be unit tested directly.

const MASS_KG = { g: 0.001, kg: 1, oz: 0.028349523125, lb: 0.45359237 };
const VOLUME_ML = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, 'fl oz': 29.5735, qt: 946.353, gal: 3785.41 };
const COUNT = { each: 1, dozen: 12 };

const UNIT_ALIASES = {
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', millilitre: 'ml',
  l: 'l', lt: 'l', ltr: 'l', liter: 'l', litre: 'l', liters: 'l', litres: 'l',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  'fl oz': 'fl oz', floz: 'fl oz', 'fl. oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  qt: 'qt', quart: 'qt', quarts: 'qt', gal: 'gal', gallon: 'gal', gallons: 'gal',
  each: 'each', ea: 'each', ct: 'each', count: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
  sheet: 'each', sheets: 'each', box: 'each', boxes: 'each', pack: 'each', packs: 'each', pk: 'each', unit: 'each', units: 'each',
  dozen: 'dozen', dz: 'dozen',
};

// g per ml. Only these ingredients may be entered by volume.
const DENSITY = { ghee: 0.91, milk: 1.03, oil: 0.92, water: 1.0, 'sugar syrup': 1.3 };

// Plausible US retail $/kg (or $/each for count items). Prices outside are flagged, not applied.
// ponytail: keyword match on name/aliases; first matching row wins, so specific rows go first.
const SANITY = [
  [/\bsaffron|\bkesar/, 'weight', 1000, 20000],
  [/\bvarq|\bvark|\bwarq|silver leaf/, 'count', 0.03, 2],
  [/cardamom|elaichi/, 'weight', 20, 150],
  [/pistachio/, 'weight', 15, 80],
  [/cashew|kaju/, 'weight', 8, 45],
  [/almond|badam/, 'weight', 8, 40],
  [/\bghee\b/, 'weight', 6, 35],
  [/khoya|khoa|mawa/, 'weight', 5, 30],
  [/milk powder/, 'weight', 4, 25],
  [/\bbesan|gram flour|chickpea flour/, 'weight', 1.5, 12],
  [/\bmaida|all.purpose flour|\bflour\b/, 'weight', 0.5, 6],
  [/\bsugar\b/, 'weight', 0.6, 5],
  [/\bmilk\b/, 'weight', 0.5, 4],
  [/\boil\b/, 'weight', 1, 15],
  [/baking soda/, 'weight', 1, 12],
];

// User-input errors carry status 400 so the API returns them as messages, not server errors.
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

function normUnit(u) {
  const key = String(u ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  const unit = UNIT_ALIASES[key];
  if (!unit) throw fail(`Unknown unit "${u}"`);
  return unit;
}

function unitKind(u) {
  const unit = normUnit(u);
  if (unit in MASS_KG) return 'mass';
  if (unit in VOLUME_ML) return 'volume';
  return 'count';
}

function names(ing) {
  const aliases = Array.isArray(ing.aliases) ? ing.aliases : JSON.parse(ing.aliases || '[]');
  return [ing.name, ...aliases].map((n) => String(n).toLowerCase().trim()).filter(Boolean);
}

// "ghee", "desi ghee", "vegetable oil" match; "milk powder" does not match milk.
function densityFor(ing) {
  for (const n of names(ing)) {
    for (const [key, d] of Object.entries(DENSITY)) {
      if (n === key || n.endsWith(' ' + key)) return d;
    }
  }
  return null;
}

// Convert a quantity to the ingredient's base unit: kg for weight items, each for count items.
function toBase(qty, unit, ing) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q < 0) throw fail('Quantity must be a non-negative number');
  const u = normUnit(unit);
  const kind = unitKind(u);
  const type = ing.unit_type || 'weight';
  if (type === 'count') {
    if (kind !== 'count') throw fail(`${ing.name} is priced per item; use "each"`);
    return q * COUNT[u];
  }
  if (kind === 'count') throw fail(`${ing.name} is priced by weight; enter a weight`);
  if (kind === 'mass') return q * MASS_KG[u];
  const d = densityFor(ing);
  if (!d) throw fail(`No density for ${ing.name}; enter a weight (g, kg, oz, lb)`);
  return (q * VOLUME_ML[u] * d) / 1000;
}

// Price paid for qty/unit, normalized to $ per kg (or $ per each).
function pricePerBase(price, qty, unit, ing) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) throw fail('Price must be a non-negative number');
  const base = toBase(qty, unit, ing);
  if (!(base > 0)) throw fail('Quantity must be greater than zero');
  return p / base;
}

function sanityCheck(ing, pricePerBaseUnit) {
  const hay = names(ing).join(' | ');
  const row = SANITY.find(([re, type]) => type === (ing.unit_type || 'weight') && re.test(hay));
  if (!row) return null;
  const [, type, min, max] = row;
  if (pricePerBaseUnit >= min && pricePerBaseUnit <= max) return null;
  const per = type === 'count' ? 'each' : 'kg';
  return `$${pricePerBaseUnit.toFixed(2)}/${per} is outside the plausible range $${min}-$${max}/${per}`;
}

// lines: [{ quantity, unit, ingredient: { name, unit_type, aliases, current_price_per_kg, price_source, confirmed } }]
function costRecipe(recipe, lines) {
  let batch = 0;
  let trusted = 0;
  const out = lines.map((line) => {
    const ing = line.ingredient;
    const r = { ...line, amount: null, cost: null, status: 'ok', note: '' };
    try {
      r.amount = toBase(line.quantity, line.unit, ing);
    } catch (e) {
      return { ...r, status: 'unit_error', note: e.message };
    }
    if (ing.current_price_per_kg == null) return { ...r, status: 'no_price', note: 'No price yet' };
    if (!ing.confirmed) return { ...r, status: 'unconfirmed', note: 'Price needs confirmation; excluded from total' };
    r.cost = r.amount * ing.current_price_per_kg;
    batch += r.cost;
    if (ing.price_source === 'receipt' || ing.price_source === 'manual') trusted += r.cost;
    else r.status = ing.price_source === 'web_estimate' ? 'estimate' : 'kroger';
    return r;
  });

  const yieldUnits = Number(recipe.yield_units);
  const ingPerUnit = yieldUnits > 0 ? batch / yieldUnits : null;
  const wastePerUnit = ingPerUnit == null ? null : ingPerUnit * ((Number(recipe.waste_pct) || 0) / 100);
  const packaging = Number(recipe.packaging_cost_per_unit) || 0;
  const costPerUnit = ingPerUnit == null ? null : ingPerUnit + wastePerUnit + packaging;
  const sp = Number(recipe.selling_price_per_unit);
  return {
    lines: out,
    batch_cost: batch,
    ingredients_per_unit: ingPerUnit,
    waste_per_unit: wastePerUnit,
    packaging_per_unit: packaging,
    cost_per_unit: costPerUnit,
    margin_pct: costPerUnit != null && sp > 0 ? ((sp - costPerUnit) / sp) * 100 : null,
    trusted_pct: batch > 0 ? (trusted / batch) * 100 : 0,
    incomplete: out.some((l) => l.cost == null),
  };
}

function suggestPrice(costPerUnit, targetMarginPct) {
  const m = Number(targetMarginPct);
  if (!(costPerUnit >= 0) || !(m < 100)) return null;
  return costPerUnit / (1 - m / 100);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Local fallback matcher: longest ingredient name or alias contained in the text as whole words.
function matchIngredient(text, ingredients) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  let best = null;
  for (const ing of ingredients) {
    for (const n of names(ing)) {
      const key = n.replace(/[^a-z0-9]+/g, ' ').trim();
      if (key && t.includes(` ${key} `) && (!best || key.length > best.len)) best = { id: ing.id, len: key.length };
    }
  }
  return best?.id ?? null;
}

// Parse a Kroger-style size string like "16 oz", "1.5 lb", "2 x 8 oz", "12 ct".
function parseSize(size) {
  const s = String(size || '').toLowerCase();
  const m = s.match(/(?:(\d+(?:\.\d+)?)\s*(?:x|\/)\s*)?(\d+(?:\.\d+)?|\.\d+)\s*(fl\.? ?oz|[a-z]+)/);
  if (!m) return null;
  try {
    const unit = normUnit(m[3].replace(/\./g, ''));
    return { quantity: Number(m[2]) * (m[1] ? Number(m[1]) : 1), unit };
  } catch {
    return null;
  }
}

module.exports = {
  normUnit, unitKind, densityFor, toBase, pricePerBase, sanityCheck, costRecipe, suggestPrice, median, matchIngredient, parseSize,
  DENSITY,
};
