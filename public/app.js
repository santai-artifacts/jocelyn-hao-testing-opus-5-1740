/* Mise — weekly meal planner client.
 * State lives on the server; this file renders it and sends mutations. */

const SLOTS = ["breakfast", "lunch", "dinner"];
const SLOT_COLOR = { breakfast: "var(--amber)", lunch: "var(--clay)", dinner: "var(--green)" };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const state = {
  weekStart: mondayOf(new Date()),
  recipes: [],
  entries: [],
  list: null,
  held: null,        // recipe "picked up" by tapping — placed on the next slot tap
  query: "",
  filter: "all",
  defaultServings: 2,
  pickerTarget: null,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------- dates */

function mondayOf(date) {
  const d = new Date(date);
  const offset = (d.getDay() + 6) % 7; // Sunday(0) -> 6
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

function dayDate(iso, day) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + day);
}

function weekRangeLabel(iso) {
  const start = dayDate(iso, 0);
  const end = dayDate(iso, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const f = (d, withMonth) =>
    withMonth
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : String(d.getDate());
  return `${f(start, true)} – ${f(end, !sameMonth)}`;
}

/* --------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ toasts */

function toast(message, variant) {
  const el = document.createElement("div");
  el.className = `toast${variant ? ` toast--${variant}` : ""}`;
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 240);
  }, 2600);
}

/* ------------------------------------------------------------------ render */

function renderWeek() {
  const host = $("week");
  const todayIso = isoDate(new Date());
  host.replaceChildren();

  for (let day = 0; day < 7; day++) {
    const date = dayDate(state.weekStart, day);
    const iso = isoDate(date);
    const col = document.createElement("div");
    col.className = `day${iso === todayIso ? " day--today" : ""}`;

    const head = document.createElement("div");
    head.className = "day__head";
    head.innerHTML = `<span class="day__name">${DAY_NAMES[day]}</span>
      <span class="day__date">${date.getDate()}/${date.getMonth() + 1}</span>`;
    col.append(head);

    for (const slot of SLOTS) {
      const wrap = document.createElement("div");
      wrap.className = "slot";

      const label = document.createElement("span");
      label.className = "slot__label";
      label.textContent = slot;
      wrap.append(label);

      const zone = document.createElement("div");
      zone.className = "dropzone";
      zone.dataset.day = String(day);
      zone.dataset.slot = slot;

      const meals = state.entries.filter((e) => e.day === day && e.slot === slot);
      for (const entry of meals) zone.append(mealCard(entry));

      const add = document.createElement("button");
      add.className = "addslot";
      add.type = "button";
      add.textContent = meals.length ? "+ add another" : `+ ${slot}`;
      add.setAttribute(
        "aria-label",
        `Add a ${slot} for ${date.toLocaleDateString(undefined, { weekday: "long" })}`,
      );
      add.addEventListener("click", () => onSlotClick(day, slot));
      zone.append(add);

      wireDropzone(zone, day, slot);
      wrap.append(zone);
      col.append(wrap);
    }
    host.append(col);
  }

  const count = state.entries.length;
  const recipes = new Set(state.entries.map((e) => e.recipe_id)).size;
  $("planSummary").textContent = count
    ? `${count} meal${count === 1 ? "" : "s"} · ${recipes} recipe${recipes === 1 ? "" : "s"}`
    : "No meals planned yet";
  $("weekLabel").textContent = weekRangeLabel(state.weekStart);
}

