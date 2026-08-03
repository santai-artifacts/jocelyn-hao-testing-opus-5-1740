# Mise — weekly meal planner

Plan a week of meals, then export a shopping list that's already been added up
and sorted by supermarket aisle.

## Running

```bash
npm start          # http://localhost:3000
```

No dependencies. Requires Node 22.5+ for the built-in `node:sqlite` module.

| Variable       | Default          | Purpose                     |
| -------------- | ---------------- | --------------------------- |
| `PORT`         | `3000`           | HTTP port                   |
| `HOST`         | `0.0.0.0`        | Bind address                |
| `DATABASE_URL` | `./data/app.db`  | SQLite file (created on boot)|

## How it works

- **Plan** — 7 days × breakfast / lunch / dinner. Drag a recipe from the library
  onto a slot, or tap the recipe then tap the slot (better on touch). Drag a
  planned meal to move it. Each meal has its own servings stepper.
- **Scaling** — a recipe stores its base servings. Planning it for more people
  scales every ingredient proportionally before the list is built.
- **Aggregation** — ingredients combine only within a compatible unit *family*,
  so 500 g + 1 kg becomes 1.5 kg, while "2 lemons" and "30 ml lemon juice" stay
  separate lines. Spoon measures are shown as fractions (`1½ tbsp`), and metric
  amounts roll up to kg / L past 1000.
- **Pantry** — mark a staple as already-owned and it drops off every future
  list until you put it back.
- **Export** — copy to clipboard, `.txt` (with checkboxes), `.csv` (one row per
  item, including which recipes need it), `.md` (full plan + list), or print a
  two-column list.

Ticked-off checkboxes are stored per week, so a shopping trip survives a reload.

## Layout

```
index.js      HTTP server, JSON API, export formatting
db.js         schema + recipe seeding (node:sqlite)
units.js      unit families, conversion, human-readable amounts
recipes.js    the 24 seeded recipes
public/       index.html, styles.css, app.js
```

## API

```
GET    /api/bootstrap                  recipes + aisles + slots
GET    /api/plan?week=YYYY-MM-DD       planned meals (week must be a Monday)
POST   /api/plan                       { week, day, slot, recipeId, servings }
PATCH  /api/plan/:id                   { servings } and/or { day, slot }
DELETE /api/plan/:id
POST   /api/plan/clear                 { week }
POST   /api/plan/autofill              { week, servings?, slots? }
POST   /api/plan/copy                  { from, to }
GET    /api/shopping-list?week=…       aggregated, aisle-grouped
POST   /api/shopping-list/check        { week, key, checked }
POST   /api/shopping-list/reset        { week }
POST   /api/pantry                     { name }
DELETE /api/pantry?name=…
GET    /api/export?week=…&format=txt|csv|md
```
