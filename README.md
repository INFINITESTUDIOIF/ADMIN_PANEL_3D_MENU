# Little French House — Menu Editor (private, local only)

A small local tool to edit the whole menu: dishes, categories, and filters.
Changes are saved straight to Supabase, so they appear on the live site
immediately — no redeploy.

## ⚠️ Never deploy this

This tool uses the Supabase **service-role key** (full admin, no login). It is
excluded from Vercel via the project's `../.vercelignore`. Run it only on your
own machine. Do not host it anywhere public.

## Run it

Easiest: double-click **START.BAT** (installs dependencies the first time,
starts the server, opens the editor).

Or by hand:

```bash
cd editor
npm install        # one time
node server.js     # → http://localhost:4001
```

It reads the Supabase URL and service-role key from the project's
`../.env.local` — the same file the rest of the project uses. Nothing secret
is stored inside this folder.

## What you can edit

- **Dishes** — name, price, image, category, veg flag, filter tags, the 4D
  toggle (cyan glow outline), both GLB model URLs, descriptions, rating, prep
  time, nutrition, ingredients, reviews, related dishes, order.
- **Categories** — name in all 6 languages, icon, colour, order, show/hide.
- **Filters** — name in all 6 languages, emoji, order, show/hide.

Create, edit, and delete any of them. Every change saves instantly.
