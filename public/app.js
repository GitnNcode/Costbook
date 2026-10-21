// Costbook frontend: hash router + one render function per screen. No build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '-' : `$${Number(n).toFixed(d)}`);
const pct = (n) => (n == null ? '-' : `${Number(n).toFixed(1)}%`);
const per = (ing) => (ing.unit_type === 'count' ? '/each' : '/kg');
const day = (s) => (s ? String(s).slice(0, 10) : '-');

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}

let msgTimer;
function flash(text, isError = false) {
  clearTimeout(msgTimer);
  $('#msg').innerHTML = text
    ? `<p class="notice mt-4 ${isError ? 'bad' : 'bg-white border-rule-2'}">${esc(text)}</p>`
    : '';
  if (text && !isError) msgTimer = setTimeout(() => flash(''), 4000);
}

// Run an async action, report errors, and keep the button disabled while it runs.
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    flash(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function sourceBadge(ing) {
  if (ing.current_price_per_kg == null) return '<span class="badge bad">no price</span>';
  const label = { receipt: 'receipt', manual: 'manual', kroger: 'Kroger', web_estimate: 'web estimate' }[ing.price_source];
  const warn = ing.price_source === 'web_estimate' || !ing.confirmed;
  return `<span class="badge ${warn ? 'flag' : 'tag'}">${label}</span>${ing.confirmed ? '' : ' <span class="badge bad">not accepted</span>'}${ing.source_detail === 'sample data' ? ' <span class="tag">sample</span>' : ''}`;
}

// Drawn 16px stroke icons, one weight.
const ICONS = {
  x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  back: '<path d="M9.5 3.5L5 8l4.5 4.5"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  alert: '<path d="M8 3l5.5 10h-11z"/><path d="M8 7v2.5M8 11.5v.01"/>',
};
const icon = (n) => `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

function unitOptions(ing, selected) {
  let units = ['g', 'kg', 'oz', 'lb'];
  if (ing?.unit_type === 'count') units = ['each', 'dozen'];
  else if (ing?.density) units = units.concat(['ml', 'l', 'tsp', 'tbsp', 'cup', 'fl oz']);
  if (selected && !units.includes(selected)) units.unshift(selected);
  return units.map((u) => `<option ${u === selected ? 'selected' : ''}>${u}</option>`).join('');
}

const ALL_UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'each'];
const allUnitOptions = (sel) => ALL_UNITS.map((u) => `<option ${u === sel ? 'selected' : ''}>${u}</option>`).join('');

function findIng(list, text) {
  const t = String(text || '').trim().toLowerCase();
  return t ? list.find((i) => i.name.toLowerCase() === t || i.aliases.some((a) => a.toLowerCase() === t)) : null;
}

// ---------- Home dashboard ----------
// Reads only saved data. Online price lookups run only when "Update prices" is pressed, so nothing costs money in the background.
const ago = (iso) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : `on ${day(iso)}`;
};
let lastRefresh = null; // results of the latest "Update prices", shown once on the next draw

async function pageHome() {
  const d = await api('GET', '/api/dashboard');
  const target = d.target_margin_pct;
  const rs = d.recipes;
  const priced = rs.filter((r) => !r.incomplete && r.margin_pct != null);
  const good = priced.filter((r) => r.margin_pct >= target);
  const attention = rs.filter((r) => !good.includes(r));
  const avg = priced.length ? priced.reduce((t, r) => t + r.margin_pct, 0) / priced.length : null;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const lookups = d.refresh.kroger + d.refresh.web;
  const refreshNote = !lookups ? 'Your prices come from receipts and what you typed in, so there is nothing to look up online.'
    : [d.refresh.kroger && `${d.refresh.kroger} Kroger price${d.refresh.kroger > 1 ? 's' : ''} (free)`,
      d.refresh.web && `${d.refresh.web} web price${d.refresh.web > 1 ? 's' : ''} (uses a little paid credit)`].filter(Boolean).join(' and ');

  const tile = (label, value, sub, tone = '') => `<div class="panel p-4 sm:p-5">
    <p class="text-[15px] text-ink-2">${label}</p>
    <p class="text-[32px] leading-tight font-semibold mt-1 ${tone}">${value}</p>
    <p class="text-[14px] muted mt-1">${sub}</p></div>`;

  // Selling price split into what it costs you and what you keep.
  const itemCard = (r) => {
    const sp = Number(r.selling_price_per_unit) || 0;
    const cost = r.cost_per_unit || 0;
    const keep = sp - cost;
    const scale = Math.max(sp, cost) || 1;
    const w = (v) => `${Math.max(0, (v / scale) * 100)}%`;
    const low = r.margin_pct == null || r.margin_pct < target;
    const extra = (r.waste_per_unit || 0) + (r.packaging_per_unit || 0);
    const status = r.incomplete ? `<span class="badge bad">${icon('alert')} Some ingredients have no price</span>`
      : !sp ? '<span class="badge flag">No selling price yet</span>'
        : keep < 0 ? `<span class="badge bad">${icon('alert')} Losing money</span>`
          : low ? `<span class="badge bad">${icon('alert')} Below your ${esc(target)}% goal</span>`
            : `<span class="badge tag text-accent border-accent/40 bg-accent-soft">${icon('check')} On target</span>`;
    const seg = (v, cls, label) => (v > 0 ? `<span class="${cls} h-full first:rounded-l-[4px] last:rounded-r-[4px]" style="width:${w(v)}" title="${label}: ${usd(v, 3)}"></span>` : '');
    return `<a href="#/recipe/${r.id}" class="panel block p-4 sm:p-5 text-ink hover:no-underline hover:border-[#b5b5b1] hover:shadow-sm transition-shadow">
      <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div class="mr-auto min-w-0">
          <p class="text-[19px] font-semibold leading-snug">${esc(r.name)}</p>
          <p class="text-[14px] muted">per ${esc(r.unit_name)}</p>
        </div>
        ${status}
      </div>
      <div class="flex gap-[2px] h-5 mt-4 bg-white" role="img" aria-label="Costs ${usd(cost, 2)}${sp ? `, sells for ${usd(sp)}, you keep ${usd(keep, 2)}` : ''}">
        ${seg(r.ingredients_per_unit, 'bg-[#8f8f89]', 'Ingredients')}${seg(extra, 'bg-[#c4c4bf]', 'Waste and packaging')}${seg(keep, low ? 'bg-low' : 'bg-accent', 'You keep')}
      </div>
      <div class="grid grid-cols-3 gap-2 mt-3 text-[15px]">
        <div><p class="muted text-[13px]">It costs you</p><p class="num text-left font-medium">${usd(cost, 2)}</p></div>
        <div><p class="muted text-[13px]">You sell for</p><p class="num text-left font-medium">${sp ? usd(sp) : '-'}</p></div>
        <div><p class="muted text-[13px]">You keep</p><p class="num text-left font-semibold ${sp ? (low ? 'text-low' : 'text-accent') : ''}">${sp ? `${usd(keep, 2)} <span class="font-normal">(${pct(r.margin_pct)})</span>` : '-'}</p></div>
      </div>
    </a>`;
  };

  const top = d.top_ingredients.slice(0, 6);
  const topMax = top[0]?.cost || 1;
  const topTotal = d.top_ingredients.reduce((t, x) => t + x.cost, 0);

  const refreshPanel = lastRefresh ? (() => {
    const res = lastRefresh;
    lastRefresh = null;
    if (!res.length) return '<p class="notice bg-white border-rule-2 mb-5">Numbers are up to date. There were no online prices to look up.</p>';
    return `<div class="panel p-4 mb-5"><p class="font-semibold mb-2">Price update finished</p><ul class="space-y-1.5 text-[15px]">${res.map((x) => {
      const arrow = x.after > x.before ? '<span class="text-low">went up</span>' : x.after < x.before ? '<span class="text-accent">went down</span>' : 'no change';
      return `<li><a href="#/ingredient/${x.id}">${esc(x.name)}</a>: ${x.error ? `<span class="text-low">${esc(x.error)}</span>`
        : `${usd(x.before)} to <b class="font-medium">${usd(x.after)}</b>, ${arrow}${x.pending ? ' <span class="text-est">(waiting for your OK below)</span>' : ''}${x.flag ? ` <span class="text-est">(looks unusual, check it below)</span>` : ''}`}</li>`;
    }).join('')}</ul></div>`;
  })() : '';

  const todo = d.pending.length + d.no_price.length + (d.old_prices ? 1 : 0);

  main.innerHTML = `
    <div class="flex flex-wrap items-end gap-4 mb-6">
      <div class="mr-auto">
        <h1>${hello}!</h1>
        <p class="text-[17px] text-ink-2 mt-1">Here is how your items are doing.</p>
      </div>
      <div class="flex flex-col items-start sm:items-end gap-1.5 max-w-sm">
        <button id="refresh" class="btn btn-primary btn-lg">${icon('refresh').replace('class="icon"', 'class="icon icon-lg"')} <span>Update prices</span></button>
        <p class="text-[14px] text-ink-2 sm:text-right">Last updated ${ago(d.last_price_refresh)}. ${lookups ? `Checks ${refreshNote}.` : refreshNote}</p>
      </div>
    </div>
    ${refreshPanel}
    ${rs.length ? `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      ${tile('Items you sell', rs.length, `<a href="#/recipe/new">Add another</a>`)}
      ${tile('Doing well', good.length, `at or above your ${esc(target)}% goal`, good.length ? 'text-accent' : '')}
      ${tile('Need a look', attention.length, attention.length ? 'see the red ones below' : 'all good', attention.length ? 'text-low' : '')}
      ${tile('Average you keep', avg == null ? '-' : pct(avg), 'of each sale, after costs')}
    </div>

    <div class="flex flex-wrap items-baseline gap-x-5 gap-y-2 mt-9 mb-3">
      <h2 class="m-0 mr-auto">What each item costs you</h2>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-ink-2" aria-hidden="true">
        <span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-[3px] bg-[#8f8f89]"></span>Ingredients</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-[3px] bg-[#c4c4bf]"></span>Waste and packaging</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-[3px] bg-accent"></span>You keep</span>
      </div>
    </div>
    <div class="grid md:grid-cols-2 gap-3 sm:gap-4">${[...attention, ...good].map(itemCard).join('')}</div>

    <div class="grid lg:grid-cols-2 gap-x-6 items-start">
      <section>
        <h2>Where your money goes</h2>
        <div class="panel p-4 sm:p-5">
          <p class="text-[14px] muted mb-4">Ingredients that cost the most, for one batch of every item.</p>
          ${top.length ? `<ul class="space-y-3.5">${top.map((t) => `<li>
            <div class="flex items-baseline gap-2 text-[15px]"><a href="#/ingredient/${t.id}" class="text-ink font-medium mr-auto">${esc(t.name)}</a>
              <span class="num font-medium">${usd(t.cost)}</span><span class="muted text-[13px] w-11 text-right">${pct((t.cost / topTotal) * 100).replace('.0%', '%')}</span></div>
            <div class="h-2.5 mt-1.5 bg-canvas rounded-[4px]" title="${esc(t.name)}: ${usd(t.cost)} in ${t.recipes.length} item${t.recipes.length > 1 ? 's' : ''}">
              <div class="h-full bg-accent rounded-[4px]" style="width:${(t.cost / topMax) * 100}%"></div></div>
            <p class="text-[13px] muted mt-1">Used in ${t.recipes.map(esc).join(', ')}</p>
          </li>`).join('')}</ul>` : '<p class="muted">No priced ingredients yet.</p>'}
        </div>
      </section>

      <section>
        <h2>Things to check ${todo ? `<span class="badge flag ml-1 align-middle">${todo}</span>` : ''}</h2>
        <div class="panel divide-y divide-rule">
          ${d.pending.map((o) => `<div class="p-4 flex flex-wrap items-center gap-3">
            <div class="mr-auto min-w-0">
              <p class="font-medium"><a href="#/ingredient/${o.ingredient_id}" class="text-ink">${esc(o.name)}</a></p>
              <p class="text-[14px] text-ink-2">${o.source === 'web_estimate' ? 'New price from the web' : o.flag ? 'This price looks unusual' : 'New price'}:
                <b class="font-medium">${usd(o.price_per_kg)}${o.unit_type === 'count' ? '/each' : '/kg'}</b>${o.current != null ? ` (now ${usd(o.current)})` : ''}</p>
            </div>
            <button data-accept="${o.id}" class="btn btn-sm">Use this price</button>
          </div>`).join('')}
          ${d.no_price.map((i) => `<div class="p-4 flex flex-wrap items-center gap-3">
            <p class="mr-auto"><b class="font-medium">${esc(i.name)}</b> <span class="text-ink-2">has no price, so some costs are too low.</span></p>
            <a href="#/ingredient/${i.id}" class="btn btn-sm">Add a price</a></div>`).join('')}
          ${d.old_prices ? `<div class="p-4 flex flex-wrap items-center gap-3">
            <p class="mr-auto text-ink-2"><b class="font-medium text-ink">${d.old_prices} price${d.old_prices > 1 ? 's are' : ' is'} over 3 months old.</b> Upload a receipt or type in what you paid last.</p>
            <a href="#/receipts" class="btn btn-sm">Add a receipt</a></div>` : ''}
          ${todo ? '' : `<p class="p-4 text-accent inline-flex items-center gap-2">${icon('check')} Nothing to check. Nice work.</p>`}
        </div>
      </section>
    </div>`
    : `<div class="panel p-6 sm:p-8 max-w-xl"><p class="text-[18px] font-semibold mb-2">Let's add your first item</p>
        <p class="text-ink-2 mb-4">Type in a recipe with its ingredients and how many pieces it makes. Costbook works out what each piece costs you and how much you keep.</p>
        <a class="btn btn-primary btn-lg" href="#/recipe/new">${icon('plus')} Add an item</a></div>`}`;

  $$('[data-accept]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    await api('POST', `/api/observations/${b.dataset.accept}/confirm`);
    flash('Price saved. Your costs are updated.');
    pageHome();
  })));

  $('#refresh').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (d.refresh.web && !confirm(`This looks up ${d.refresh.web} price${d.refresh.web > 1 ? 's' : ''} on the web, which uses a little paid credit. Go ahead?`)) return;
    act(btn, async () => {
      $('span', btn).textContent = lookups ? 'Updating prices, this can take a minute...' : 'Updating...';
      $('svg', btn).classList.add('animate-spin');
      try {
        lastRefresh = (await api('POST', '/api/refresh-prices')).results;
        await pageHome();
      } finally {
        if (btn.isConnected) {
          $('span', btn).textContent = 'Update prices';
          $('svg', btn).classList.remove('animate-spin');
        }
      }
    });
  });
}

// ---------- Recipes list ----------
let recipeSort = { key: 'name', dir: 1 };

async function pageRecipes() {
  const [rows, settings] = await Promise.all([api('GET', '/api/recipes'), api('GET', '/api/settings')]);
  const target = Number(settings.target_margin_pct);
  rows.forEach((r) => { r.profit = r.cost_per_unit != null && r.selling_price_per_unit ? r.selling_price_per_unit - r.cost_per_unit : null; });
  const cols = [
    ['name', 'Recipe', ''], ['cost_per_unit', 'Cost', 'text-right'], ['selling_price_per_unit', 'Price', 'text-right'],
    ['profit', 'Profit', 'text-right max-sm:hidden'], ['margin_pct', 'Margin', 'text-right'], ['trusted_pct', 'Real prices', 'text-right max-sm:hidden'],
  ];
  const incomplete = rows.filter((r) => r.incomplete);
  const below = rows.filter((r) => !r.incomplete && (r.margin_pct == null || r.margin_pct < target));
  const totalCost = rows.reduce((t, r) => t + r.batch_cost, 0);
  const trusted = totalCost ? rows.reduce((t, r) => t + r.batch_cost * r.trusted_pct, 0) / totalCost : 0;

  // Margin bar: fill = margin, tick = target. Red when below target.
  const bar = (m) => {
    const low = m == null || m < target;
    return `<span class="relative inline-block w-14 h-1 bg-rule align-middle ml-2.5 max-sm:hidden" aria-hidden="true">
      <span class="absolute inset-y-0 left-0 ${low ? 'bg-low' : 'bg-accent'}" style="width:${Math.max(0, Math.min(100, m ?? 0))}%"></span>
      <span class="absolute -inset-y-1 w-px bg-ink" style="left:${Math.min(100, target)}%"></span></span>`;
  };

  main.innerHTML = `
    <div class="flex flex-wrap items-center gap-3 mb-2">
      <h1 class="mr-auto">Recipes</h1>
      <input data-search type="search" placeholder="Filter recipes" aria-label="Filter recipes (press / to focus)" class="w-48">
      <a class="btn btn-primary" href="#/recipe/new">${icon('plus')} New recipe</a>
    </div>
    <p class="text-ink-2 mb-4">${rows.length
      ? `${rows.length} recipe${rows.length === 1 ? '' : 's'}. ${below.length
        ? `<span class="text-low font-medium">${below.length} below</span> your ${esc(target)}% target margin.`
        : `None below your ${esc(target)}% target margin.`}${incomplete.length
        ? ` <span class="text-est font-medium">${incomplete.length} missing prices</span>, so ${incomplete.length === 1 ? 'its' : 'their'} cost is not final.` : ''} ${pct(trusted)} of ingredient cost comes from receipts or prices you entered.`
      : 'No recipes yet.'}</p>
    ${rows.length ? `<div class="scroll"><table>
      <thead><tr>${cols.map(([k, label, cls]) => `<th class="${cls}" aria-sort="${recipeSort.key === k ? (recipeSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button data-sort="${k}" class="inline-flex items-center gap-1 font-medium hover:text-ink cursor-pointer">${label}<span class="text-accent w-2">${recipeSort.key === k ? (recipeSort.dir > 0 ? '&#8593;' : '&#8595;') : ''}</span></button></th>`).join('')}<th class="max-sm:hidden"><span class="sr-only">Warnings</span></th></tr></thead>
      <tbody></tbody>
    </table></div>
    <p class="text-[13px] muted mt-2">Cost and price are per unit (piece, box or kg). The tick on each bar is your target; change it in <a href="#/settings">Settings</a>.</p>`
    : `<div class="panel p-6 max-w-lg"><p class="mb-3">Add a recipe with its ingredients by weight and how many pieces it makes. Costbook works out the cost per piece and your margin.</p>
      <a class="btn btn-primary" href="#/recipe/new">${icon('plus')} New recipe</a></div>`}`;

  if (!rows.length) return;
  const draw = () => {
    const q = $('[data-search]').value.trim().toLowerCase();
    const { key, dir } = recipeSort;
    const list = rows.filter((r) => r.name.toLowerCase().includes(q)).sort((a, b) => {
      const x = a[key] ?? -Infinity;
      const y = b[key] ?? -Infinity;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
    $('tbody', main).innerHTML = list.map((r) => {
      const low = r.margin_pct == null || r.margin_pct < target;
      const warn = r.incomplete ? '<span class="badge bad">missing prices</span>' : r.flagged ? `<span class="badge flag">${r.flagged} estimated</span>` : '';
      return `<tr data-href="#/recipe/${r.id}" class="cursor-pointer hover:bg-[#fafaf9]">
        <td><a href="#/recipe/${r.id}" class="font-medium text-ink">${esc(r.name)}</a><span class="muted text-[13px] ml-2 max-sm:block max-sm:ml-0">per ${esc(r.unit_name)}</span></td>
        <td class="num">${usd(r.cost_per_unit, 3)}</td>
        <td class="num">${usd(r.selling_price_per_unit)}</td>
        <td class="num max-sm:hidden">${usd(r.profit, 3)}</td>
        <td class="num">${r.incomplete ? '<span class="muted" title="Some ingredients have no price">not final</span><span class="inline-block w-14 ml-2.5 max-sm:hidden"></span>'
          : `<span class="${low ? 'text-low font-medium' : ''}">${pct(r.margin_pct)}</span>${bar(r.margin_pct)}`}</td>
        <td class="num max-sm:hidden">${pct(r.trusted_pct)}</td>
        <td class="max-sm:hidden">${warn}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No recipes match.</td></tr>';
  };
  $('[data-search]').addEventListener('input', draw);
  $('tbody', main).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
  });
  $$('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    recipeSort = { key: b.dataset.sort, dir: recipeSort.key === b.dataset.sort ? -recipeSort.dir : 1 };
    pageRecipes();
  }));
  draw();
}

// ---------- Recipe editor ----------
// One spreadsheet-style table: every row is an ingredient line with its price and cost beside it.
// Unknown rows can be "figured out" by Perplexity (all at once, in one request); suggestions appear as a sub-row to accept.
async function pageRecipe(id) {
  const [ings, settings, status, recipe] = await Promise.all([
    api('GET', '/api/ingredients'),
    api('GET', '/api/settings'),
    api('GET', '/api/status'),
    id === 'new' ? null : api('GET', `/api/recipes/${id}`),
  ]);
  const ai = status.perplexity.enabled;
  const r = recipe || { name: '', yield_units: '', unit_name: 'piece', waste_pct: 0, packaging_cost_per_unit: 0, selling_price_per_unit: '', lines: [] };
  const blank = () => ({ name: '', quantity: '', unit: 'g' });
  const lines = r.lines.map((l) => ({ name: l.ingredient.name, quantity: l.quantity, unit: l.unit }));
  if (!lines.length) lines.push(blank(), blank(), blank());
  let calc = null; // last preview result, mapped by row

  main.innerHTML = `
    <form id="rf" novalidate>
      <div class="flex items-center gap-2 mb-3">
        <a href="#/recipes" class="btn btn-quiet btn-sm -ml-2">${icon('back')} Recipes</a>
        <span class="ml-auto"></span>
        ${recipe ? '<button type="button" id="del" class="btn btn-quiet btn-sm text-low">Delete</button>' : ''}
        <button class="btn btn-primary">Save recipe</button>
      </div>
      <input id="f-name" name="name" required value="${esc(r.name)}" placeholder="Recipe name, e.g. Kaju katli" aria-label="Recipe name"
        class="cell text-[22px] font-semibold tracking-[-0.01em] h-11 px-2 -mx-2 max-w-full">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 mt-2 mb-5 text-[14px] text-ink-2">
        <label class="inline-flex items-center gap-2 text-[14px] text-ink-2">Makes
          <input id="f-yield" name="yield_units" inputmode="decimal" value="${esc(r.yield_units)}" class="w-20 text-right font-mono" placeholder="40">
          <select id="f-unit" name="unit_name" aria-label="Unit">${[['piece', 'pieces'], ['box', 'boxes'], ['kg', 'kg']].map(([v, l]) => `<option value="${v}" ${v === r.unit_name ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="inline-flex items-center gap-2 text-[14px] text-ink-2">Waste
          <span class="inline-flex items-center gap-1"><input id="f-waste" name="waste_pct" inputmode="decimal" value="${esc(r.waste_pct)}" class="w-16 text-right font-mono">%</span>
        </label>
        <label class="inline-flex items-center gap-2 text-[14px] text-ink-2">Packaging
          <span class="inline-flex items-center gap-1">$<input id="f-pack" name="packaging_cost_per_unit" inputmode="decimal" value="${esc(r.packaging_cost_per_unit)}" class="w-20 text-right font-mono"></span>
          per <span data-unit>piece</span>
        </label>
      </div>

      <div class="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
        <section class="panel overflow-hidden" aria-labelledby="ing-h">
          <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-rule-2 min-h-11">
            <h2 id="ing-h" class="m-0">Ingredients</h2>
            <span class="ml-auto"></span>
            <button type="button" id="fig-all" class="btn btn-sm" hidden>${icon('search')} <span></span></button>
            <button type="button" id="use-all" class="btn btn-sm btn-primary" hidden>Use all suggestions</button>
          </div>
          <datalist id="ing-list">${ings.map((i) => `<option value="${esc(i.name)}">${esc(i.aliases.join(', '))}</option>`).join('')}</datalist>
          <div class="overflow-x-auto">
            <table class="min-w-[560px] table-fixed">
              <colgroup><col><col class="w-[84px]"><col class="w-[84px]"><col class="w-[116px]"><col class="w-[84px]"><col class="w-[64px] max-sm:hidden"><col class="w-[40px]"></colgroup>
              <thead><tr>
                <th>Ingredient</th><th class="text-right">Amount</th><th>Unit</th><th class="text-right">Price</th><th class="text-right">Cost</th>
                <th class="text-right max-sm:hidden">Share</th><th><span class="sr-only">Remove</span></th>
              </tr></thead>
              <tbody id="rows"></tbody>
            </table>
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-t border-rule-2 bg-[#fafaf9]">
            <button type="button" id="add" class="btn btn-sm btn-quiet -ml-1">${icon('plus')} Add row</button>
            <span class="text-[13px] muted max-md:hidden">${ai ? 'Not in your list? Type it in your own words, like "Maggi 2 bricks", then press Enter.' : 'Ingredients come from your <a href="#/ingredients">Ingredients</a> list.'}</span>
            <span class="ml-auto text-[13px] text-ink-2 whitespace-nowrap">Batch total <b id="batch" class="num font-medium ml-2 text-ink">-</b></span>
          </div>
        </section>

        <aside class="panel lg:sticky lg:top-4" aria-label="Cost and margin">
          <div class="p-4 border-b border-rule">
            <h2 class="mt-0 mb-3">Cost per <span data-unit>piece</span></h2>
            <dl id="calc" class="text-[13px] space-y-1.5"></dl>
          </div>
          <div class="p-4 border-b border-rule space-y-2.5">
            <div class="flex items-center justify-between gap-3">
              <label for="f-price" class="text-[14px] text-ink">Selling price</label>
              <span class="inline-flex items-center gap-1 text-ink-2">$<input id="f-price" name="selling_price_per_unit" inputmode="decimal" value="${r.selling_price_per_unit == null || r.selling_price_per_unit === '' ? '' : Number(r.selling_price_per_unit).toFixed(2)}" class="w-24 text-right font-mono" placeholder="0.00"></span>
            </div>
            <dl id="margin" class="text-[13px] space-y-1.5"></dl>
          </div>
          <div class="p-4 space-y-2.5">
            <div class="flex items-center justify-between gap-3">
              <label for="f-target" class="text-[14px] text-ink">Target margin</label>
              <span class="inline-flex items-center gap-1 text-ink-2"><input id="f-target" inputmode="decimal" value="${esc(settings.target_margin_pct)}" class="w-16 text-right font-mono">%</span>
            </div>
            <div id="suggest" class="text-[13px]"></div>
          </div>
          <div id="trust" class="px-4 py-3 border-t border-rule bg-[#fafaf9] text-[13px] text-ink-2 rounded-b-[4px]"></div>
        </aside>
      </div>
    </form>`;

  const form = $('#rf');
  const rowsEl = $('#rows');
  const unitName = () => ({ piece: 'piece', box: 'box', kg: 'kg' }[$('#f-unit').value]);
  const unitPlural = () => ({ piece: 'pieces', box: 'boxes', kg: 'kg' }[$('#f-unit').value]);
  const isUnknown = (l) => l.name.trim() && !findIng(ings, l.name);
  const describeText = (l) => `${l.name.trim()}${l.quantity !== '' ? ` ${l.quantity} ${l.unit}` : ''}`;

  // ----- rendering -----
  const statusHtml = (l, i) => {
    if (l.loading) return '<span class="text-[12px] muted">Looking it up...</span>';
    if (l.proposal) return '<span class="text-[12px] text-accent">Suggestion below</span>';
    if (isUnknown(l)) {
      return `<span class="badge bad">Not in your list</span>${ai ? ` <button type="button" data-describe="${i}" class="text-[12px] text-accent hover:underline cursor-pointer ml-1">Figure it out</button>`
        : ' <a href="#/ingredients" class="text-[12px] ml-1">Add on Ingredients</a>'}`;
    }
    const c = calc?.rows[i];
    if (!c) return '';
    const link = (t) => `<a href="#/ingredient/${c.ingredient_id}" class="text-[12px]">${t}</a>`;
    if (c.status === 'unit_error') return `<span class="text-[12px] text-low">${esc(c.note)}</span>`;
    if (c.status === 'no_price') return `<span class="badge bad">No price</span> ${link('Add a price')}`;
    if (c.status === 'unconfirmed') return `<span class="badge flag">Not accepted</span> ${link('Check and accept')}`;
    if (c.status === 'estimate') return '<span class="badge flag">Web estimate</span>';
    return '';
  };

  const priceHtml = (c) => {
    if (!c || c.ingredient.current_price_per_kg == null) return '<span class="muted">-</span>';
    const src = { receipt: 'receipt', manual: 'manual', kroger: 'Kroger', web_estimate: 'web' }[c.ingredient.price_source];
    const sample = c.ingredient.source_detail === 'sample data';
    return `<div>${usd(c.ingredient.current_price_per_kg)}<span class="muted">${per(c.ingredient)}</span></div>
      <div class="text-[11px] font-sans ${c.ingredient.price_source === 'web_estimate' || !c.ingredient.confirmed ? 'text-est' : 'muted'}">${sample ? 'sample' : src}</div>`;
  };

  const proposalHtml = (p, i) => {
    if (p.error) {
      return `<p class="text-[13px] text-low">${esc(p.error)}</p>
        <div class="flex gap-2 mt-2"><button type="button" data-describe="${i}" class="btn btn-sm">Try again</button><button type="button" data-dismiss="${i}" class="btn btn-sm btn-quiet">Dismiss</button></div>`;
    }
    const ing = p.ingredient;
    const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>`;
    const weightNote = p.assumption === 'user_stated' ? ''
      : p.assumption === 'typical_estimate' ? ' <span class="text-est">This is a typical kitchen conversion, not a measured weight.</span>'
        : p.weight_verified ? ` Pack weight from ${link(p.weight_source_url, p.weight_source_url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}.`
          : ' <span class="text-est">Check the pack weight on the packet; the source could not be confirmed.</span>';
    let choices;
    if (!p.needs_price) {
      choices = `<p class="text-[13px] text-ink-2">Uses your saved price for ${esc(ing.name)}.</p>`;
    } else {
      const opts = [];
      p.kroger.products.forEach((k, n) => opts.push([`k:${k.product_id}`, `<span class="text-ink">${esc(k.description)}</span> <span class="muted">${esc(k.size)}</span>`,
        `${usd(k.price)} <span class="muted">· ${usd(k.price_per_base)}${per(ing)}</span>`, 'Kroger']));
      if (p.web.offers.length) {
        opts.push(['web', `Web estimate from ${p.web.offers.map((o) => link(o.source_url, o.store)).join(', ')} <span class="text-est">(you accept it on the ingredient page before it counts)</span>`,
          `${usd(p.web.price_per_base)}<span class="muted">${per(ing)}</span>`, 'Web']);
      }
      opts.push(['none', '<span class="text-ink-2">No price for now</span>', '', '']);
      const krogerNote = !status.kroger.enabled ? '' : !p.kroger.ready ? '<p class="text-[12px] text-est mb-1">Kroger is not searched: <a href="#/settings">choose your store</a>.</p>'
        : p.kroger.error ? `<p class="text-[12px] text-low mb-1">Kroger: ${esc(p.kroger.error)}</p>`
          : !p.kroger.products.length ? `<p class="text-[12px] muted mb-1">No Kroger match for "${esc(p.search_term || ing.name)}".</p>` : '';
      choices = `<fieldset><legend class="text-[12px] text-ink-2 mb-1">Price</legend>${krogerNote}
        <div class="border border-rule rounded-[3px] bg-white divide-y divide-rule">${opts.map(([v, label, price, src], n) => `
          <label class="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px] cursor-pointer hover:bg-[#fafaf9]">
            <input type="radio" name="price-${i}" value="${esc(v)}" ${n === 0 ? 'checked' : ''} class="h-auto accent-[#1f5f4a]">
            ${src ? `<span class="tag w-12 justify-center">${src}</span>` : '<span class="w-12"></span>'}
            <span class="min-w-0 flex-1">${label}</span><span class="num">${price}</span>
          </label>`).join('')}</div></fieldset>`;
    }
    return `<div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
      <div class="min-w-0 space-y-2">
        <p class="text-[12px] muted">Suggestion for "${esc(p.text)}"</p>
        ${p.clarification_needed ? `<p class="notice flag">${esc(p.clarification_needed)}</p>` : ''}
        <div class="flex flex-wrap items-center gap-2">
          <input data-p="name" value="${esc(ing.name)}" aria-label="Ingredient name" class="w-64 max-w-full font-medium" ${p.existing_id ? 'readonly' : ''}>
          <input data-p="quantity" value="${esc(+Number(p.quantity).toFixed(3))}" inputmode="decimal" aria-label="Amount" class="w-20 text-right font-mono">
          <select data-p="unit" aria-label="Unit">${unitOptions(ing, p.unit)}</select>
          <span class="tag">${p.existing_id ? 'in your list' : 'new ingredient'}</span>
        </div>
        <p class="text-[13px] text-ink-2">${esc(p.interpretation)}${weightNote}</p>
        ${p.amount_error ? `<p class="text-[13px] text-low">${esc(p.amount_error)}</p>` : ''}
        ${choices}
      </div>
      <div class="flex md:flex-col gap-2 md:pt-6">
        <button type="button" data-use="${i}" class="btn btn-sm btn-primary">Use</button>
        <button type="button" data-dismiss="${i}" class="btn btn-sm">Dismiss</button>
      </div>
    </div>`;
  };

  const rowHtml = (l, i) => {
    const ing = findIng(ings, l.name);
    const unknown = isUnknown(l);
    return `<tr data-row="${i}" class="${unknown && !l.proposal ? 'bg-low-bg/40' : ''}">
      <td class="py-1.5 px-2">
        <input list="ing-list" data-k="name" value="${esc(l.name)}" placeholder="${i === 0 ? 'Type an ingredient' : ''}" aria-label="Ingredient ${i + 1}" autocomplete="off" class="cell px-1.5">
        <div data-status class="px-1.5 min-h-0 empty:hidden mt-0.5">${statusHtml(l, i)}</div>
      </td>
      <td class="py-1.5 px-1"><input data-k="quantity" value="${esc(l.quantity)}" inputmode="decimal" aria-label="Amount ${i + 1}" class="cell text-right font-mono"></td>
      <td class="py-1.5 px-1"><select data-k="unit" aria-label="Unit ${i + 1}" class="cell">${unitOptions(ing, l.unit)}</select></td>
      <td class="num text-[13px]" data-price>${priceHtml(calc?.rows[i])}</td>
      <td class="num" data-cost>${calc?.rows[i]?.cost != null ? usd(calc.rows[i].cost, 3) : '<span class="muted">-</span>'}</td>
      <td class="num text-[13px] text-ink-2 max-sm:hidden" data-share>${calc?.rows[i]?.cost != null && calc.batch_cost ? pct((calc.rows[i].cost / calc.batch_cost) * 100) : ''}</td>
      <td class="px-1 text-center"><button type="button" data-remove="${i}" class="btn btn-quiet btn-sm px-1.5" aria-label="Remove row ${i + 1}">${icon('x')}</button></td>
    </tr>${l.proposal ? `<tr data-prop="${i}" class="bg-[#f7f8f6]"><td colspan="7" class="px-3 py-3">${proposalHtml(l.proposal, i)}</td></tr>` : ''}`;
  };

  const toolbar = () => {
    const unknown = lines.filter((l) => isUnknown(l) && !l.proposal && !l.loading).length;
    const fig = $('#fig-all');
    fig.hidden = !ai || !unknown;
    $('span', fig).textContent = unknown === 1 ? 'Figure out 1 unknown ingredient' : `Figure out all ${unknown} unknown`;
    $('#use-all').hidden = lines.filter((l) => l.proposal && !l.proposal.error).length < 2;
  };

  const drawRows = () => {
    rowsEl.innerHTML = lines.map(rowHtml).join('');
    toolbar();
  };

  const readDraft = () => {
    $$('tr[data-row]', rowsEl).forEach((row) => {
      const l = lines[row.dataset.row];
      $$('[data-k]', row).forEach((el) => { l[el.dataset.k] = el.value; });
    });
    const f = Object.fromEntries(new FormData(form));
    f.lines = lines.map((l) => ({ ingredient_id: findIng(ings, l.name)?.id, quantity: l.quantity, unit: l.unit, name: l.name }));
    return f;
  };

  // Update computed cells in place so typing never loses focus.
  const refreshRow = (i) => {
    const row = $(`tr[data-row="${i}"]`, rowsEl);
    if (!row) return;
    const c = calc?.rows[i];
    row.classList.toggle('bg-low-bg/40', !!(isUnknown(lines[i]) && !lines[i].proposal));
    $('[data-status]', row).innerHTML = statusHtml(lines[i], i);
    $('[data-price]', row).innerHTML = priceHtml(c);
    $('[data-cost]', row).innerHTML = c?.cost != null ? usd(c.cost, 3) : '<span class="muted">-</span>';
    $('[data-share]', row).innerHTML = c?.cost != null && calc.batch_cost ? pct((c.cost / calc.batch_cost) * 100) : '';
  };

  const drawLedger = (c) => {
    const row = (label, val, cls = '') => `<div class="flex justify-between gap-3 ${cls}"><dt class="text-ink-2">${label}</dt><dd class="num">${val}</dd></div>`;
    const yieldN = Number($('#f-yield').value);
    const waste = Number($('#f-waste').value) || 0;
    const pack = Number($('#f-pack').value) || 0;
    const perUnit = yieldN > 0 ? c.batch_cost / yieldN : null;
    $$('[data-unit]').forEach((el) => { el.textContent = unitName(); });
    $('#batch').textContent = usd(c.batch_cost);
    $('#calc').innerHTML = row('Ingredients for the batch', usd(c.batch_cost))
      + row(`÷ ${yieldN > 0 ? `${+yieldN.toFixed(2)} ${unitPlural()}` : '<span class="text-low">enter how many it makes</span>'}`, usd(perUnit, 3))
      + row(`+ ${+waste.toFixed(2)}% waste`, perUnit == null ? '-' : usd(perUnit * (waste / 100), 3))
      + row('+ Packaging', usd(pack, 3))
      + `<div class="flex justify-between gap-3 border-t border-rule-2 pt-2 mt-2 text-[15px] font-semibold"><dt>Cost per ${unitName()}</dt><dd class="num">${usd(c.cost_per_unit, 3)}</dd></div>`;
    const target = Number($('#f-target').value);
    const sp = Number($('#f-price').value);
    const low = c.margin_pct != null && c.margin_pct < target;
    const gaps = lines.filter((l, i) => l.name.trim() && (isUnknown(l) || calc.rows[i]?.cost == null)).length;
    $('#margin').innerHTML = gaps && sp > 0
      ? `<p class="notice bad">Margin not shown: ${gaps} ingredient${gaps > 1 ? 's have' : ' has'} no price yet, so the cost is too low.</p>`
      : sp > 0 && c.cost_per_unit != null
      ? row(`Profit per ${unitName()}`, usd(sp - c.cost_per_unit, 3))
        + `<div class="flex justify-between gap-3"><dt class="text-ink-2">Margin</dt><dd class="num font-semibold ${low ? 'text-low' : 'text-accent'}">${pct(c.margin_pct)}</dd></div>
          <div class="relative h-1.5 bg-rule mt-1" aria-hidden="true"><div class="absolute inset-y-0 left-0 ${low ? 'bg-low' : 'bg-accent'}" style="width:${Math.max(0, Math.min(100, c.margin_pct))}%"></div>
          <div class="absolute -inset-y-1 w-px bg-ink" style="left:${Math.min(100, Math.max(0, target))}%"></div></div>
          ${low ? `<p class="text-low">Below your ${esc(target)}% target.</p>` : ''}`
      : '<p class="muted">Enter a selling price to see profit and margin.</p>';
    $('#suggest').innerHTML = c.suggested_price == null || gaps ? ''
      : `<div class="flex items-center justify-between gap-3"><span class="text-ink-2">Price for ${esc(target)}% margin</span>
          <span class="inline-flex items-center gap-2"><b class="num font-medium">${usd(c.suggested_price)}</b><button type="button" id="use-sp" class="btn btn-sm">Use</button></span></div>`;
    $('#use-sp')?.addEventListener('click', () => {
      $('#f-price').value = c.suggested_price.toFixed(2);
      preview();
    });
    const missing = gaps;
    const est = c.lines.filter((l) => l.status === 'estimate' || l.status === 'kroger').length;
    $('#trust').innerHTML = `<p><b class="num font-medium text-ink">${pct(c.trusted_pct)}</b> of the cost comes from receipts or prices you entered.</p>
      ${est ? `<p class="text-est mt-1">${est} line${est > 1 ? 's use' : ' uses'} Kroger or web prices.</p>` : ''}
      ${missing ? `<p class="text-low mt-1">${missing} line${missing > 1 ? 's are' : ' is'} left out of the cost until ${missing > 1 ? 'they have' : 'it has'} a price.</p>` : ''}`;
  };

  let timer;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const d = readDraft();
      const used = [];
      const sent = d.lines.filter((l, i) => {
        const ok = l.ingredient_id && l.quantity !== '' && l.unit;
        if (ok) used.push(i);
        return ok;
      });
      try {
        const c = await api('POST', '/api/recipes/preview', { ...d, lines: sent, target_margin_pct: $('#f-target').value });
        calc = { ...c, rows: {} };
        c.lines.forEach((l, k) => { calc.rows[used[k]] = l; });
        lines.forEach((_, i) => refreshRow(i));
        drawLedger(c);
        toolbar();
      } catch (e) {
        $('#trust').innerHTML = `<p class="text-low">${esc(e.message)}</p>`;
      }
    }, 150);
  };

  // ----- describe (Perplexity) -----
  const describe = async (idx, btn) => {
    readDraft();
    idx = idx.filter((i) => lines[i].name.trim());
    if (!idx.length) return;
    idx.forEach((i) => { lines[i].loading = true; delete lines[i].proposal; refreshRow(i); });
    toolbar();
    await act(btn, async () => {
      try {
        const { proposals } = await api('POST', '/api/describe', { texts: idx.map((i) => describeText(lines[i])) });
        proposals.forEach((p, k) => { lines[idx[k]].proposal = p; });
      } finally {
        idx.forEach((i) => { delete lines[i].loading; });
        readDraft();
        drawRows();
        preview();
      }
    });
    $(`tr[data-prop="${idx[0]}"] [data-use], tr[data-prop="${idx[0]}"] [data-describe]`, rowsEl)?.focus();
  };

  const accept = async (i) => {
    const p = lines[i].proposal;
    const box = $(`tr[data-prop="${i}"]`, rowsEl);
    const v = (k) => $(`[data-p="${k}"]`, box).value;
    const choice = $(`input[name="price-${i}"]:checked`, box)?.value || 'none';
    const ing = await api('POST', '/api/describe/accept', {
      text: p.text, name: v('name'),
      kroger_product_id: choice.startsWith('k:') ? choice.slice(2) : null, use_web: choice === 'web',
    });
    const at = ings.findIndex((x) => x.id === ing.id);
    if (at >= 0) ings[at] = ing;
    else {
      ings.push(ing);
      $('#ing-list').insertAdjacentHTML('beforeend', `<option value="${esc(ing.name)}">${esc(ing.aliases.join(', '))}</option>`);
    }
    lines[i] = { name: ing.name, quantity: v('quantity'), unit: v('unit') };
    return ing;
  };

  const useOne = (i, btn) => act(btn, async () => {
    readDraft();
    const ing = await accept(i);
    drawRows();
    preview();
    flash(`Added ${ing.name}. Save the recipe to keep it.`);
    $(`tr[data-row="${i}"] [data-k="quantity"]`, rowsEl)?.focus();
  });

  $('#use-all').addEventListener('click', (e) => act(e.currentTarget, async () => {
    readDraft();
    const idx = lines.map((l, i) => (l.proposal && !l.proposal.error ? i : -1)).filter((i) => i >= 0);
    try {
      for (const i of idx) await accept(i);
      flash(`Added ${idx.length} ingredients. Save the recipe to keep them.`);
    } finally {
      drawRows();
      preview();
    }
  }));
  $('#fig-all').addEventListener('click', (e) => describe(lines.map((l, i) => (isUnknown(l) && !l.proposal ? i : -1)).filter((i) => i >= 0), e.currentTarget));

  // ----- events -----
  rowsEl.addEventListener('input', (e) => {
    const row = e.target.closest('tr[data-row]');
    if (row && e.target.dataset.k === 'name') {
      lines[row.dataset.row].name = e.target.value;
      refreshRow(row.dataset.row);
      toolbar();
    }
    if (row) preview();
  });
  rowsEl.addEventListener('change', (e) => {
    if (e.target.dataset.k !== 'name') return;
    const row = e.target.closest('tr[data-row]');
    const ing = findIng(ings, e.target.value);
    if (ing) e.target.value = ing.name;
    const sel = $('[data-k="unit"]', row);
    sel.innerHTML = unitOptions(ing, ing?.unit_type === 'count' ? 'each' : sel.value === 'each' ? 'g' : sel.value);
    readDraft();
    refreshRow(row.dataset.row);
    preview();
  });
  rowsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const prop = e.target.closest('tr[data-prop]');
    if (prop && e.target.dataset.p) {
      e.preventDefault(); // Enter inside a suggestion means Use, not Save
      return useOne(Number(prop.dataset.prop), $('[data-use]', prop));
    }
    const row = e.target.closest('tr[data-row]');
    if (ai && row && e.target.dataset.k === 'name' && isUnknown({ name: e.target.value })) {
      e.preventDefault(); // Enter on an unknown name looks it up instead of saving
      describe([Number(row.dataset.row)]);
    }
  });
  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.describe !== undefined) return describe([Number(b.dataset.describe)], b);
    if (b.dataset.use !== undefined) return useOne(Number(b.dataset.use), b);
    if (b.dataset.dismiss !== undefined) {
      readDraft();
      delete lines[b.dataset.dismiss].proposal;
      drawRows();
      return preview();
    }
    if (b.dataset.remove !== undefined) {
      const i = Number(b.dataset.remove);
      readDraft();
      lines.splice(i, 1);
      if (!lines.length) lines.push(blank());
      drawRows();
      $(`tr[data-row="${Math.min(i, lines.length - 1)}"] input`, rowsEl)?.focus();
      preview();
    }
  });
  $('#add').addEventListener('click', () => {
    readDraft();
    lines.push(blank());
    drawRows();
    $(`tr[data-row="${lines.length - 1}"] input`, rowsEl).focus();
    preview();
  });
  for (const el of ['#f-yield', '#f-unit', '#f-waste', '#f-pack', '#f-price', '#f-target']) $(el).addEventListener('input', preview);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button.btn-primary', form), async () => {
      const d = readDraft();
      d.lines = d.lines.filter((l) => l.name.trim() || l.quantity !== '');
      const missing = d.lines.find((l) => !l.ingredient_id);
      if (missing) throw new Error(`"${missing.name || 'A blank row'}" is not in your ingredients yet. ${ai ? 'Click "Figure it out" on that row, or remove it.' : 'Add it on Ingredients first, or remove the row.'}`);
      const noQty = d.lines.find((l) => !(Number(l.quantity) > 0));
      if (noQty) throw new Error(`Enter an amount for ${noQty.name}.`);
      const res = await api(recipe ? 'PUT' : 'POST', recipe ? `/api/recipes/${recipe.id}` : '/api/recipes', d);
      if (!recipe) {
        history.replaceState(null, '', `#/recipe/${res.id}`); // no hashchange, so the message below survives
        await route();
      }
      flash('Recipe saved');
    });
  });
  $('#del')?.addEventListener('click', () => {
    if (!confirm(`Delete the recipe "${recipe.name}"? Its ingredients and prices stay.`)) return;
    act($('#del'), async () => {
      await api('DELETE', `/api/recipes/${recipe.id}`);
      flash('Recipe deleted');
      location.hash = '#/recipes';
    });
  });

  drawRows();
  preview();
  if (!recipe) $('#f-name').focus();
}

// ---------- Ingredients ----------
async function pageIngredients() {
  const ings = await api('GET', '/api/ingredients');
  main.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <h1 class="mr-auto">Ingredients</h1>
      <input data-search type="search" placeholder="Filter  ( / )" aria-label="Filter ingredients" class="w-40">
    </div>
    <details class="mb-4 panel" ${ings.length ? '' : 'open'}>
      <summary class="px-2 py-1.5 cursor-pointer">New ingredient</summary>
      <form id="nf" class="grid grid-cols-2 sm:grid-cols-8 gap-2 p-2 border-t border-rule-2">
        <div class="field col-span-2"><label for="n-name">Name</label><input id="n-name" name="name" required></div>
        <div class="field col-span-2"><label for="n-al">Aliases (comma separated)</label><input id="n-al" name="aliases" placeholder="elaichi, cardamom"></div>
        <div class="field"><label for="n-type">Priced by</label><select id="n-type" name="unit_type"><option value="weight">weight</option><option value="count">count</option></select></div>
        <div class="field"><label for="n-price">Price paid $</label><input id="n-price" name="price" inputmode="decimal"></div>
        <div class="field"><label for="n-qty">For qty</label><input id="n-qty" name="quantity" inputmode="decimal"></div>
        <div class="field"><label for="n-unit">Unit</label><select id="n-unit" name="unit">${allUnitOptions('kg')}</select></div>
        <div class="field col-span-2"><label for="n-cat">Category</label><input id="n-cat" name="category"></div>
        <div class="col-span-2 sm:col-span-6 flex items-end"><button class="btn btn-primary">Add</button><span class="text-xs muted ml-2">Price is optional. Volume units work only for ghee, milk, oil, water, sugar syrup.</span></div>
      </form>
    </details>
    <div class="scroll"><table>
      <thead><tr><th>Ingredient</th><th class="text-right">Price</th><th>Source</th><th>Conf.</th><th>Updated</th><th class="text-right">Used in</th></tr></thead>
      <tbody></tbody>
    </table></div>
    ${ings.length ? '' : '<p class="muted py-6">No ingredients yet. Add one above or upload a receipt.</p>'}`;

  const draw = () => {
    const q = $('[data-search]').value.trim().toLowerCase();
    $('tbody', main).innerHTML = ings.filter((i) => [i.name, ...i.aliases].some((n) => n.toLowerCase().includes(q))).map((i) => `<tr>
      <td><a href="#/ingredient/${i.id}">${esc(i.name)}</a>${i.aliases.length ? `<div class="text-xs muted">${esc(i.aliases.join(', '))}</div>` : ''}</td>
      <td class="num">${usd(i.current_price_per_kg)}<span class="muted">${per(i)}</span></td>
      <td>${sourceBadge(i)}</td>
      <td class="text-xs">${esc(i.confidence || '-')}</td>
      <td class="text-xs font-mono whitespace-nowrap">${day(i.price_updated_at)}</td>
      <td class="num">${i.used_in}</td>
    </tr>`).join('');
  };
  $('[data-search]').addEventListener('input', draw);
  draw();
  $('#nf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button', e.target), async () => {
      const ing = await api('POST', '/api/ingredients', Object.fromEntries(new FormData(e.target)));
      flash(`Added ${ing.name}`);
      location.hash = `#/ingredient/${ing.id}`;
    });
  });
  $('#n-type').addEventListener('change', (e) => { $('#n-unit').value = e.target.value === 'count' ? 'each' : 'kg'; });
}

async function pageIngredient(id) {
  const [ing, status, settings] = await Promise.all([api('GET', `/api/ingredients/${id}`), api('GET', '/api/status'), api('GET', '/api/settings')]);
  const unitLabel = per(ing);
  const links = (s) => esc(s || '').replace(/https?:\/\/\S+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}</a>`);
  const krogerReady = status.kroger.enabled && settings.kroger_location_id;
  main.innerHTML = `
    <div class="flex flex-wrap items-baseline gap-2 mb-3">
      <h1 class="mr-auto"><a href="#/ingredients">Ingredients</a> / ${esc(ing.name)}</h1>
    </div>
    <div class="panel p-3 mb-4">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span class="num text-lg">${usd(ing.current_price_per_kg)}<span class="muted text-sm">${unitLabel}</span></span>
        ${sourceBadge(ing)}
        <span class="text-xs">confidence: ${esc(ing.confidence || '-')}</span>
        <span class="text-xs font-mono">${day(ing.price_updated_at)}</span>
      </div>
      <div class="text-xs muted mt-1 break-words">${links(ing.source_detail)}</div>
      ${ing.current_price_per_kg != null && !ing.confirmed ? `
        <div class="mt-2 p-2 flag border rounded-sm">
          ${ing.price_source === 'web_estimate' ? 'Web estimate. Check the sources, then accept it or enter your own price. It is not used in recipe totals until accepted.' : `Not applied: ${esc(ing.history.find((h) => !h.confirmed)?.flag || 'needs confirmation')}`}
          <div class="mt-1.5 flex gap-2"><button id="accept" class="btn">Accept</button><button id="edit" class="btn">Edit</button></div>
        </div>` : ''}
      ${ing.recipes.length ? `<div class="text-xs mt-2">Used in: ${ing.recipes.map((r) => `<a href="#/recipe/${r.id}">${esc(r.name)}</a>`).join(', ')}</div>` : ''}
    </div>

    <h2>Enter price</h2>
    <form id="pf" class="grid grid-cols-2 sm:grid-cols-6 gap-2">
      <div class="field"><label for="p-price">Price paid $</label><input id="p-price" name="price" inputmode="decimal" required></div>
      <div class="field"><label for="p-qty">For qty</label><input id="p-qty" name="quantity" inputmode="decimal" value="1" required></div>
      <div class="field"><label for="p-unit">Unit</label><select id="p-unit" name="unit">${unitOptions(ing, ing.unit_type === 'count' ? 'each' : 'kg')}</select></div>
      <div class="field col-span-2"><label for="p-note">Where (store, note)</label><input id="p-note" name="source_detail"></div>
      <div class="flex items-end"><button class="btn btn-primary">Save price</button></div>
    </form>

    <h2>Look up</h2>
    <div class="flex flex-wrap gap-2 items-center">
      <input id="k-term" value="${esc(ing.name)}" aria-label="Kroger search term" class="w-48" ${krogerReady ? '' : 'disabled'}>
      <button id="k-go" class="btn" ${krogerReady ? '' : 'disabled'}>Look up on Kroger</button>
      <button id="w-go" class="btn" ${status.perplexity.enabled ? '' : 'disabled'}>Estimate from web</button>
    </div>
    <p class="text-xs muted mt-1">${!status.kroger.enabled ? 'Kroger is off (no API keys). ' : !settings.kroger_location_id ? 'Kroger needs a store location ID in <a href="#/settings">Settings</a>. ' : ''}${status.perplexity.enabled ? 'Web estimates are used only when Kroger has no match.' : 'Web estimates are off (no PERPLEXITY_API_KEY).'}</p>
    <div id="lookup" class="scroll mt-2"></div>

    <h2>Price history</h2>
    <div class="scroll"><table>
      <thead><tr><th>Date</th><th>Source</th><th class="text-right">Paid</th><th class="text-right">${unitLabel}</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${ing.history.map((h) => `<tr>
        <td class="font-mono text-xs whitespace-nowrap">${day(h.observed_at)}</td>
        <td><span class="tag">${esc(h.source)}</span></td>
        <td class="num">${usd(h.price)} <span class="muted">/ ${esc(h.quantity)} ${esc(h.unit)}</span></td>
        <td class="num">${usd(h.price_per_kg)}</td>
        <td class="text-xs">${h.confirmed ? 'confirmed' : `<span class="badge ${h.flag ? 'bad' : 'flag'}">${h.flag ? 'out of range' : 'pending'}</span> <button data-confirm="${h.id}" class="btn py-0 text-xs">Accept</button>`}
          ${h.flag ? `<div class="text-xs text-low">${esc(h.flag)}</div>` : ''}</td>
        <td class="text-xs break-words max-w-64">${links(h.source_detail)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No prices recorded yet.</td></tr>'}</tbody>
    </table></div>

    <h2>Details</h2>
    <form id="ef" class="grid grid-cols-2 sm:grid-cols-6 gap-2">
      <div class="field col-span-2"><label for="e-name">Name</label><input id="e-name" name="name" value="${esc(ing.name)}" required></div>
      <div class="field col-span-2"><label for="e-al">Aliases (comma separated)</label><input id="e-al" name="aliases" value="${esc(ing.aliases.join(', '))}"></div>
      <div class="field"><label for="e-cat">Category</label><input id="e-cat" name="category" value="${esc(ing.category || '')}"></div>
      <div class="field"><label for="e-type">Priced by</label><select id="e-type" name="unit_type"><option ${ing.unit_type === 'weight' ? 'selected' : ''}>weight</option><option ${ing.unit_type === 'count' ? 'selected' : ''}>count</option></select></div>
      <div><button class="btn">Save details</button></div>
    </form>`;

  const reload = () => pageIngredient(id);
  const confirmObs = (obsId, btn) => act(btn, async () => {
    await api('POST', `/api/observations/${obsId}/confirm`);
    flash('Price accepted');
    reload();
  });
  $('#accept')?.addEventListener('click', (e) => confirmObs(ing.history.find((h) => !h.confirmed).id, e.target));
  $('#edit')?.addEventListener('click', () => {
    $('#p-price').value = Number(ing.current_price_per_kg).toFixed(2);
    $('#p-qty').value = 1;
    $('#p-unit').value = ing.unit_type === 'count' ? 'each' : 'kg';
    $('#p-note').value = 'edited estimate';
    $('#p-price').focus();
    $('#p-price').select();
  });
  $$('[data-confirm]').forEach((b) => b.addEventListener('click', () => confirmObs(b.dataset.confirm, b)));

  $('#pf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button', e.target), async () => {
      const r = await api('POST', `/api/ingredients/${id}/prices`, Object.fromEntries(new FormData(e.target)));
      flash(r.observation.flag ? `Saved but not applied: ${r.observation.flag}. Accept it in history if correct.` : 'Price saved', !!r.observation.flag);
      reload();
    });
  });
  $('#ef').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button', e.target), async () => {
      await api('PUT', `/api/ingredients/${id}`, Object.fromEntries(new FormData(e.target)));
      flash('Details saved');
      reload();
    });
  });

  const krogerTable = (products, note = '') => {
    if (!products.length) return `<p class="muted">${note || 'No Kroger products found.'}</p>`;
    return `${note ? `<p class="text-xs mb-1">${note}</p>` : ''}
      <table><thead><tr><th>Kroger product</th><th class="text-right">Price</th><th>Size</th><th class="text-right">${unitLabel}</th><th></th></tr></thead>
      <tbody>${products.map((p, i) => `<tr data-p="${i}">
        <td>${esc(p.description)}<div class="text-xs muted">${esc(p.brand || '')}${p.promo_price ? ` · promo ${usd(p.promo_price)}` : ''}</div></td>
        <td class="num">${usd(p.price)}</td>
        <td class="whitespace-nowrap">${esc(p.size)}${p.price_per_base == null ? `<div class="flex gap-1 mt-1"><input data-q class="w-16" inputmode="decimal" placeholder="qty" aria-label="Pack quantity" value="${esc(p.quantity ?? '')}"><select data-u aria-label="Pack unit">${unitOptions(ing, p.unit || (ing.unit_type === 'count' ? 'each' : 'oz'))}</select></div>` : ''}</td>
        <td class="num">${usd(p.price_per_base)}</td>
        <td><button data-use="${i}" class="btn py-0">Use</button></td>
      </tr>`).join('')}</tbody></table>`;
  };
  const wireKroger = (products) => $$('[data-use]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const p = products[b.dataset.use];
    const row = b.closest('tr');
    const body = { product_id: p.product_id, description: `${p.description} ${p.size}`, price: p.price, quantity: p.quantity, unit: p.unit };
    if (p.price_per_base == null) Object.assign(body, { quantity: $('[data-q]', row).value, unit: $('[data-u]', row).value });
    const r = await api('POST', `/api/ingredients/${id}/kroger`, body);
    flash(r.observation.flag ? `Saved but not applied: ${r.observation.flag}` : 'Kroger price saved', !!r.observation.flag);
    reload();
  })));

  $('#k-go').addEventListener('click', (e) => act(e.target, async () => {
    $('#lookup').innerHTML = '<p class="muted">Searching Kroger...</p>';
    const r = await api('GET', `/api/ingredients/${id}/kroger?term=${encodeURIComponent($('#k-term').value)}`);
    $('#lookup').innerHTML = krogerTable(r.products, r.cached ? 'Cached result (up to 7 days old).' : '');
    wireKroger(r.products);
  }).finally(() => { if ($('#lookup').textContent === 'Searching Kroger...') $('#lookup').innerHTML = ''; }));

  const webEstimate = (btn, krogerNoMatch) => act(btn, async () => {
    $('#lookup').innerHTML = '<p class="muted">Searching the web. This can take up to a minute...</p>';
    try {
      const r = await api('POST', `/api/ingredients/${id}/web-estimate`, { kroger_no_match: krogerNoMatch });
      const html = `<p class="text-xs mb-1">Median ${usd(r.price_per_base)}${unitLabel} from ${r.offers.length} sourced offer(s)${r.cached ? ' (cached)' : ''}. ${r.ingredient.price_source === 'web_estimate' ? 'Accept or edit it above.' : `Not applied: the ${esc(r.ingredient.price_source)} price takes priority.`}</p>
        <table><thead><tr><th>Store</th><th class="text-right">Price</th><th class="text-right">${unitLabel}</th><th>Seen</th><th>Source</th></tr></thead>
        <tbody>${r.offers.map((o) => `<tr><td>${esc(o.store)}</td><td class="num">${usd(o.price)} <span class="muted">/ ${esc(o.quantity)} ${esc(o.unit)}</span></td>
          <td class="num">${usd(o.price_per_base)}</td><td class="text-xs font-mono">${esc(o.date)}</td>
          <td class="text-xs"><a href="${esc(o.source_url)}" target="_blank" rel="noopener noreferrer">${esc(o.source_url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))}</a></td></tr>`).join('')}</tbody></table>`;
      await reload();
      $('#lookup').innerHTML = html;
    } catch (e) {
      if (e.body?.error !== 'kroger_has_matches') {
        $('#lookup').innerHTML = '';
        throw e;
      }
      $('#lookup').innerHTML = `${krogerTable(e.body.products, 'Kroger has possible matches. Use one, or confirm none fit:')}
        <button id="w-force" class="btn mt-2">None of these match; estimate from web</button>`;
      wireKroger(e.body.products);
      $('#w-force').addEventListener('click', (ev) => webEstimate(ev.target, true));
    }
  });
  $('#w-go').addEventListener('click', (e) => webEstimate(e.target, false));
}

