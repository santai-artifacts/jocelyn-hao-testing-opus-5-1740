import db from "./db";
import { AISLES } from "./recipes";
import { familyOf, formatTotal, normalizeUnit, toBase } from "./units";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = `${import.meta.dir}/public`;
const SLOTS = ["breakfast", "lunch", "dinner"] as const;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/* ------------------------------------------------------------------ helpers */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const bad = (message: string, status = 400) => json({ error: message }, status);

/** Validate a YYYY-MM-DD Monday. Anything else is rejected rather than guessed. */
function parseWeek(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
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

function titleCase(s: string) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function dateForDay(week: string, day: number) {
  const [y, m, d] = week.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + day));
  return dt.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ queries */

type RecipeRow = {
  id: number; name: string; emoji: string; slots: string;
  servings: number; minutes: number; tags: string; description: string;
};

const qRecipes = db.query<RecipeRow, []>("SELECT * FROM recipes ORDER BY name");
const qIngredients = db.query<
  { recipe_id: number; name: string; quantity: number; unit: string; aisle: string },
  []
>("SELECT recipe_id, name, quantity, unit, aisle FROM ingredients ORDER BY id");

function allRecipes() {
  const byId = new Map<number, RecipeRow & { ingredients: unknown[] }>();
  for (const r of qRecipes.all()) {
    byId.set(r.id, {
      ...r,
      slots: r.slots.split(",").map((s) => s.trim()) as unknown as string,
      tags: r.tags ? (r.tags.split(",") as unknown as string) : ("" as unknown as string),
      ingredients: [],
    });
  }
  for (const i of qIngredients.all()) {
    byId.get(i.recipe_id)?.ingredients.push({
      name: i.name,
      label: titleCase(i.name),
      quantity: i.quantity,
      unit: normalizeUnit(i.unit),
      aisle: i.aisle,
    });
  }
  return [...byId.values()];
}

const qPlan = db.query<
  {
    id: number; day: number; slot: string; servings: number; recipe_id: number;
    name: string; emoji: string; minutes: number; base_servings: number; tags: string;
  },
  [string]
>(`
  SELECT p.id, p.day, p.slot, p.servings, p.recipe_id,
         r.name, r.emoji, r.minutes, r.servings AS base_servings, r.tags
  FROM plan_entries p
  JOIN recipes r ON r.id = p.recipe_id
  WHERE p.week_start = ?
  ORDER BY p.day, p.position, p.id
`);

/* --------------------------------------------------------- shopping list */

type ListItem = {
  key: string; name: string; label: string; aisle: string;
  display: string; quantity: number; unit: string;
  recipes: string[]; checked: boolean;
};

const qPlanIngredients = db.query<
  {
    ing: string; quantity: number; unit: string; aisle: string;
    recipe: string; want: number; base: number;
  },
  [string]
>(`
  SELECT i.name AS ing, i.quantity, i.unit, i.aisle,
         r.name AS recipe, p.servings AS want, r.servings AS base
  FROM plan_entries p
  JOIN recipes r ON r.id = p.recipe_id
  JOIN ingredients i ON i.recipe_id = r.id
  WHERE p.week_start = ?
`);

