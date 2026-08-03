/**
 * Unit handling for shopping-list aggregation.
 *
 * Ingredients only combine when they share a *family* — you can add 500 g to
 * 1 kg, but "2 lemons" and "30 ml lemon juice" have to stay separate lines.
 * Countable units each form their own family for the same reason: a clove is
 * not a bulb.
 */

const MASS = {
  id: "mass",
  base: "g",
  units: { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 },
};

const VOLUME = {
  id: "volume",
  base: "ml",
  units: { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 },
};

/** Spoon/cup units read better as fractions than as millilitres. */
const SPOONS = new Set(["tsp", "tbsp", "cup"]);

const ALIASES = {
  gram: "g", grams: "g", gr: "g",
  kilogram: "kg", kilograms: "kg",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  milliliter: "ml", millilitre: "ml", milliliters: "ml",
  liter: "l", litre: "l", liters: "l", litres: "l",
  teaspoon: "tsp", teaspoons: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp",
  cups: "cup",
  cloves: "clove", slices: "slice", stalks: "stalk",
  bunches: "bunch", cans: "can", sprigs: "sprig",
  ea: "", each: "", count: "", "": "",
};

export function normalizeUnit(unit) {
  const u = String(unit || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALIASES, u) ? ALIASES[u] : u;
}

export function familyOf(unit) {
  const u = normalizeUnit(unit);
  if (u in MASS.units) return MASS.id;
  if (u in VOLUME.units) return VOLUME.id;
  return `count:${u || "ea"}`;
}

/** Convert a measurement into its family's base unit. */
export function toBase(quantity, unit) {
  const u = normalizeUnit(unit);
  if (u in MASS.units) return quantity * MASS.units[u];
  if (u in VOLUME.units) return quantity * VOLUME.units[u];
  return quantity; // countables are already their own base
}

const VULGAR = [
  [0.125, "⅛"], [0.25, "¼"], [0.333, "⅓"], [0.375, "⅜"], [0.5, "½"],
  [0.625, "⅝"], [0.667, "⅔"], [0.75, "¾"], [0.875, "⅞"],
];

/** Render a number cooks can actually follow: 1.5 -> "1½", 0.25 -> "¼". */
export function prettyNumber(value, allowFractions) {
  if (!allowFractions || value >= 10) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }
  const snapped = Math.round(value * 8) / 8;
  const whole = Math.floor(snapped + 1e-9);
  const frac = snapped - whole;
  let best = "";
  let bestDiff = 0.06;
  for (const [v, glyph] of VULGAR) {
    const diff = Math.abs(frac - v);
    if (diff < bestDiff) { bestDiff = diff; best = glyph; }
  }
  if (!best) {
    if (whole === 0) return String(Math.round(snapped * 100) / 100);
    return String(whole);
  }
  return whole === 0 ? best : `${whole}${best}`;
}

/** Abbreviations stay invariant: "2 tsp", never "2 tsps". */
const INVARIANT = new Set(["tsp", "tbsp", "g", "kg", "ml", "l", "oz", "lb"]);

function pluralize(unit, value) {
  if (!unit) return "";
  if (value === 1 || INVARIANT.has(unit)) return unit;
  if (/(s|x|ch|sh)$/.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

/**
 * Turn an accumulated base-unit total back into a human measurement.
 * `usedUnits` are the units the recipes actually called for, which decides
 * whether a volume shows up as tablespoons or as millilitres.
 */
export function formatTotal(totalBase, family, usedUnits) {
  if (family === MASS.id) {
    if (totalBase >= 1000) {
      const kg = totalBase / 1000;
      return { quantity: kg, unit: "kg", display: `${prettyNumber(kg, false)} kg` };
    }
    const g = Math.round(totalBase);
    return { quantity: g, unit: "g", display: `${g} g` };
  }

  if (family === VOLUME.id) {
    const allSpoons = [...usedUnits].every((u) => SPOONS.has(u));
    if (allSpoons) {
      for (const unit of ["cup", "tbsp", "tsp"]) {
        const value = totalBase / VOLUME.units[unit];
        if (value >= 0.95 || unit === "tsp") {
          return {
            quantity: Math.round(value * 100) / 100,
            unit,
            display: `${prettyNumber(value, true)} ${pluralize(unit, value)}`,
          };
        }
      }
    }
    if (totalBase >= 1000) {
      const l = totalBase / 1000;
      return { quantity: l, unit: "l", display: `${prettyNumber(l, false)} L` };
    }
    const ml = Math.round(totalBase);
    return { quantity: ml, unit: "ml", display: `${ml} ml` };
  }

  // Countable: "3 cloves", "12" (bare count).
  // Scaling servings can land on 6.67 eggs, but you buy whole eggs — round up,
  // with an epsilon so 2.0000001 doesn't become 3.
  const unit = family.slice("count:".length).replace(/^ea$/, "");
  const value = Math.max(1, Math.ceil(totalBase - 1e-6));
  return {
    quantity: value,
    unit,
    display: unit ? `${value} ${pluralize(unit, value)}` : String(value),
  };
}