// ---------- Receipts ----------
async function pageReceipts() {
  const [list, status] = await Promise.all([api('GET', '/api/receipts'), api('GET', '/api/status')]);
  main.innerHTML = `
    <h1 class="mb-3">Receipts</h1>
    <form id="uf" class="flex flex-wrap gap-2 items-center panel p-3">
      <label for="u-file" class="sr-only">Receipt photo or PDF</label>
      <input id="u-file" name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" required class="max-w-full" ${status.anthropic.enabled ? '' : 'disabled'}>
      <button class="btn btn-primary" ${status.anthropic.enabled ? '' : 'disabled'}>Upload and read</button>
      <span class="text-xs muted w-full">${status.anthropic.enabled ? 'Photo or PDF, up to 5 MB. Nothing is saved until you review and confirm each line.' : esc(status.anthropic.message)}</span>
    </form>
    <h2>History</h2>
    <div class="scroll"><table><thead><tr><th>#</th><th>Store</th><th>Date</th><th>Status</th></tr></thead>
    <tbody>${list.map((r) => `<tr><td class="font-mono"><a href="#/receipt/${r.id}">${r.id}</a></td><td>${esc(r.store || '-')}</td>
      <td class="font-mono text-xs">${esc(r.date || '-')}</td>
      <td>${r.status === 'confirmed' ? 'confirmed' : `<a href="#/receipt/${r.id}" class="badge flag no-underline">needs review</a>`}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">No receipts yet.</td></tr>'}</tbody></table></div>`;

  $('#uf').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    act(btn, async () => {
      btn.textContent = 'Reading receipt...';
      const r = await api('POST', '/api/receipts', new FormData(e.target)).finally(() => { btn.textContent = 'Upload and read'; });
      location.hash = `#/receipt/${r.id}`;
    });
  });
}

