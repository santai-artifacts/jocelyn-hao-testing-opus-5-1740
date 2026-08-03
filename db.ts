import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RECIPES } from "./recipes";

const dbPath = process.env.DATABASE_URL || `${import.meta.dir}/data/app.db`;
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    slots TEXT NOT NULL DEFAULT 'dinner',
    servings INTEGER NOT NULL DEFAULT 2,
    minutes INTEGER NOT NULL DEFAULT 30,
    tags TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    aisle TEXT NOT NULL DEFAULT 'Pantry'
  );
  CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id);

  -- One row per planned meal. week_start is the Monday, day is 0..6.
  CREATE TABLE IF NOT EXISTS plan_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    day INTEGER NOT NULL,
    slot TEXT NOT NULL,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    servings INTEGER NOT NULL DEFAULT 2,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_plan_week ON plan_entries(week_start);

  -- Staples the shopper already owns; excluded from the list.
  CREATE TABLE IF NOT EXISTS pantry (
    name TEXT PRIMARY KEY
  );

  -- Ticked-off checkboxes, kept per week so a shopping trip survives a reload.
  CREATE TABLE IF NOT EXISTS list_state (
    week_start TEXT NOT NULL,
    item_key TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week_start, item_key)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const SEED_VERSION = "1";

function seed() {
  const current = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'seed_version'")
    .get();
  if (current?.value === SEED_VERSION) return;

  const insertRecipe = db.prepare(
    `INSERT INTO recipes (name, emoji, slots, servings, minutes, tags, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       emoji = excluded.emoji, slots = excluded.slots, servings = excluded.servings,
       minutes = excluded.minutes, tags = excluded.tags, description = excluded.description
     RETURNING id`,
  );
  const clearIngredients = db.prepare("DELETE FROM ingredients WHERE recipe_id = ?");
  const insertIngredient = db.prepare(
    "INSERT INTO ingredients (recipe_id, name, quantity, unit, aisle) VALUES (?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (const r of RECIPES) {
      const row = insertRecipe.get(
        r.name, r.emoji, r.slots, r.servings, r.minutes, r.tags, r.description,
      ) as { id: number };
      clearIngredients.run(row.id);
      for (const [name, quantity, unit, aisle] of r.ingredients) {
        insertIngredient.run(row.id, name, quantity, unit, aisle);
      }
    }
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('seed_version', ?)").run(
      SEED_VERSION,
    );
  })();
}

seed();

export default db;
