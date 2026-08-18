import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import db, { tx } from "./db.js";
import { AISLES } from "./recipes.js";
import { familyOf, formatTotal, normalizeUnit, toBase } from "./units.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const SLOTS = ["breakfast", "lunch", "dinner"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/* ------------------------------------------------------------------ helpers */

const json = (data, status = 200) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

const bad = (message, status = 400) => json({ error: message }, status);

const text = (body, contentType, filename) => ({
  status: 200,
  headers: {
    "content-type": `${contentType}; charset=utf-8`,
    "content-disposition": `attachment; filename="${filename}"`,
  },
  body,
});

/** Validate a YYYY-MM-DD Monday. Anything else is rejected rather than guessed. */
function parseWeek(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCDay() !== 1 // must be a Monday
  ) {
    return null;
  }
  return value;
}

function titleCase(s) {
  return String(s).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function dateForDay(week, day) {
  const [y, m, d] = week.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + day)).toISOString().slice(0, 10);
}

function clampServings(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(24, Math.max(1, Math.round(n)));
}

/* ------------------------------------------------------------------ queries */

const qRecipes = db.prepare("SELECT * FROM recipes ORDER BY name");
const qIngredients = db.prepare(
  "SELECT recipe_id, name, quantity, unit, aisle FROM ingredients ORDER BY id",
);
const qRecipeById = db.prepare("SELECT id, servings FROM recipes WHERE id = ?");

const qPlan = db.prepare(`
  SELECT p.id, p.day, p.slot, p.servings, p.recipe_id,
         r.name, r.emoji, r.minutes, r.servings AS base_servings, r.tags
  FROM plan_entries p
  JOIN recipes r ON r.id = p.recipe_id
  WHERE p.week_start = ?
  ORDER BY p.day, p.position, p.id
`);

const qPlanIngredients = db.prepare(`
  SELECT i.name AS ing, i.quantity, i.unit, i.aisle,
         r.name AS recipe, p.servings AS want, r.servings AS base
  FROM plan_entries p
  JOIN recipes r ON r.id = p.recipe_id
  JOIN ingredients i ON i.recipe_id = r.id
  WHERE p.week_start = ?
`);

const qPantry = db.prepare("SELECT name FROM pantry ORDER BY name");
const qListState = db.prepare("SELECT item_key, checked FROM list_state WHERE week_start = ?");

const qQuickShop = db.prepare(`
  SELECT qs.id, qs.recipe_id, qs.servings,
         r.name, r.emoji, r.minutes, r.servings AS base_servings
  FROM quick_shop qs JOIN recipes r ON r.id = qs.recipe_id ORDER BY qs.id
`);
const qQuickShopIngredients = db.prepare(`
  SELECT i.name AS ing, i.quantity, i.unit, i.aisle,
         r.name AS recipe, qs.servings AS want, r.servings AS base
  FROM quick_shop qs JOIN recipes r ON r.id = qs.recipe_id
  JOIN ingredients i ON i.recipe_id = r.id
`);

function allRecipes() {
  const byId = new Map();
  for (const r of qRecipes.all()) {
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      slots: r.slots.split(",").map((s) => s.trim()).filter(Boolean),
      servings: r.servings,
      minutes: r.minutes,
      tags: r.tags ? r.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
      description: r.description,
      ingredients: [],
    });
  }
  for (const i of qIngredients.all()) {
    const recipe = byId.get(i.recipe_id);
    if (!recipe) continue;
    recipe.ingredients.push({
      name: i.name,
      label: titleCase(i.name),
      quantity: i.quantity,
      unit: normalizeUnit(i.unit),
      aisle: i.aisle,
    });
  }
  return [...byId.values()];
}

/* --------------------------------------------------------- shopping list */