async function pageReceipt(id) {
  const [r, ings] = await Promise.all([api('GET', `/api/receipts/${id}`), api('GET', '/api/ingredients')]);
  const done = r.status === 'confirmed';
  const lines = r.parsed.lines || [];
  const ingOptions = (sel, suggested) => `<option value="">New: ${esc(suggested)}</option>`
    + ings.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('');

  main.innerHTML = `
    <div class="flex flex-wrap items-baseline gap-2 mb-3">
      <h1 class="mr-auto"><a href="#/receipts">Receipts</a> / #${r.id}</h1>
      <a href="/api/receipts/${r.id}/image" target="_blank" rel="noopener">View original</a>
    </div>
    ${done ? '<p class="mb-3 px-2 py-1.5 border border-rule-2 bg-[#fafaf9]">Confirmed. Prices from this receipt are in each ingredient\'s history.</p>' : '<p class="text-xs muted mb-3">Check every line against the original. Fix anything wrong, untick lines that are not ingredients, then confirm.</p>'}
    <form id="cf">
      <fieldset ${done ? 'disabled' : ''} class="space-y-3">
        <div class="grid grid-cols-2 gap-2 max-w-md">
          <div class="field"><label for="c-store">Store</label><input id="c-store" name="store" value="${esc(r.store || '')}"></div>
          <div class="field"><label for="c-date">Date</label><input id="c-date" name="date" type="date" value="${esc(r.date || '')}"></div>
        </div>
        ${lines.map((l, i) => `<div data-line="${i}" class="panel p-2 grid grid-cols-2 sm:grid-cols-[auto_2fr_2fr_5rem_5rem_6rem] gap-2 items-end">
          <label class="col-span-2 sm:col-span-1 flex items-center gap-1.5 text-sm text-ink self-center"><input type="checkbox" data-k="include" checked> <span class="font-mono text-xs">${esc(l.name)}</span></label>
          <div class="field col-span-2 sm:col-span-1"><label>Ingredient</label><select data-k="ingredient_id">${ingOptions(l.match_ingredient_id, l.suggested_name)}</select></div>
          <div class="field col-span-2 sm:col-span-1" data-newname ${l.match_ingredient_id ? 'hidden' : ''}><label>New ingredient name</label><input data-k="new_name" value="${esc(l.suggested_name)}"></div>
          <div class="field"><label>Qty</label><input data-k="quantity" inputmode="decimal" value="${esc(l.quantity)}" class="text-right"></div>
          <div class="field"><label>Unit</label><select data-k="unit">${allUnitOptions(l.unit)}</select></div>
          <div class="field"><label>Total $</label><input data-k="total_price" inputmode="decimal" value="${esc(l.total_price)}" class="text-right"></div>
          ${l.note ? `<p class="col-span-full text-xs text-est">${esc(l.note)}</p>` : ''}
        </div>`).join('') || '<p class="muted">No line items were read from this receipt.</p>'}
        ${done ? '' : '<button class="btn btn-primary">Confirm and save prices</button>'}
      </fieldset>
    </form>`;

  $$('[data-k="ingredient_id"]').forEach((s) => s.addEventListener('change', () => {
    s.closest('[data-line]').querySelector('[data-newname]').hidden = !!s.value;
  }));
  $('#cf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('#cf button.btn-primary'), async () => {
      const body = {
        store: $('#c-store').value,
        date: $('#c-date').value,
        lines: $$('[data-line]').map((row) => {
          const v = (k) => $(`[data-k="${k}"]`, row);
          return {
            skip: !v('include').checked, ingredient_id: v('ingredient_id').value || null, new_name: v('new_name').value,
            quantity: v('quantity').value, unit: v('unit').value, total_price: v('total_price').value,
          };
        }),
      };
      const res = await api('POST', `/api/receipts/${id}/confirm`, body);
      flash(`Saved ${res.saved} price(s).${res.flagged.length ? ` Not applied (outside plausible range): ${res.flagged.map((f) => f.ingredient).join(', ')}. Review on Ingredients.` : ''}`, res.flagged.length > 0);
      pageReceipt(id);
    });
  });
}

