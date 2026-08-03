/**
 * Unit handling for shopping-list aggregation.
 *
 * Ingredients only combine when they share a *family* — you can add 500 g to
 * 1 kg, but "2 lemons" and "30 ml lemon juice" have to stay separate lines.
 * Countable units each form their own family for the same reason: a clove is
 * not a bulb.
 */

type Family = { id: string; base: string; units: Record<string, number> };

const MASS: Family = {
  id: "mass",
  base: "g",
  units: { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 },
};

const VOLUME: Family = {
  id: "volume",
  base: "ml",
  units: { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 },
};

/** Spoon/cup units read better as fractions than as millilitres. */
const SPOONS = new Set(["tsp", "tbsp", "cup"]);

export function normalizeUnit(unit: string): string {
  const u = (unit || "").trim().toLowerCase();
  const aliases: Record<string, string> = {
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
  return aliases[u] ?? u;
}

export function familyOf(unit: string): string {
  const u = normalizeUnit(unit);
  if (u in MASS.units) return MASS.id;
  if (u in VOLUME.units) return VOLUME.id;
  return `count:${u || "ea"}`;
}

/** Convert a measurement into its family's base unit. */
export function toBase(quantity: number, unit: string): number {
  const u = normalizeUnit(unit);
  if (u in MASS.units) return quantity * MASS.units[u];
  if (u in VOLUME.units) return quantity * VOLUME.units[u];
  return quantity; // countables are already their own base
}

const VULGAR: Array<[number, string]> = [
  [0.125, "⅛"], [0.25, "¼"], [0.333, "⅓"], [0.375, "⅜"], [0.5, "½"],
  [0.625, "⅝"], [0.667, "⅔"], [0.75, "¾"], [0.875, "⅞"],
];

/** Render a number cooks can actually follow: 1.5 -> "1½", 0.25 -> "¼". */
export function prettyNumber(value: number, allowFractions: boolean): string {
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

function pluralize(unit: string, value: number): string {
  if (!unit) return "";
  if (value === 1) return unit;
  if (/(s|x|ch|sh)$/.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

/**
 * Turn an accumulated base-unit total back into a human measurement.
 * `usedUnits` are the units the recipes actually called for, which decides
 * whether a volume shows up as tablespoons or as millilitres.
 */
export function formatTotal(
  totalBase: number,
  family: string,
  usedUnits: Set<string>,
): { quantity: number; unit: string; display: string } {
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
      for (const unit of ["cup", "tbsp", "tsp"] as const) {
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

  // Countable: "3 cloves", "12" (bare count), "1½ bunches"
  const unit = family.slice("count:".length).replace(/^ea$/, "");
  const value = Math.round(totalBase * 100) / 100;
  const num = prettyNumber(value, true);
  return {
    quantity: value,
    unit,
    display: unit ? `${num} ${pluralize(unit, value)}` : num,
  };
}
