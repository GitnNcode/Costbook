# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner of a family Indian sweets shop in the US, who runs pricing and inventory, plus family members with mixed comfort with apps. Recipes and prices are mostly entered on a laptop at a desk. Phones are used in the shop to check costs and margins. The interface has to be obvious without explanation.

## Product Purpose

Turn recipes (ingredients by weight, batch yield) into an accurate cost per piece or box and a margin at the selling price, so the shop prices its sweets with confidence. Success: every recipe's cost rests on real receipt or manual prices, and margins below target are impossible to miss.

## Positioning

Prices come from a sourced waterfall (receipts and invoices, then manual entry, then Kroger, then a web estimate that is always marked and must be accepted). AI reads receipts, matches ingredient names and finds web estimates, but never invents a price without a source. Indian ingredients (ghee, khoya, elaichi, kesar, kaju, varq, besan) are first-class.

## Operating Context

- Recipe entry at a laptop, often from memory, with informal amounts ("Maggi 2 bricks", "2 handful peas").
- Receipt photos and supplier PDFs uploaded after shopping.
- Quick margin checks on a phone at 375px in the shop.

## Capabilities and Constraints

- Vanilla HTML + JavaScript + Tailwind via CDN, no frontend build step. Node/Express + SQLite backend. API keys stay server-side.
- Every external source is optional; a missing key disables that source with a clear message.
- No auth, payments, dark mode or extra features.
- Keyboard: Tab order works, Enter submits, `/` focuses search.

## Brand Commitments

From the original brief (binding): minimal light mode that must not look AI-generated. No gradients, glassy cards, emoji or purple. Neutral grays, one accent color. Editing screens stay functional, like a clean spreadsheet; Home is a friendly dashboard with large type (16px base), big buttons and plain words, so an older family member running the business can read it at a glance.

## Evidence on Hand

Three clearly labeled sample recipes (kaju katli, besan ladoo, gulab jamun) with sample prices. No real shop data, testimonials or brand assets yet; do not fabricate them.

## Product Principles

1. Every number shows where it came from.
2. Estimates are visibly different from real prices and never silently counted.
3. Entering a recipe should feel like filling in a spreadsheet, not a form.
4. Plain words over jargon; family members should not need training.