// ---------- Settings ----------
async function pageSettings() {
  const [s, status] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/status')]);
  const rows = [['Receipt reading (Claude)', status.anthropic], ['Kroger prices', status.kroger], ['Web estimates (Perplexity)', status.perplexity]];
  main.innerHTML = `
    <h1 class="mb-3">Settings</h1>
    <form id="sf" class="grid grid-cols-2 sm:grid-cols-4 gap-2 max-w-xl">
      <div class="field"><label for="s-loc">Kroger store location ID</label><input id="s-loc" name="kroger_location_id" value="${esc(s.kroger_location_id)}" placeholder="e.g. 01400943"></div>
      <div class="field"><label for="s-margin">Default target margin %</label><input id="s-margin" name="target_margin_pct" inputmode="decimal" value="${esc(s.target_margin_pct)}"></div>
      <div class="flex items-end"><button class="btn btn-primary">Save</button></div>
    </form>
    <h2>Price sources</h2>
    <div class="scroll max-w-xl"><table><tbody>${rows.map(([label, st]) => `<tr><td>${label}</td>
      <td>${st.enabled ? '<span class="tag">on</span>' : '<span class="badge bad">off</span>'}</td>
      <td class="text-xs">${esc(st.message)}</td></tr>`).join('')}</tbody></table></div>
    <h2>Find your Kroger store</h2>
    <form id="zf" class="flex gap-2 items-end">
      <div class="field"><label for="z-zip">ZIP code</label><input id="z-zip" inputmode="numeric" maxlength="5" class="w-24" ${status.kroger.enabled ? '' : 'disabled'}></div>
      <button class="btn" ${status.kroger.enabled ? '' : 'disabled'}>Find stores</button>
    </form>
    <div id="locs" class="scroll mt-2"></div>`;

  $('#sf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button', e.target), async () => {
      await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
      flash('Settings saved');
    });
  });
  $('#zf').addEventListener('submit', (e) => {
    e.preventDefault();
    act($('button', e.target), async () => {
      const locs = await api('GET', `/api/kroger/locations?zip=${encodeURIComponent($('#z-zip').value)}`);
      $('#locs').innerHTML = locs.length ? `<table><thead><tr><th>ID</th><th>Store</th><th>Address</th><th></th></tr></thead><tbody>${locs.map((l) => `<tr>
        <td class="font-mono">${esc(l.location_id)}</td><td>${esc(l.name)}</td><td class="text-xs">${esc(l.address)}</td>
        <td><button class="btn py-0" data-loc="${esc(l.location_id)}">Use</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No stores near that ZIP.</p>';
      $$('[data-loc]').forEach((b) => b.addEventListener('click', () => {
        $('#s-loc').value = b.dataset.loc;
        $('#sf').requestSubmit();
      }));
    });
  });
}

