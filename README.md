# Costbook

Recipe unit-cost app for small food businesses. Enter recipes by weight, get cost per piece or box and margin at your selling price. Built for an Indian sweets shop, so ghee, khoya, elaichi, kesar, kaju, varq and besan are first-class.

## Run

```
npm install && npm start
```

Open http://localhost:3000. The app ships with three sample recipes (kaju katli, besan ladoo, gulab jamun) whose prices are marked `sample data`.

Copy `.env.example` to `.env` and fill in whichever keys you have. Every key is optional: a missing key turns that price source off, and Settings says which ones are off.

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Reading receipt photos and PDFs (Claude vision) |
| `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` | Kroger product prices |
| `PERPLEXITY_API_KEY` | Web price estimates (last resort) |
| `PORT` | Server port, default 3000 |
| `DATA_DIR` | Where the database and uploads live, default `./data` |

Tests: `npm test` (unit conversions, cost formula, reverse pricing, sanity ranges, matching).

## How prices work

All prices are stored as $/kg, or $/each for count items like varq sheets. Every price ever seen is kept in `price_observations`; the ingredient's current price is chosen from that history:

1. Newest confirmed **receipt** or **manual** price
2. Otherwise the newest **Kroger** price you picked
3. Otherwise a **web estimate**, which must be accepted before it counts in any recipe total

Prices outside a plausible range for that ingredient (for example ghee above $35/kg) are saved but not applied until you accept them in the price history. Volume units (ml, cup, tbsp) only work for ghee, milk, oil, water and sugar syrup; for everything else enter a weight.

In the recipe editor you can type a rough description instead of a known ingredient (for example "Maggi 2 bricks" or "a handful of pista") and press Enter. Perplexity identifies the ingredient, converts the amount to grams (looking up pack weights with a source), and finds sourced prices. Nothing is saved until you click Use, and any web price still has to be accepted before it counts. "Figure out all" sends every unknown row in one Perplexity request. When a Kroger store is chosen in Settings, each suggestion lists matching Kroger products to pick from; web estimates are only the fallback.

Recipes show what share of their cost comes from receipt or manual prices, and flag any line using a Kroger price, a web estimate, or an unconfirmed price.

## Home dashboard and "Update prices"

Home (the start page) shows each item's cost against its selling price, what you keep, which ingredients cost the most, and anything that needs checking (new prices waiting for your OK, ingredients with no price, prices over 3 months old). It reads only saved data and never calls an outside service.

Online prices change only when you press **Update prices**. That looks up today's price for every ingredient used in a recipe whose price came from Kroger (free API) or a web estimate (paid Perplexity credit; you are asked first). Receipt and manual prices are left alone. New Kroger prices apply right away unless they look out of range; new web prices wait for "Use this price" on Home.

## Cost math

```
batch_cost    = sum(quantity_kg x price_per_kg)
cost_per_unit = (batch_cost / yield_units) x (1 + waste_pct/100) + packaging_cost_per_unit
margin_pct    = (selling_price - cost_per_unit) / selling_price
price for target margin m = cost_per_unit / (1 - m)
```

## Keyboard

`/` focuses the filter or first field, Enter submits any form, and Tab follows the visual order.

## Files

- `server.js`: Express API and static files
- `db.js`: SQLite schema, seed data, price waterfall
- `lib/pricing.js`: units, cost math, sanity ranges (pure, unit tested)
- `lib/sources.js`: Claude, Kroger and Perplexity clients
- `public/`: the whole frontend (`index.html`, `app.js`, Tailwind from CDN)

## Backup

Everything is in `data/costbook.db` plus receipt images in `data/uploads/`. Copy the `data` folder to back up.