function buildList(week: string) {
  const pantry = new Set(
    db.query<{ name: string }, []>("SELECT name FROM pantry").all().map((r) => r.name),
  );
  const checked = new Map(
    db
      .query<{ item_key: string; checked: number }, [string]>(
        "SELECT item_key, checked FROM list_state WHERE week_start = ?",
      )
      .all(week)
      .map((r) => [r.item_key, !!r.checked] as const),
  );

  type Acc = {
    name: string; aisle: string; family: string; total: number;
    units: Set<string>; recipes: Set<string>;
  };
  const acc = new Map<string, Acc>();

  for (const row of qPlanIngredients.all(week)) {
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

  const items: ListItem[] = [];
  const skipped: string[] = [];
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

  const order = new Map(AISLES.map((a, i) => [a, i] as const));
  const groups = [...new Set(items.map((i) => i.aisle))]
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
    .map((aisle) => ({
      aisle,
      items: items.filter((i) => i.aisle === aisle).sort((a, b) => a.label.localeCompare(b.label)),
    }));

  const plan = qPlan.all(week);
  return {
    weekStart: week,
    groups,
    itemCount: items.length,
    checkedCount: items.filter((i) => i.checked).length,
    mealCount: plan.length,
    recipeCount: new Set(plan.map((p) => p.recipe_id)).size,
    pantrySkipped: skipped.sort(),
    pantry: [...pantry].map(titleCase).sort(),
  };
}

/* ---------------------------------------------------------------- exports */

function weekLabel(week: string) {
  const [y, m, d] = week.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const f = (dt: Date) =>
    dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}, ${end.getUTCFullYear()}`;
}

function exportText(week: string) {
  const list = buildList(week);
  const lines = [
    "SHOPPING LIST",
    `Week of ${weekLabel(week)}`,
    `${list.itemCount} items · ${list.mealCount} meals planned`,
    "",
  ];
  if (list.groups.length === 0) {
    lines.push("(nothing planned yet)");
  }
  for (const g of list.groups) {
    lines.push(g.aisle.toUpperCase());
    lines.push("-".repeat(g.aisle.length));
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
    lines.push("MEAL PLAN", "=".repeat(9), "");
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

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function exportCsv(week: string) {
  const list = buildList(week);
  const rows = [["Aisle", "Item", "Quantity", "Unit", "Amount", "Used in", "Bought"]];
  for (const g of list.groups) {
    for (const item of g.items) {
      rows.push([
        g.aisle,
        item.label,
        String(item.quantity),
        item.unit,
        item.display,
        item.recipes.join("; "),
        item.checked ? "yes" : "no",
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

function exportMarkdown(week: string) {
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
        out.push(`- **${titleCase(slot)}** — ${m.emoji} ${m.name} · ${m.servings} servings · ${m.minutes} min`);
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

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/bootstrap" && method === "GET") {
    return json({ recipes: allRecipes(), aisles: AISLES, slots: SLOTS });
  }

  if (path === "/api/plan" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    return json({ weekStart: week, entries: qPlan.all(week) });
  }

  if (path === "/api/plan" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    if (!body) return bad("invalid JSON body");
    const week = parseWeek(body.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return bad("day must be 0-6");
    if (!SLOTS.includes(body.slot)) return bad(`slot must be one of ${SLOTS.join(", ")}`);
    const recipe = db
      .query<{ id: number; servings: number }, [number]>(
        "SELECT id, servings FROM recipes WHERE id = ?",
      )
      .get(Number(body.recipeId));
    if (!recipe) return bad("unknown recipe", 404);
    const servings = Math.min(24, Math.max(1, Number(body.servings) || recipe.servings));
    const position =
      (db
        .query<{ n: number | null }, [string, number, string]>(
          "SELECT MAX(position) AS n FROM plan_entries WHERE week_start = ? AND day = ? AND slot = ?",
        )
        .get(week, day, body.slot)?.n ?? -1) + 1;
    const row = db
      .query<{ id: number }, [string, number, string, number, number, number]>(
        `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(week, day, body.slot, recipe.id, servings, position);
    return json({ id: row!.id, entries: qPlan.all(week) }, 201);
  }

  const entryMatch = path.match(/^\/api\/plan\/(\d+)$/);
  if (entryMatch) {
    const id = Number(entryMatch[1]);
    const existing = db
      .query<{ week_start: string }, [number]>("SELECT week_start FROM plan_entries WHERE id = ?")
      .get(id);
    if (!existing) return bad("unknown plan entry", 404);

    if (method === "PATCH") {
      const body = (await req.json().catch(() => null)) as any;
      if (!body) return bad("invalid JSON body");
      if (body.servings !== undefined) {
        const servings = Math.min(24, Math.max(1, Number(body.servings) || 1));
        db.query("UPDATE plan_entries SET servings = ? WHERE id = ?").run(servings, id);
      }
      // Moving a meal to another day/slot (drag between cells).
      if (body.day !== undefined || body.slot !== undefined) {
        const day = Number(body.day);
        if (!Number.isInteger(day) || day < 0 || day > 6) return bad("day must be 0-6");
        if (!SLOTS.includes(body.slot)) return bad(`slot must be one of ${SLOTS.join(", ")}`);
        db.query("UPDATE plan_entries SET day = ?, slot = ? WHERE id = ?").run(day, body.slot, id);
      }
      return json({ entries: qPlan.all(existing.week_start) });
    }

    if (method === "DELETE") {
      db.query("DELETE FROM plan_entries WHERE id = ?").run(id);
      return json({ entries: qPlan.all(existing.week_start) });
    }
  }

  if (path === "/api/plan/clear" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const week = parseWeek(body?.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    db.query("DELETE FROM plan_entries WHERE week_start = ?").run(week);
    db.query("DELETE FROM list_state WHERE week_start = ?").run(week);
    return json({ entries: [] });
  }

  if (path === "/api/plan/autofill" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const week = parseWeek(body?.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const defaultServings = Math.min(24, Math.max(1, Number(body?.servings) || 2));
    const which: string[] = Array.isArray(body?.slots)
      ? body.slots.filter((s: string) => SLOTS.includes(s as any))
      : [...SLOTS];

    const taken = new Set(qPlan.all(week).map((p) => `${p.day}:${p.slot}`));
    const pool = allRecipes();
    const insert = db.prepare(
      `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );

    db.transaction(() => {
      for (const slot of which) {
        // Shuffle per slot and walk the deck so a week doesn't repeat a recipe
        // until the candidates run out.
        const candidates = pool.filter((r) =>
          (r.slots as unknown as string[]).includes(slot),
        );
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        if (!candidates.length) continue;
        let cursor = 0;
        for (let day = 0; day < 7; day++) {
          if (taken.has(`${day}:${slot}`)) continue;
          const pick = candidates[cursor % candidates.length];
          cursor++;
          insert.run(week, day, slot, pick.id, defaultServings || pick.servings);
        }
      }
    })();

    return json({ entries: qPlan.all(week) });
  }

  if (path === "/api/plan/copy" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const to = parseWeek(body?.to);
    const from = parseWeek(body?.from);
    if (!to || !from) return bad("from and to must be Mondays in YYYY-MM-DD form");
    const source = qPlan.all(from);
    if (!source.length) return bad("that week has no meals to copy", 404);
    const insert = db.prepare(
      `INSERT INTO plan_entries (week_start, day, slot, recipe_id, servings, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.query("DELETE FROM plan_entries WHERE week_start = ?").run(to);
      for (const [i, e] of source.entries()) {
        insert.run(to, e.day, e.slot, e.recipe_id, e.servings, i);
      }
    })();
    return json({ entries: qPlan.all(to) });
  }

  if (path === "/api/shopping-list" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    return json(buildList(week));
  }

  if (path === "/api/shopping-list/check" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const week = parseWeek(body?.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    if (typeof body.key !== "string" || !body.key) return bad("key is required");
    db.query(
      `INSERT INTO list_state (week_start, item_key, checked) VALUES (?, ?, ?)
       ON CONFLICT(week_start, item_key) DO UPDATE SET checked = excluded.checked`,
    ).run(week, body.key, body.checked ? 1 : 0);
    return json({ ok: true });
  }

  if (path === "/api/shopping-list/reset" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const week = parseWeek(body?.week);
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    db.query("DELETE FROM list_state WHERE week_start = ?").run(week);
    return json({ ok: true });
  }

  if (path === "/api/pantry" && method === "POST") {
    const body = (await req.json().catch(() => null)) as any;
    const name = String(body?.name || "").trim().toLowerCase();
    if (!name) return bad("name is required");
    db.query("INSERT OR IGNORE INTO pantry (name) VALUES (?)").run(name);
    return json({ ok: true });
  }

  if (path === "/api/pantry" && method === "DELETE") {
    const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
    if (!name) return bad("name is required");
    db.query("DELETE FROM pantry WHERE name = ?").run(name);
    return json({ ok: true });
  }

  if (path === "/api/export" && method === "GET") {
    const week = parseWeek(url.searchParams.get("week"));
    if (!week) return bad("week must be a Monday in YYYY-MM-DD form");
    const format = url.searchParams.get("format") || "txt";
    const map: Record<string, { body: string; type: string; ext: string }> = {
      txt: { body: exportText(week), type: "text/plain", ext: "txt" },
      csv: { body: exportCsv(week), type: "text/csv", ext: "csv" },
      md: { body: exportMarkdown(week), type: "text/markdown", ext: "md" },
    };
    const chosen = map[format];
    if (!chosen) return bad("format must be txt, csv, or md");
    const base = format === "md" ? "meal-plan" : "shopping-list";
    return new Response(chosen.body, {
      headers: {
        "content-type": `${chosen.type}; charset=utf-8`,
        "content-disposition": `attachment; filename="${base}-${week}.${chosen.ext}"`,
      },
    });
  }

  return bad("not found", 404);
}

/* ----------------------------------------------------------- static files */

async function serveStatic(pathname: string): Promise<Response> {
  const clean = pathname.replace(/\.{2,}/g, "").replace(/\/+$/, "") || "/";
  const candidate = clean === "/" ? "/index.html" : clean;
  const file = Bun.file(`${PUBLIC_DIR}${candidate}`);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "cache-control": "no-cache" },
    });
  }
  const index = Bun.file(`${PUBLIC_DIR}/index.html`);
  if (await index.exists()) return new Response(index, { headers: { "cache-control": "no-cache" } });
  return new Response("Not found", { status: 404 });
}

export default {
  port: PORT,
  idleTimeout: 30,
  async fetch(req: Request) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      return await serveStatic(url.pathname);
    } catch (err) {
      console.error(`${req.method} ${url.pathname} failed:`, err);
      return json({ error: "internal error" }, 500);
    }
  },
};

console.log(`Mise meal planner listening on http://0.0.0.0:${PORT}`);
