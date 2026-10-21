const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/pricing');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ghee = { name: 'Ghee', aliases: '["desi ghee"]', unit_type: 'weight' };
const cashews = { name: 'Cashews', aliases: '[]', unit_type: 'weight' };
const varq = { name: 'Silver varq', aliases: '["varq"]', unit_type: 'count' };

test('mass conversions to kg', () => {
  near(p.toBase(500, 'g', cashews), 0.5);
  near(p.toBase(2, 'kg', cashews), 2);
  near(p.toBase(16, 'oz', cashews), 0.45359237);
  near(p.toBase(1, 'lbs', cashews), 0.45359237);
});

test('volume only with known density', () => {
  near(p.toBase(1000, 'ml', ghee), 0.91);
  near(p.toBase(1, 'cup', { name: 'Whole milk', aliases: '[]' }), 0.236588 * 1.03);
  near(p.toBase(1, 'tbsp', { name: 'Vegetable oil', aliases: '[]' }), 0.0147868 * 0.92);
  assert.throws(() => p.toBase(1, 'cup', cashews), /enter a weight/);
  assert.throws(() => p.toBase(1, 'cup', { name: 'Milk powder', aliases: '[]' }), /enter a weight/);
});

test('count items', () => {
  assert.equal(p.toBase(12, 'sheets', varq), 12);
  assert.equal(p.toBase(1, 'dozen', varq), 12);
  assert.throws(() => p.toBase(10, 'g', varq), /per item/);
  assert.throws(() => p.toBase(10, 'each', cashews), /by weight/);
  assert.throws(() => p.toBase(1, 'bushel', cashews), /Unknown unit/);
});

test('price normalization', () => {
  near(p.pricePerBase(9.98, 2, 'lb', cashews), 9.98 / 0.90718474);
  near(p.pricePerBase(6, 24, 'each', varq), 0.25);
  assert.throws(() => p.pricePerBase(5, 0, 'kg', cashews), /greater than zero/);
});

test('cost formula', () => {
  const ing = (price, extra = {}) => ({ name: 'X', aliases: '[]', unit_type: 'weight', current_price_per_kg: price, price_source: 'manual', confirmed: 1, ...extra });
  const recipe = { yield_units: 10, waste_pct: 10, packaging_cost_per_unit: 0.5, selling_price_per_unit: 4 };
  const r = p.costRecipe(recipe, [
    { quantity: 500, unit: 'g', ingredient: ing(20) }, // 10
    { quantity: 1, unit: 'kg', ingredient: ing(10, { price_source: 'web_estimate' }) }, // 10, estimate
    { quantity: 1, unit: 'kg', ingredient: ing(99, { confirmed: 0, price_source: 'web_estimate' }) }, // excluded
  ]);
  near(r.batch_cost, 20);
  near(r.cost_per_unit, (20 / 10) * 1.1 + 0.5); // 2.7
  near(r.ingredients_per_unit + r.waste_per_unit + r.packaging_per_unit, r.cost_per_unit); // dashboard bar parts add up
  near(r.margin_pct, ((4 - 2.7) / 4) * 100);
  near(r.trusted_pct, 50);
  assert.equal(r.lines[1].status, 'estimate');
  assert.equal(r.lines[2].status, 'unconfirmed');
  assert.equal(r.incomplete, true);
});

test('reverse mode', () => {
  near(p.suggestPrice(2.7, 50), 5.4);
  near(p.costRecipe({ yield_units: 1, waste_pct: 0, packaging_cost_per_unit: 0, selling_price_per_unit: p.suggestPrice(3, 40) },
    [{ quantity: 1, unit: 'kg', ingredient: { name: 'X', current_price_per_kg: 3, price_source: 'manual', confirmed: 1 } }]).margin_pct, 40);
  assert.equal(p.suggestPrice(2, 100), null);
});

test('sanity ranges', () => {
  assert.equal(p.sanityCheck(ghee, 17), null);
  assert.match(p.sanityCheck(ghee, 170), /outside/);
  assert.equal(p.sanityCheck(varq, 0.25), null);
  assert.equal(p.sanityCheck({ name: 'Rose petals', aliases: '[]' }, 1000), null);
});

test('matching and size parsing', () => {
  const list = [{ id: 1, name: 'Green cardamom', aliases: '["elaichi"]' }, { id: 2, name: 'Ghee', aliases: '[]' }, { id: 3, name: 'Desi ghee special', aliases: '[]' }];
  assert.equal(p.matchIngredient('DEEP ELAICHI 200G', list), 1);
  assert.equal(p.matchIngredient('Amul Ghee 1L', list), 2);
  assert.equal(p.matchIngredient('Paneer', list), null);
  assert.deepEqual(p.parseSize('16 oz'), { quantity: 16, unit: 'oz' });
  assert.deepEqual(p.parseSize('32 fl oz'), { quantity: 32, unit: 'fl oz' });
  assert.deepEqual(p.parseSize('2 x 8 oz'), { quantity: 16, unit: 'oz' });
  assert.deepEqual(p.parseSize('12 ct'), { quantity: 12, unit: 'each' });
  assert.equal(p.parseSize('each'), null);
});

test('median', () => {
  assert.equal(p.median([3, 1, 2]), 2);
  assert.equal(p.median([4, 1, 2, 3]), 2.5);
});
