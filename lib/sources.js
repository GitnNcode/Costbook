// External price sources: Claude vision (receipts), Kroger product API, Perplexity Agent API (web estimates).
// Every source is optional: a missing key disables that source with a message shown in Settings.
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { cacheGet, cacheSet } = require('../db');
const { pricePerBase, median, parseSize } = require('./pricing');

const RECEIPT_MODEL = 'claude-sonnet-5-5';
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const KROGER = 'https://api.kroger.com/v1';
const PPLX = 'https://api.perplexity.ai/v1/agent';

const fail = (msg, status = 502) => Object.assign(new Error(msg), { status });

function status() {
  const e = process.env;
  const s = (enabled, off) => ({ enabled, message: enabled ? 'Enabled' : off });
  return {
    anthropic: s(!!e.ANTHROPIC_API_KEY, 'Disabled: set ANTHROPIC_API_KEY in .env to read receipts'),
    kroger: s(!!(e.KROGER_CLIENT_ID && e.KROGER_CLIENT_SECRET), 'Disabled: set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in .env'),
    perplexity: s(!!e.PERPLEXITY_API_KEY, 'Disabled: set PERPLEXITY_API_KEY in .env for web estimates'),
  };
}

function requireSource(name) {
  const s = status()[name];
  if (!s.enabled) throw fail(s.message, 503);
}

// ---------- Receipts (Claude vision) ----------
const RECEIPT_TOOL = {
  name: 'record_receipt',
  description: 'Record the line items read from a grocery receipt or supplier invoice.',
  input_schema: {
    type: 'object',
    properties: {
      store: { type: ['string', 'null'], description: 'Store or supplier name as printed' },
      date: { type: ['string', 'null'], description: 'Purchase date as YYYY-MM-DD, or null if not printed' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Item text exactly as printed' },
            quantity: { type: 'number', description: 'Total amount bought: number of packs times pack size' },
            unit: { type: 'string', enum: ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'each'] },
            total_price: { type: 'number', description: 'Line total actually charged, as printed' },
            match_ingredient_id: { type: ['integer', 'null'], description: 'id from the known ingredient list, or null' },
            suggested_name: { type: 'string', description: 'Short generic ingredient name, e.g. "Ghee", "Green cardamom"' },
            note: { type: 'string', description: 'Anything uncertain about this line, else empty' },
          },
          required: ['name', 'quantity', 'unit', 'total_price', 'match_ingredient_id', 'suggested_name', 'note'],
        },
      },
    },
    required: ['store', 'date', 'lines'],
  },
};

async function parseReceipt(filePath, mimeType, ingredients) {
  requireSource('anthropic');
  const data = fs.readFileSync(filePath).toString('base64');
  const file = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
  const known = ingredients.map((i) => `${i.id}: ${i.name}${i.aliases.length ? ` (also: ${i.aliases.join(', ')})` : ''}`).join('\n');
  const prompt = `Read this receipt/invoice from a shop that makes Indian sweets. Extract food ingredient and packaging line items only (skip tax, totals, bags, discounts as separate lines; apply a discount to its item if clearly attached).

Rules:
- Only report prices that are printed. Never estimate or invent a price. If a line's price is unreadable, leave that line out.
- quantity + unit = total amount bought. Use the pack size printed in the item text (e.g. "GHEE 1KG" x2 = 2 kg). If only a count is known, use unit "each" and explain in note.
- Match each line to one of these known ingredients by meaning, including Hindi names and brand text (e.g. "elaichi" = green cardamom, "kaju" = cashews). Use null if none fits.

Known ingredients:
${known || '(none yet)'}`;

  const client = new Anthropic();
  let msg;
  try {
    msg = await client.messages.create({
      model: RECEIPT_MODEL,
      max_tokens: 4096,
      tools: [RECEIPT_TOOL],
      tool_choice: { type: 'tool', name: RECEIPT_TOOL.name },
      messages: [{ role: 'user', content: [file, { type: 'text', text: prompt }] }],
    });
  } catch (e) {
    throw fail(`Receipt reading failed: ${e.status === 401 ? 'ANTHROPIC_API_KEY was rejected' : e.message}`);
  }
  const out = msg.content.find((b) => b.type === 'tool_use')?.input;
  if (!out || !Array.isArray(out.lines)) throw fail('Could not read any line items from this image');
  out.lines = out.lines.filter((l) => Number(l.total_price) > 0 && Number(l.quantity) > 0);
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) out.date = null;
  return out;
}