function mealCard(entry) {
  const card = document.createElement("article");
  card.className = "meal";
  card.style.setProperty("--slot-color", SLOT_COLOR[entry.slot] || "var(--green)");
  card.draggable = true;
  card.dataset.entryId = String(entry.id);

  card.innerHTML = `
    <div class="meal__top">
      <span class="meal__emoji" aria-hidden="true">${entry.emoji}</span>
      <div class="meal__name">${escapeHtml(entry.name)}</div>
    </div>
    <div class="meal__foot">
      <span class="meal__mins">${entry.minutes} min</span>
    </div>`;

  const remove = document.createElement("button");
  remove.className = "meal__remove";
  remove.type = "button";
  remove.innerHTML = "✕";
  remove.setAttribute("aria-label", `Remove ${entry.name}`);
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    await mutate(() => api(`/api/plan/${entry.id}`, { method: "DELETE" }));
  });
  card.append(remove);

  // Servings stepper — scales this meal's ingredients in the shopping list.
  const stepper = document.createElement("div");
  stepper.className = "stepper";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.textContent = "−";
  minus.setAttribute("aria-label", `Fewer servings of ${entry.name}`);
  const value = document.createElement("span");
  value.textContent = String(entry.servings);
  const plus = document.createElement("button");
  plus.type = "button";
  plus.textContent = "+";
  plus.setAttribute("aria-label", `More servings of ${entry.name}`);

  const setServings = (next) => {
    const clamped = Math.min(24, Math.max(1, next));
    if (clamped === entry.servings) return;
    value.textContent = String(clamped); // optimistic, so the stepper feels instant
    mutate(() =>
      api(`/api/plan/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ servings: clamped }),
      }),
    );
  };
  minus.addEventListener("click", (e) => { e.stopPropagation(); setServings(entry.servings - 1); });
  plus.addEventListener("click", (e) => { e.stopPropagation(); setServings(entry.servings + 1); });
  stepper.append(minus, value, plus);
  card.querySelector(".meal__foot").append(stepper);

  card.addEventListener("dragstart", (event) => {
    dragPayload = { type: "entry", id: entry.id };
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify(dragPayload));
  });
  card.addEventListener("dragend", () => {
    dragPayload = null;
    card.classList.remove("is-dragging");
  });

  return card;
}

function renderLibrary() {
  const host = $("recipeList");
  const q = state.query.trim().toLowerCase();
  const matches = state.recipes.filter((r) => {
    if (state.filter !== "all" && !r.slots.includes(state.filter)) return false;
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q)) ||
      r.ingredients.some((i) => i.name.includes(q))
    );
  });

  host.replaceChildren();
  if (!matches.length) {
    host.innerHTML = `<p class="empty">No recipes match “${escapeHtml(state.query)}”.</p>`;
    return;
  }
  for (const recipe of matches) host.append(recipeCard(recipe));
}

function recipeCard(recipe, onPick) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "rcard";
  if (state.held && state.held.id === recipe.id) card.classList.add("is-held");
  card.draggable = true;

  const tag = recipe.tags[0];
  card.innerHTML = `
    <span class="rcard__emoji" aria-hidden="true">${recipe.emoji}</span>
    <span class="rcard__body">
      <span class="rcard__name">${escapeHtml(recipe.name)}</span>
      <span class="rcard__meta">
        <span>${recipe.minutes} min</span>
        <span>serves ${recipe.servings}</span>
        ${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : ""}
      </span>
      <span class="rcard__desc">${escapeHtml(recipe.description)}</span>
    </span>`;

  card.addEventListener("click", () => {
    if (onPick) onPick(recipe);
    else toggleHold(recipe);
  });
  card.addEventListener("dragstart", (event) => {
    dragPayload = { type: "recipe", id: recipe.id };
    card.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", JSON.stringify(dragPayload));
  });
  card.addEventListener("dragend", () => {
    dragPayload = null;
    card.classList.remove("is-dragging");
  });
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* -------------------------------------------------------- drag, hold, drop */

let dragPayload = null;

function wireDropzone(zone, day, slot) {
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = dragPayload && dragPayload.type === "entry" ? "move" : "copy";
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove("is-over");
  });
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("is-over");
    let payload = dragPayload;
    if (!payload) {
      try { payload = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { payload = null; }
    }
    if (!payload) return;
    if (payload.type === "recipe") await addMeal(payload.id, day, slot);
    else if (payload.type === "entry") await moveMeal(payload.id, day, slot);
    dragPayload = null;
  });
}

function toggleHold(recipe) {
  state.held = state.held && state.held.id === recipe.id ? null : recipe;
  document.body.classList.toggle("is-holding", !!state.held);
  const bar = $("holdbar");
  if (state.held) {
    $("holdName").textContent = state.held.name;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
  renderLibrary();
}

function clearHold() {
  if (state.held) toggleHold(state.held);
}

async function onSlotClick(day, slot) {
  if (state.held) {
    const recipe = state.held;
    clearHold();
    await addMeal(recipe.id, day, slot);
    return;
  }
  openPicker(day, slot);
}

async function addMeal(recipeId, day, slot, servings) {
  const recipe = state.recipes.find((r) => r.id === recipeId);
  const s = servings ?? state.defaultServings ?? (recipe ? recipe.servings : 2);
  await mutate(() =>
    api("/api/plan", {
      method: "POST",
      body: JSON.stringify({
        week: state.weekStart,
        day,
        slot,
        recipeId,
        servings: s,
      }),
    }),
  );
}

async function moveMeal(entryId, day, slot) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (entry && entry.day === day && entry.slot === slot) return;
  await mutate(() =>
    api(`/api/plan/${entryId}`, { method: "PATCH", body: JSON.stringify({ day, slot }) }),
  );
}

/* ------------------------------------------------------------------ picker */

function openPicker(day, slot) {
  state.pickerTarget = { day, slot, servingsMap: {} };
  const dialog = $("picker");
  const date = dayDate(state.weekStart, day);
  $("pickerTitle").textContent = `${slot[0].toUpperCase()}${slot.slice(1)} · ${date.toLocaleDateString(undefined, { weekday: "long" })}`;
  $("pickerSearch").value = "";
  renderPicker();
  dialog.showModal();
  $("pickerSearch").focus();
}

function renderPicker() {
  const { slot, servingsMap } = state.pickerTarget || {};
  const q = $("pickerSearch").value.trim().toLowerCase();
  const host = $("pickerList");
  // Suggest recipes suited to this meal first, but never hide the rest.
  const suited = state.recipes.filter((r) => r.slots.includes(slot));
  const others = state.recipes.filter((r) => !r.slots.includes(slot));
  const pool = [...suited, ...others].filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q)) ||
      r.ingredients.some((i) => i.name.includes(q)),
  );

  host.replaceChildren();
  if (!pool.length) {
    host.innerHTML = `<p class="empty">Nothing matches that search.</p>`;
    return;
  }
  for (const recipe of pool) {
    if (!(recipe.id in servingsMap)) servingsMap[recipe.id] = 1;

    const row = document.createElement("div");
    row.className = "picker-row";

    const card = recipeCard(recipe, async (picked) => {
      $("picker").close();
      await addMeal(picked.id, state.pickerTarget.day, state.pickerTarget.slot, servingsMap[picked.id]);
    });

    const qty = document.createElement("div");
    qty.className = "picker-qty";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `Fewer servings of ${recipe.name}`);

    const valueEl = document.createElement("span");
    valueEl.textContent = String(servingsMap[recipe.id]);

    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `More servings of ${recipe.name}`);

    const updateQty = (next) => {
      const clamped = Math.min(24, Math.max(1, next));
      servingsMap[recipe.id] = clamped;
      valueEl.textContent = String(clamped);
    };

    minus.addEventListener("click", (e) => { e.stopPropagation(); updateQty(servingsMap[recipe.id] - 1); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); updateQty(servingsMap[recipe.id] + 1); });

    qty.append(minus, valueEl, plus);
    row.append(card, qty);
    host.append(row);
  }
}

/* ------------------------------------------------------------------ drawer */

function setDrawer(open) {
  const drawer = $("drawer");
  const scrim = $("scrim");
  drawer.hidden = !open;
  scrim.hidden = !open;
  drawer.setAttribute("aria-hidden", String(!open));
  $("listBtn").setAttribute("aria-expanded", String(open));
  if (open) $("drawerClose").focus();
  else $("listBtn").focus();
}

function renderList() {
  const list = state.list;
  const host = $("listBody");
  $("listCount").textContent = list ? String(list.itemCount) : "0";
  if (!list) return;

  $("drawerSub").textContent = list.mealCount
    ? `${list.itemCount} items · ${list.mealCount} meals · week of ${weekRangeLabel(state.weekStart)}`
    : `Nothing planned for ${weekRangeLabel(state.weekStart)} yet`;

  const wrap = $("progressWrap");
  if (list.itemCount) {
    wrap.hidden = false;
    const pct = Math.round((list.checkedCount / list.itemCount) * 100);
    $("progressFill").style.width = `${pct}%`;
    $("progressText").textContent = `${list.checkedCount}/${list.itemCount}`;
  } else {
    wrap.hidden = true;
  }

  host.replaceChildren();

  if (!list.groups.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.innerHTML = list.mealCount
      ? "Every ingredient this week is already in your pantry."
      : "Add some meals and the shopping list builds itself —<br>combined amounts, sorted by aisle.";
    host.append(empty);
  }

  for (const group of list.groups) {
    const section = document.createElement("section");
    section.className = "aisle";
    const head = document.createElement("div");
    head.className = "aisle__head";
    head.innerHTML = `<span class="aisle__name">${escapeHtml(group.aisle)}</span>
      <span class="aisle__rule"></span>
      <span class="aisle__n">${group.items.length}</span>`;
    section.append(head);

    for (const item of group.items) {
      const row = document.createElement("div");
      row.className = `item${item.checked ? " is-checked" : ""}`;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.checked;
      box.id = `chk-${cssId(item.key)}`;

      const main = document.createElement("label");
      main.className = "item__main";
      main.htmlFor = box.id;
      main.innerHTML = `<div class="item__name">${escapeHtml(item.label)} <span class="item__qty">${escapeHtml(item.display)}</span></div>
        <div class="item__from">${escapeHtml(item.recipes.join(" · "))}</div>`;

      box.addEventListener("change", async () => {
        row.classList.toggle("is-checked", box.checked);
        item.checked = box.checked;
        state.list.checkedCount = countChecked(state.list);
        const pct = Math.round((state.list.checkedCount / state.list.itemCount) * 100);
        $("progressFill").style.width = `${pct}%`;
        $("progressText").textContent = `${state.list.checkedCount}/${state.list.itemCount}`;
        try {
          await api("/api/shopping-list/check", {
            method: "POST",
            body: JSON.stringify({ week: state.weekStart, key: item.key, checked: box.checked }),
          });
        } catch (err) {
          toast(err.message, "warn");
        }
      });

      const pantry = document.createElement("button");
      pantry.type = "button";
      pantry.className = "item__pantry";
      pantry.innerHTML = "⊘";
      pantry.title = `I already have ${item.label} — hide it`;
      pantry.setAttribute("aria-label", `Mark ${item.label} as already in pantry`);
      pantry.addEventListener("click", async () => {
        try {
          await api("/api/pantry", {
            method: "POST",
            body: JSON.stringify({ name: item.name }),
          });
          await refreshList();
          toast(`${item.label} moved to your pantry staples`);
        } catch (err) {
          toast(err.message, "warn");
        }
      });

      row.append(box, main, pantry);
      section.append(row);
    }
    host.append(section);
  }

  if (list.pantry.length) {
    const box = document.createElement("div");
    box.className = "pantrybox";
    box.innerHTML = `<h3>Pantry staples</h3>
      <p>Left off the list because you already have them. Tap to put one back.</p>`;
    const chips = document.createElement("div");
    chips.className = "pantrybox__chips";
    for (const name of list.pantry) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pchip";
      chip.innerHTML = `${escapeHtml(name)} <span aria-hidden="true">✕</span>`;
      chip.setAttribute("aria-label", `Remove ${name} from pantry staples`);
      chip.addEventListener("click", async () => {
        try {
          await api(`/api/pantry?name=${encodeURIComponent(name.toLowerCase())}`, {
            method: "DELETE",
          });
          await refreshList();
        } catch (err) {
          toast(err.message, "warn");
        }
      });
      chips.append(chip);
    }
    box.append(chips);
    host.append(box);
  }

  buildPrintout();
}

/** confirm() is blocked in some embedded/sandboxed frames; don't dead-end there.
 *  The user clicked an explicitly-labelled destructive button, so proceed. */
function askConfirm(message) {
  try {
    return window.confirm(message);
  } catch {
    return true;
  }
}

function countChecked(list) {
  return list.groups.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0);
}

function cssId(key) {
  return key.replace(/[^a-z0-9]+/gi, "-");
}

/* ------------------------------------------------------------------- print */

function buildPrintout() {
  const list = state.list;
  const host = $("printout");
  if (!list) return;
  const parts = [
    `<h1>Shopping list</h1>`,
    `<p class="sub">Week of ${escapeHtml(weekRangeLabel(state.weekStart))} · ${list.itemCount} items · ${list.mealCount} meals</p>`,
  ];
  for (const group of list.groups) {
    parts.push(`<h2>${escapeHtml(group.aisle)}</h2><ul>`);
    for (const item of group.items) {
      parts.push(
        `<li><span class="box"></span>${escapeHtml(item.label)} — <b>${escapeHtml(item.display)}</b></li>`,
      );
    }
    parts.push(`</ul>`);
  }
  host.innerHTML = parts.join("");
}

/* -------------------------------------------------------------- data flow */

async function refreshPlan() {
  const data = await api(`/api/plan?week=${state.weekStart}`);
  state.entries = data.entries;
  renderWeek();
}

async function refreshList() {
  state.list = await api(`/api/shopping-list?week=${state.weekStart}`);
  renderList();
}

/** Run a mutation, then re-read plan + list so the UI matches the server. */
async function mutate(fn) {
  try {
    const data = await fn();
    if (data && Array.isArray(data.entries)) {
      state.entries = data.entries;
      renderWeek();
    } else {
      await refreshPlan();
    }
    await refreshList();
    return data;
  } catch (err) {
    toast(err.message, "warn");
    await refreshPlan().catch(() => {});
    throw err;
  }
}

async function loadWeek(iso) {
  state.weekStart = iso;
  $("weekLabel").textContent = weekRangeLabel(iso);
  await Promise.all([refreshPlan(), refreshList()]);
}

/* ------------------------------------------------------------------ export */

async function download(format) {
  try {
    const res = await fetch(`/api/export?week=${state.weekStart}&format=${format}`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      format === "md" ? `meal-plan-${state.weekStart}.md` : `shopping-list-${state.weekStart}.${format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${a.download}`);
  } catch (err) {
    toast(err.message, "warn");
  }
}

async function copyList() {
  try {
    const res = await fetch(`/api/export?week=${state.weekStart}&format=txt`);
    const body = await res.text();
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      // Clipboard API is blocked in some embedded contexts; fall back.
      const area = document.createElement("textarea");
      area.value = body;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (!ok) throw new Error("Copying is blocked here — use .txt instead");
    }
    toast("Shopping list copied to clipboard");
  } catch (err) {
    toast(err.message, "warn");
  }
}

/* ------------------------------------------------------------------ wiring */

function wireChrome() {
  $("prevWeek").addEventListener("click", () => loadWeek(addDays(state.weekStart, -7)));
  $("nextWeek").addEventListener("click", () => loadWeek(addDays(state.weekStart, 7)));
  $("thisWeek").addEventListener("click", () => loadWeek(mondayOf(new Date())));

  $("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderLibrary();
  });

  const filters = $("filters");
  for (const [value, label] of [
    ["all", "All"], ["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"],
  ]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = label;
    chip.setAttribute("aria-pressed", String(state.filter === value));
    chip.addEventListener("click", () => {
      state.filter = value;
      for (const c of filters.children) c.setAttribute("aria-pressed", "false");
      chip.setAttribute("aria-pressed", "true");
      renderLibrary();
    });
    filters.append(chip);
  }

  $("defaultServings").addEventListener("change", (e) => {
    const n = Math.min(12, Math.max(1, Number(e.target.value) || 2));
    state.defaultServings = n;
    e.target.value = String(n);
  });

  $("autofillBtn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const data = await mutate(() =>
        api("/api/plan/autofill", {
          method: "POST",
          body: JSON.stringify({ week: state.weekStart, servings: state.defaultServings }),
        }),
      );
      toast(data.added ? `Filled ${data.added} empty slots` : "Every slot was already full");
    } catch { /* mutate already reported it */ } finally {
      e.target.disabled = false;
    }
  });

  $("clearWeek").addEventListener("click", async () => {
    if (!state.entries.length) return toast("This week is already empty");
    if (!askConfirm("Remove every meal from this week?")) return;
    await mutate(() =>
      api("/api/plan/clear", { method: "POST", body: JSON.stringify({ week: state.weekStart }) }),
    );
    toast("Week cleared");
  });

  $("copyLastWeek").addEventListener("click", async () => {
    const from = addDays(state.weekStart, -7);
    if (
      state.entries.length &&
      !askConfirm("This replaces the meals currently in this week. Continue?")
    ) {
      return;
    }
    try {
      const data = await mutate(() =>
        api("/api/plan/copy", {
          method: "POST",
          body: JSON.stringify({ from, to: state.weekStart }),
        }),
      );
      toast(`Copied ${data.copied} meals from last week`);
    } catch { /* reported */ }
  });

  $("listBtn").addEventListener("click", () => setDrawer($("drawer").hidden));
  $("drawerClose").addEventListener("click", () => setDrawer(false));
  $("scrim").addEventListener("click", () => setDrawer(false));

  $("copyList").addEventListener("click", copyList);
  $("printList").addEventListener("click", () => window.print());
  for (const btn of document.querySelectorAll("[data-export]")) {
    btn.addEventListener("click", () => download(btn.dataset.export));
  }
  $("resetChecks").addEventListener("click", async () => {
    try {
      await api("/api/shopping-list/reset", {
        method: "POST",
        body: JSON.stringify({ week: state.weekStart }),
      });
      await refreshList();
    } catch (err) {
      toast(err.message, "warn");
    }
  });

  $("holdCancel").addEventListener("click", clearHold);
  $("pickerClose").addEventListener("click", () => $("picker").close());
  $("pickerSearch").addEventListener("input", renderPicker);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.held) clearHold();
    else if (!$("drawer").hidden) setDrawer(false);
  });
}

/* -------------------------------------------------------------------- boot */

(async function start() {
  wireChrome();
  try {
    const boot = await api("/api/bootstrap");
    state.recipes = boot.recipes;
    renderLibrary();
    await loadWeek(state.weekStart);
  } catch (err) {
    $("week").innerHTML = `<p class="empty">Couldn't reach the server: ${escapeHtml(err.message)}</p>`;
    toast(err.message, "warn");
  }
})();