// ---------- Router & keyboard ----------
const routes = {
  home: pageHome, recipes: pageRecipes, recipe: pageRecipe, ingredients: pageIngredients, ingredient: pageIngredient,
  receipts: pageReceipts, receipt: pageReceipt, settings: pageSettings,
};

async function route() {
  const [, page = 'home', id] = location.hash.split('/');
  const fn = routes[page] || pageHome;
  $$('[data-nav]').forEach((a) => {
    const on = page.startsWith(a.dataset.nav);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // App-wide: Kroger keys work but no store is chosen, so Kroger prices are silently off. Say so everywhere.
  api('GET', '/api/status').then((st) => {
    $('#notice').innerHTML = st.kroger.enabled && !st.kroger.store_set && page !== 'settings'
      ? `<p class="notice flag mt-4">Kroger is connected, but no store is chosen, so no Kroger prices are looked up. <a href="#/settings">Choose your store</a></p>` : '';
  }).catch(() => {});
  try {
    await fn(id);
  } catch (e) {
    main.innerHTML = `<p class="notice bad">${esc(e.message)}</p>`;
  }
}

window.addEventListener('hashchange', () => { flash(''); route(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const target = $('[data-search]') || $('main input:not([disabled])');
  if (target) {
    e.preventDefault();
    target.focus();
  }
});
route();