// ---------- Kroger ----------
let krogerToken = null;

async function krogerFetch(pathAndQuery) {
  requireSource('kroger');
  if (!krogerToken || krogerToken.expires < Date.now()) {
    const basic = Buffer.from(`${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${KROGER}/connect/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=product.compact',
    });
    if (!r.ok) throw fail(`Kroger sign-in failed (${r.status}); check KROGER_CLIENT_ID and KROGER_CLIENT_SECRET`);
    const t = await r.json();
    krogerToken = { value: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  }
  const r = await fetch(`${KROGER}${pathAndQuery}`, { headers: { Authorization: `Bearer ${krogerToken.value}`, Accept: 'application/json' } });
  if (r.status === 401) krogerToken = null;
  if (!r.ok) throw fail(`Kroger request failed (${r.status})`);
  return r.json();
}

async function krogerLocations(zip) {
  const j = await krogerFetch(`/locations?filter.zipCode.near=${zip}&filter.limit=10`);
  return (j.data || []).map((l) => ({
    location_id: l.locationId, name: l.name, chain: l.chain,
    address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode].filter(Boolean).join(', '),
  }));
}

// Returns top products with price and, where the size string parses, a normalized $/kg (or $/each).
async function krogerSearch(term, locationId, ing) {
  term = term.trim();
  if (term.length < 3) throw fail('Search term must be at least 3 characters', 400);
  const key = `kroger:${locationId}:${term.toLowerCase()}`;
  let products = cacheGet(key, 7);
  const cached = !!products;
  if (!products) {
    const q = new URLSearchParams({ 'filter.term': term, 'filter.locationId': locationId, 'filter.limit': '10' });
    const j = await krogerFetch(`/products?${q}`);
    products = (j.data || []).map((p) => {
      const item = p.items?.find((x) => x.price?.regular) || p.items?.[0] || {};
      return {
        product_id: p.productId, description: p.description, brand: p.brand, size: item.size || '',
        price: item.price?.regular || null, promo_price: item.price?.promo || null,
      };
    }).filter((p) => p.price);
    if (products.length) cacheSet(key, products);
  }
  return {
    cached,
    products: products.map((p) => {
      const size = parseSize(p.size);
      let perBase = null;
      try { if (size) perBase = pricePerBase(p.price, size.quantity, size.unit, ing); } catch { /* size unit does not fit this ingredient */ }
      return { ...p, quantity: size?.quantity ?? null, unit: size?.unit ?? null, price_per_base: perBase };
    }),
  };
}

// Fresh price for one known product (manual refresh). No cache: the refresh button exists to get today's price.
async function krogerProduct(productId, locationId) {
  const q = new URLSearchParams({ 'filter.locationId': locationId });
  const j = await krogerFetch(`/products/${encodeURIComponent(productId)}?${q}`);
  const p = j.data || {};
  const item = p.items?.find((x) => x.price?.regular) || p.items?.[0] || {};
  if (!item.price?.regular) throw fail('Kroger has no price for this product at your store right now', 404);
  return { product_id: p.productId, description: p.description, size: item.size || '', price: item.price.regular, size_parsed: parseSize(item.size) };
}

// ---------- Perplexity Agent API (successor to Sonar chat completions) ----------
const UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'each'];
const OFFER = {
  type: 'object',
  properties: {
    price: { type: 'number', description: 'Regular price in USD for the whole pack' },
    quantity: { type: 'number', description: 'Net amount in the pack' },
    unit: { type: 'string', enum: UNITS },
    store: { type: 'string' },
    source_url: { type: 'string', description: 'Exact product page where this price was seen' },
    date: { type: 'string', description: 'YYYY-MM-DD the price was seen' },
  },
  required: ['price', 'quantity', 'unit', 'store', 'source_url', 'date'],
  additionalProperties: false,
};
const OFFER_SCHEMA = {
  type: 'object',
  properties: { offers: { type: 'array', items: OFFER } },
  required: ['offers'],
  additionalProperties: false,
};
const DESCRIBE_ITEM = {
  type: 'object',
  properties: {
    input: { type: 'string', description: 'The owner\'s text for this item, copied exactly' },
    name: { type: 'string', description: 'Clear generic ingredient name, brand only if it matters (e.g. "Maggi masala noodles")' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'Other names, Hindi names, common misspellings' },
    category: { type: 'string' },
    search_term: { type: 'string', description: 'Two or three words a US grocery store search would match, e.g. "roma tomatoes", "iodized salt", "frozen green peas"' },
    unit_type: { type: 'string', enum: ['weight', 'count'] },
    match_existing: { type: ['string', 'null'], description: 'Exact name from the existing ingredient list if it is the same ingredient, else null' },
    quantity: { type: 'number' },
    unit: { type: 'string', enum: UNITS },
    assumption: { type: 'string', enum: ['user_stated', 'pack_size_looked_up', 'typical_estimate'] },
    interpretation: { type: 'string', description: 'One sentence showing how the amount was worked out' },
    weight_source_url: { type: ['string', 'null'], description: 'Page that states the pack weight, when assumption is pack_size_looked_up' },
    clarification_needed: { type: ['string', 'null'], description: 'Short question for the owner if the description is too vague, else null' },
    offers: { type: 'array', items: OFFER },
  },
  required: ['input', 'name', 'aliases', 'category', 'search_term', 'unit_type', 'match_existing', 'quantity', 'unit', 'assumption',
    'interpretation', 'weight_source_url', 'clarification_needed', 'offers'],
  additionalProperties: false,
};
const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: DESCRIBE_ITEM } },
  required: ['items'],
  additionalProperties: false,
};

// System instructions shared by every Perplexity request.
const PRICE_RULES = `You are a purchasing researcher for a small Indian sweets (mithai) shop in the United States. The owner uses your answers to cost recipes, so wrong numbers cost them real money.

Sourcing rules:
- Search the web before answering. Every price and pack size you return must come from a page you found in this search. Never estimate, average, or recall prices from memory.
- Prefer places a small US food business actually buys from: Indian grocers and online stores (Patel Brothers, iShopIndian, Subzi Mandi, Apna Bazar, Quicklly), restaurant suppliers (Restaurant Depot, WebstaurantStore), warehouse clubs (Costco, Sam's Club), and mainstream grocers (Walmart, Kroger, Target, Amazon).
- Use the regular everyday shelf price for a common pack size. Skip clearance, coupons, subscribe-and-save, member-only deals, bulk pallet pricing, and marketplace listings that look implausibly cheap.
- Match the exact ingredient. Do not substitute: cardamom powder is not whole green cardamom, butter is not ghee, safflower is not saffron, sugar-free is not regular.
- Indian names are common: elaichi = green cardamom, kesar = saffron, kaju = cashews, badam = almonds, pista = pistachios, besan = gram (chickpea) flour, maida = all-purpose flour, khoya/mawa = dried milk solids, varq/vark = edible silver leaf, cheeni = sugar, doodh = milk.
- quantity and unit are the net contents of the pack that price buys (a 2 lb bag is quantity 2, unit lb). Use net weight, not shipping weight. Sheets and leaves use unit "each" with the sheet count.
- source_url must be the exact product or listing page where you saw that price. If you cannot point to one, leave the offer out. Fewer sourced offers are better than any unsourced one.
- Return 2 to 3 offers from different stores when you can find them.`;

const DESCRIBE_RULES = `${PRICE_RULES}

Describing ingredients:
The owner typed rough descriptions of recipe ingredients, one per numbered line. Return exactly one item per line, in the same order, with input copied exactly. Each line is independent and may have misspellings, brand names, Hindi words, or informal amounts like "2 bricks", "1 packet", "a handful", "half katori".
1. Identify the real ingredient or product and fix the spelling ("Maggie" is Maggi). If it is the same thing as one of the shop's existing ingredients, put that exact existing name in match_existing.
2. Express the amount as a weight. Prefer g.
   - The owner gave a weight or volume: use it as stated. assumption = user_stated.
   - The owner gave a count of packs or pieces (bricks, packets, sachets, pods): search for the product's net weight per pack, multiply, and put that page in weight_source_url. assumption = pack_size_looked_up.
   - The owner gave a household measure (pinch, handful, katori, spoon): convert with a standard culinary equivalent. assumption = typical_estimate.
   - Use ml only for ghee, milk, oil, water or sugar syrup. Use unit "each" and unit_type "count" only for things bought and used by the piece, like silver varq sheets.
3. interpretation is one plain sentence showing the arithmetic, e.g. "2 bricks of Maggi masala noodles at 70 g each = 140 g". search_term is a short plain grocery search for the ingredient.
4. If you cannot tell which single ingredient is meant, set clarification_needed to one short question and give your best guess for the rest.
5. Also return price offers for each ingredient, following the sourcing rules. Keep each item's research brief: one good pack-size source and 2 offers is enough.`;

const urlKey = (u) => {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase();
  } catch {
    return null;
  }
};

// One Agent API call with a JSON schema. Returns the parsed JSON and the set of URLs the search actually returned.
async function pplx(instructions, input, name, schema) {
  requireSource('perplexity');
  const r = await fetch(PPLX, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preset: 'low', // multi-step search; "fast" often stops after one listing
      instructions,
      input: `Today is ${new Date().toISOString().slice(0, 10)}.\n\n${input}`,
      response_format: { type: 'json_schema', json_schema: { name, schema } },
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => { throw fail(`Web lookup failed: ${e.message}`); });
  if (!r.ok) throw fail(`Web lookup failed (${r.status})${r.status === 401 ? ': PERPLEXITY_API_KEY was rejected' : ''}`);
  const j = await r.json();
  const output = j.output || [];
  const text = j.output_text || output.filter((o) => o.type === 'message')
    .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  const seen = new Set(output.filter((o) => o.type === 'search_results').flatMap((o) => o.results || []).map((x) => urlKey(x.url)));
  try {
    return { data: JSON.parse(text), seen };
  } catch {
    throw fail('Web lookup returned unreadable data');
  }
}

// Model-written URLs can be hallucinated, so only keep offers whose URL the search actually returned.
const sourced = (offers, seen) => (offers || []).filter((o) => /^https?:\/\//.test(o.source_url || '') && seen.has(urlKey(o.source_url)));

function priceOffers(offers, ing) {
  const valid = offers.map((o) => {
    try { return { ...o, price_per_base: pricePerBase(o.price, o.quantity, o.unit, ing) }; } catch { return null; }
  }).filter(Boolean);
  return { offers: valid, price_per_base: valid.length ? median(valid.map((o) => o.price_per_base)) : null };
}

async function webEstimate(ing, { fresh = false } = {}) {
  const key = `pplx:${ing.unit_type}:${ing.name.toLowerCase()}`;
  let offers = fresh ? null : cacheGet(key, 14);
  const cached = !!offers;
  if (!offers) {
    const what = ing.unit_type === 'count' ? `${ing.name} (priced per piece or sheet)` : ing.name;
    const { data, seen } = await pplx(PRICE_RULES,
      `Find current US retail prices for: ${what}${ing.aliases.length ? ` (also called ${ing.aliases.join(', ')})` : ''}.`,
      'price_offers', OFFER_SCHEMA);
    offers = sourced(data.offers, seen);
    if (offers.length) cacheSet(key, offers);
  }
  const p = priceOffers(offers, ing);
  if (!p.offers.length) throw fail('No web offers with a verifiable source were found. Enter the price manually.', 404);
  return { cached, ...p };
}

// Turn rough descriptions ("Maggie 2 bricks", "salt 5 g") into ingredients, amounts and sourced price offers.
// Uncached lines go to Perplexity together in one request per batch of 8; each result is cached on its own. No DB writes.
const BATCH = 8;
const describeKey = (t) => `describe:${t.trim().toLowerCase()}`;

async function describeMany(texts, known) {
  const out = new Map(texts.map((t) => [t, cacheGet(describeKey(t), 14)]));
  const todo = [...new Set(texts.filter((t) => !out.get(t)))];
  const list = known.map((i) => i.name + (i.aliases.length ? ` (${i.aliases.join(', ')})` : '')).join('; ');
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const { data, seen } = await pplx(DESCRIBE_RULES,
      `The owner typed:\n${chunk.map((t, n) => `${n + 1}. ${t}`).join('\n')}\n\nThe shop's existing ingredients: ${list || '(none yet)'}`,
      'ingredient_descriptions', DESCRIBE_SCHEMA);
    const items = data.items || [];
    chunk.forEach((t, n) => {
      // Match by echoed input first; fall back to position only when the model kept the count.
      const d = items.find((x) => String(x.input).trim().toLowerCase() === t.trim().toLowerCase())
        || (items.length === chunk.length ? items[n] : null);
      if (!d) return;
      const hit = {
        ...d,
        offers: sourced(d.offers, seen),
        weight_verified: d.assumption === 'pack_size_looked_up' ? seen.has(urlKey(d.weight_source_url)) : null,
      };
      cacheSet(describeKey(t), hit);
      out.set(t, hit);
    });
  }
  return texts.map((t) => out.get(t) || { input: t, error: 'The lookup did not return this item. Try it again on its own.' });
}

module.exports = { status, parseReceipt, krogerLocations, krogerSearch, krogerProduct, webEstimate, describeMany, priceOffers, RECEIPT_TYPES };