function buildList(week) {
  const pantry = new Set(qPantry.all().map((r) => r.name));
  const checked = new Map(qListState.all(week).map((r) => [r.item_key, !!r.checked]));

  const acc = new Map();
  const allIngRows = [...qPlanIngredients.all(week), ...qQuickShopIngredients.all()];
  for (const row of allIngRows) {
    // Scale each ingredient by how many servings the cook actually planned.
    const scale = row.base > 0 ? row.want / row.base : 1;
    const unit = normalizeUnit(row.unit);
    const family = familyOf(unit);
    const key = `${row.ing}|${family}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        name: row.ing, aisle: row.aisle, family,
        total: 0, units: new Set(), recipes: new Set(),
      };
      acc.set(key, entry);
    }
    entry.total += toBase(row.quantity * scale, unit);
    entry.units.add(unit);
    entry.recipes.add(row.recipe);
  }

  const items = [];
  const skipped = [];
  for (const [key, e] of acc) {
    if (pantry.has(e.name)) {
      skipped.push(titleCase(e.name));
      continue;
    }
    const fmt = formatTotal(e.total, e.family, e.units);
    items.push({
      key,
      name: e.name,
      label: titleCase(e.name),
      aisle: e.aisle,
      display: fmt.display,
      quantity: fmt.quantity,
      unit: fmt.unit,
      recipes: [...e.recipes].sort(),
      checked: checked.get(key) ?? false,
    });
  }

  const order = new Map(AISLES.map((a, i) => [a, i]));
  const groups = [...new Set(items.map((i) => i.aisle))]
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
    .map((aisle) => ({
      aisle,
      items: items
        .filter((i) => i.aisle === aisle)
        .sort((a, b) => a.label.localeCompare(b.label)),
    }));

  const plan = qPlan.all(week);
  const quickShop = qQuickShop.all();
  return {
    weekStart: week,
    groups,
    itemCount: items.length,
    checkedCount: items.filter((i) => i.checked).length,
    mealCount: plan.length,
    recipeCount: new Set(plan.map((p) => p.recipe_id)).size,
    quickShop,
    pantrySkipped: skipped.sort(),
    pantry: [...pantry].map(titleCase).sort(),
  };
}

/* ---------------------------------------------------------------- exports */

function weekLabel(week) {
  const [y, m, d] = week.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const f = (dt) =>
    dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}, ${end.getUTCFullYear()}`;
}

function exportText(week) {
  const list = buildList(week);
  const lines = [
    "SHOPPING LIST",
    `Week of ${weekLabel(week)}`,
    `${list.itemCount} items · ${list.mealCount} meals planned`,
    "",
  ];
  if (list.groups.length === 0) lines.push("(nothing planned yet)", "");
  for (const g of list.groups) {
    lines.push(g.aisle.toUpperCase(), "-".repeat(g.aisle.length));
    for (const item of g.items) {
      lines.push(`[${item.checked ? "x" : " "}] ${item.label} — ${item.display}`);
    }
    lines.push("");
  }
  if (list.pantrySkipped.length) {
    lines.push(`Skipped (already in pantry): ${list.pantrySkipped.join(", ")}`, "");
  }

  const plan = qPlan.all(week);
  if (plan.length) {
    lines.push("MEAL PLAN", "=========", "");
    for (let day = 0; day < 7; day++) {
      const meals = plan.filter((p) => p.day === day);
      if (!meals.length) continue;
      lines.push(`${DAYS[day]} ${dateForDay(week, day)}`);
      for (const slot of SLOTS) {
        for (const m of meals.filter((x) => x.slot === slot)) {
          lines.push(`  ${slot.padEnd(9)} ${m.name} (${m.servings} servings)`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(week) {
  const list = buildList(week);
  const rows = [["Aisle", "Item", "Quantity", "Unit", "Amount", "Used in", "Bought"]];
  for (const g of list.groups) {
    for (const item of g.items) {
      rows.push([
        g.aisle, item.label, item.quantity, item.unit,
        item.display, item.recipes.join("; "), item.checked ? "yes" : "no",
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

function exportMarkdown(week) {
  const list = buildList(week);
  const out = [
    `# Meal plan — week of ${weekLabel(week)}`,
    "",
    `${list.mealCount} meals · ${list.recipeCount} recipes · ${list.itemCount} shopping items`,
    "",
  ];
  const plan = qPlan.all(week);
  for (let day = 0; day < 7; day++) {
    const meals = plan.filter((p) => p.day === day);
    out.push(`### ${DAYS[day]}`);
    if (!meals.length) {
      out.push("_nothing planned_", "");
      continue;
    }
    for (const slot of SLOTS) {
      for (const m of meals.filter((x) => x.slot === slot)) {
        out.push(
          `- **${titleCase(slot)}** — ${m.emoji} ${m.name} · ${m.servings} servings · ${m.minutes} min`,
        );
      }
    }
    out.push("");
  }
  out.push("## Shopping list", "");
  if (!list.groups.length) out.push("_nothing to buy_", "");
  for (const g of list.groups) {
    out.push(`### ${g.aisle}`);
    for (const item of g.items) {
      out.push(`- [${item.checked ? "x" : " "}] ${item.label} — ${item.display}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/* ----------------------------------------------------------------- routes */

function handleApi(method, url, body) {
  const path = url.pathname;

  if (path === "/api/bootstrap" && method === "GET") {
    return json({ recipes: allRecipes(), aisles: AISLES, slots: SLOTS });
  }

  if (path === "/api/plan" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    return json({ weekStart: week, entries: qPlan.all(week) });
  }

  if (path === "/api/plan" && method === "POST") {
    if (!body) return bad("invalid JSON body");
    const week = parseWeek(body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return bad("day must be 0-6");
    if (!SLOTS.includes(body.slot)) return bad(`slot must be one of ${SLOTS.join(", ")}`);
    const recipe = qRecipeById.get(Number(body.recipeId));
    if (!recipe) return bad("unknown recipe", 404);
    const servings = clampServings(body.servings, recipe.servings);
    const maxPos = db
      .prepare(
        "SELECT MAX(position) AS n FROM plan_entries WHERE week_start = ? AND day = ? AND slot = ?",
      )
      .get(week, day, body.slot);
    const position = (maxPos && maxPos.n != null ? Number(maxPos.n) : -1) + 1;
    const row = db
      .prepare(
        `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(week, day, body.slot, recipe.id, servings, position);
    return json({ id: row.id, entries: qPlan.all(week) }, 201);
  }

  const entryMatch = path.match(/^\/api\/plan\/(\d+)$/);
  if (entryMatch) {
    const id = Number(entryMatch[1]);
    const existing = db.prepare("SELECT week_start FROM plan_entries WHERE id = ?").get(id);
    if (!existing) return bad("unknown plan entry", 404);

    if (method === "PATCH") {
      if (!body) return bad("invalid JSON body");
      if (body.servings !== undefined) {
        db.prepare("UPDATE plan_entries SET servings = ? WHERE id = ?")
          .run(clampServings(body.servings, 2), id);
      }
      // Moving a meal to another day/slot (drag between cells).
      if (body.day !== undefined || body.slot !== undefined) {
        const day = Number(body.day);
        if (!Number.isInteger(day) || day < 0 || day > 6) return bad("day must be 0-6");
        if (!SLOTS.includes(body.slot)) return bad(`slot must be one of ${SLOTS.join(", ")}`);
        db.prepare("UPDATE plan_entries SET day = ?, slot = ? WHERE id = ?")
          .run(day, body.slot, id);
      }
      return json({ entries: qPlan.all(existing.week_start) });
    }

    if (method === "DELETE") {
      db.prepare("DELETE FROM plan_entries WHERE id = ?").run(id);
      return json({ entries: qPlan.all(existing.week_start) });
    }
  }

  if (path === "/api/plan/clear" && method === "POST") {
    const week = parseWeek(body && body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    tx(() => {
      db.prepare("DELETE FROM plan_entries WHERE week_start = ?").run(week);
      db.prepare("DELETE FROM list_state WHERE week_start = ?").run(week);
    });
    return json({ entries: [] });
  }

  if (path === "/api/plan/autofill" && method === "POST") {
    const week = parseWeek(body && body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const defaultServings = clampServings(body && body.servings, 2);
    const which = Array.isArray(body && body.slots)
      ? body.slots.filter((s) => SLOTS.includes(s))
      : SLOTS.slice();

    const taken = new Set(qPlan.all(week).map((p) => `${p.day}:${p.slot}`));
    const pool = allRecipes();
    const insert = db.prepare(
      `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );

    let added = 0;
    tx(() => {
      for (const slot of which) {
        // Shuffle per slot and walk the deck so a week doesn't repeat a recipe
        // until the candidates run out.
        const candidates = pool.filter((r) => r.slots.includes(slot));
        if (!candidates.length) continue;
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        let cursor = 0;
        for (let day = 0; day < 7; day++) {
          if (taken.has(`${day}:${slot}`)) continue;
          const pick = candidates[cursor % candidates.length];
          cursor++;
          insert.run(week, day, slot, pick.id, defaultServings);
          added++;
        }
      }
    });

    return json({ added, entries: qPlan.all(week) });
  }

  if (path === "/api/plan/copy" && method === "POST") {
    const to = parseWeek(body && body.to);
    const from = parseWeek(body && body.from);
    if (!to || !from) return bad("from and to must be Mondays in YYYY-MM-DD form");
    const source = qPlan.all(from);
    if (!source.length) return bad("that week has no meals to copy", 404);
    const insert = db.prepare(
      `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    tx(() => {
      db.prepare("DELETE FROM plan_entries WHERE week_start = ?").run(to);
      source.forEach((e, i) => insert.run(to, e.day, e.slot, e.recipe_id, e.servings, i));
    });
    return json({ copied: source.length, entries: qPlan.all(to) });
  }

  if (path === "/api/shopping-list" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    return json(buildList(week));
  }

  if (path === "/api/shopping-list/check" && method === "POST") {
    const week = parseWeek(body && body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    if (typeof body.key !== "string" || !body.key) return bad("key is required");
    db.prepare(
      `INSERT INTO list_state (week_start, item_key, checked) VALUES (?, ?, ?)
       ON CONFLICT(week_start, item_key) DO UPDATE SET checked = excluded.checked`,
    ).run(week, body.key, body.checked ? 1 : 0);
    return json({ ok: true });
  }

  if (path === "/api/shopping-list/reset" && method === "POST") {
    const week = parseWeek(body && body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    db.prepare("DELETE FROM list_state WHERE week_start = ?").run(week);
    return json({ ok: true });
  }

  if (path === "/api/pantry" && method === "POST") {
    const name = String((body && body.name) || "").trim().toLowerCase();
    if (!name) return bad("name is required");
    db.prepare("INSERT OR IGNORE INTO pantry (name) VALUES (?)").run(name);
    return json({ ok: true });
  }

  if (path === "/api/pantry" && method === "DELETE") {
    const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
    if (!name) return bad("name is required");
    db.prepare("DELETE FROM pantry WHERE name = ?").run(name);
    return json({ ok: true });
  }

  if (path === "/api/quick-shop" && method === "GET") {
    return json({ entries: qQuickShop.all() });
  }

  if (path === "/api/quick-shop" && method === "POST") {
    if (!body) return bad("invalid JSON body");
    const recipe = qRecipeById.get(Number(body.recipeId));
    if (!recipe) return bad("unknown recipe", 404);
    const servings = clampServings(body.servings, recipe.servings);
    const existing = db.prepare("SELECT id FROM quick_shop WHERE recipe_id = ?").get(recipe.id);
    if (existing) {
      db.prepare("UPDATE quick_shop SET servings = ? WHERE id = ?").run(servings, existing.id);
      return json({ id: existing.id });
    }
    const row = db.prepare("INSERT INTO quick_shop (recipe_id, servings) VALUES (?, ?) RETURNING id")
      .get(recipe.id, servings);
    return json({ id: row.id }, 201);
  }

  if (path === "/api/quick-shop" && method === "DELETE") {
    db.prepare("DELETE FROM quick_shop").run();
    return json({ ok: true });
  }

  const qsMatch = path.match(/^\/api\/quick-shop\/(\d+)$/);
  if (qsMatch) {
    const id = Number(qsMatch[1]);
    if (method === "DELETE") {
      db.prepare("DELETE FROM quick_shop WHERE id = ?").run(id);
      return json({ ok: true });
    }
  }

  if (path === "/api/export" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const format = url.searchParams.get("format") || "txt";
    if (format === "txt") return text(exportText(week), "text/plain", `shopping-list-${week}.txt`);
    if (format === "csv") return text(exportCsv(week), "text/csv", `shopping-list-${week}.csv`);
    if (format === "md") return text(exportMarkdown(week), "text/markdown", `meal-plan-${week}.md`);
    return bad("format must be txt, csv, or md");
  }

  return bad("not found", 404);
}

/* ----------------------------------------------------------- static files */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolve a request path inside PUBLIC_DIR, refusing anything that escapes it. */
function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = decoded === "/" || decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  const full = resolve(join(PUBLIC_DIR, normalize(candidate)));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return null;
  return full;
}

async function serveStatic(pathname, res) {
  let full = safePath(pathname);
  if (full) {
    try {
      const info = await stat(full);
      if (info.isDirectory()) full = join(full, "index.html");
    } catch {
      full = null;
    }
  }
  // Unknown path: fall back to the single page so client routing still works.
  if (!full) full = join(PUBLIC_DIR, "index.html");

  try {
    const info = await stat(full);
    res.writeHead(200, {
      "content-type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
    });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

/* ------------------------------------------------------------------ server */

const MAX_BODY = 1_000_000;

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(url.pathname, res);
      return;
    }

    let parsed = null;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      const raw = await readBody(req);
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }
    }

    const out = handleApi(req.method, url, parsed);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mise meal planner listening on http://${HOST}:${PORT}`);
});
