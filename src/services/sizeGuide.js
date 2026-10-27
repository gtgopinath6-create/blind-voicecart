/**
 * Shoe-size assistance for Zoro.
 *
 * - Height and weight never decide a size: they do not predict foot length reliably. Zoro may
 *   note them if the shopper offers them, but says plainly that they are not enough.
 * - A size can come from (1) a pair that fits, in a stated sizing system, or (2) a measured foot
 *   length plus a verified size chart for that brand.
 * - Sizes are never converted between UK, US and EU here: there is no verified conversion rule
 *   in this project, and the catalog lists shoe sizes as plain numbers without a system.
 */

/**
 * Verified brand size charts, copied from each brand's official size guide.
 * Shape: { [brand in lower case]: { source: "<URL>", checked: "<YYYY-MM-DD>", rows: [{ footCm, UK, US, EU }] } }
 * Empty on purpose: no chart has been verified for this store yet, and an invented chart would
 * give confident but wrong advice. Add a chart only with its source and the date it was checked.
 */
export const SIZE_CHARTS = {};

/**
 * The sizing system of the shoe sizes in the catalog ("UK", "US", "EU" or "INDIA"), or null when
 * unknown. The current catalog does not say, so it is null.
 */
export const STORE_SHOE_SIZE_SYSTEM = null;

export const HEIGHT_WEIGHT_NOTE = "Height and weight alone cannot accurately determine shoe size.";

export const MEASURING_GUIDE =
    "Here is how to measure your foot. Stand on a sheet of paper against a wall, with your heel touching the wall. " +
    "Ask someone to mark the tip of your longest toe, or mark it yourself with a pencil held straight up. " +
    "Measure from the edge of the paper to the mark in centimetres. Measure both feet and use the longer one, " +
    "ideally in the evening and wearing the socks you will wear with the shoes.";

const sizeNumber = (s) => {
    const n = parseFloat(String(s));
    return Number.isFinite(n) ? n : null;
};

/** Distinct sizes offered by these products, in numeric order (strings, as stored). */
export function sizesFromProducts(products) {
    const all = new Set();
    for (const p of products || []) if (Array.isArray(p.size)) p.size.forEach((s) => all.add(String(s)));
    return [...all].sort((a, b) => (sizeNumber(a) ?? 0) - (sizeNumber(b) ?? 0) || a.localeCompare(b));
}

/** True when a spoken size ("9", "9.5") is one of the available sizes ("9", "9.5"). */
export function isSizeAvailable(size, available) {
    const n = sizeNumber(size);
    return available.some((s) => String(s) === String(size) || (n !== null && sizeNumber(s) === n && /^\d+(\.\d+)?$/.test(String(s))));
}

/** The available size that equals the spoken one, as stored ("9" for "9.0"), or null. */
export function matchAvailableSize(size, available) {
    const n = sizeNumber(size);
    return available.find((s) => String(s) === String(size)) || available.find((s) => n !== null && sizeNumber(s) === n && /^\d+(\.\d+)?$/.test(String(s))) || null;
}

/**
 * Estimates a size from a measured foot length with a verified chart for the brand.
 * Returns:
 *   { status: "ok", size, system, source }   the smallest chart size that fits the foot;
 *   { status: "no_chart" }                   no verified chart for this brand;
 *   { status: "no_system" }                  the store's sizing system is unknown, so a chart size
 *                                            cannot be matched to the catalog's numbers;
 *   { status: "out_of_range" }               the length is outside the chart.
 */
export function estimateFromFootLength(footCm, brand, { charts = SIZE_CHARTS, storeSystem = STORE_SHOE_SIZE_SYSTEM } = {}) {
    const chart = charts[String(brand || "").toLowerCase()];
    if (!chart || !Array.isArray(chart.rows) || chart.rows.length === 0) return { status: "no_chart" };
    if (!storeSystem) return { status: "no_system" };
    const rows = [...chart.rows].filter((r) => r[storeSystem] !== undefined).sort((a, b) => a.footCm - b.footCm);
    // A shoe must be at least as long as the foot: take the first row that is not shorter.
    const row = rows.find((r) => r.footCm >= footCm);
    if (!row || footCm < rows[0].footCm - 1) return { status: "out_of_range" };
    return { status: "ok", size: String(row[storeSystem]), system: storeSystem, source: chart.source };
}

// How letter sizes are said aloud. Matched only against the sizes a product actually lists.
const LETTER_SIZES = [
    { size: "XXL", said: ["double extra large", "xx large", "2xl", "x x l", "xxl"] },
    { size: "XS", said: ["extra small", "x small", "x s", "xs"] },
    { size: "XL", said: ["extra large", "x large", "x l", "xl"] },
    { size: "S", said: ["small", "s"] },
    { size: "M", said: ["medium", "m"] },
    { size: "L", said: ["large", "l"] },
    { size: "Free Size", said: ["free size", "freesize", "one size"] },
];

/** A spoken clothing size ("medium", "extra large") as one of the listed sizes, or null. */
export function matchLetterSize(text, available) {
    const plain = String(text || "").toLowerCase().replace(/'/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const t = ` ${plain} `;
    // A single letter counts only as the whole answer ("m", "size m"), never inside a sentence.
    const said = (w) => (w.length === 1 ? plain === w || plain === `size ${w}` : t.includes(` ${w} `));
    // The most specific size said decides ("double extra large" is XXL, never XL when XXL is missing).
    const entry = LETTER_SIZES.find((e) => e.said.some(said));
    if (!entry) return null;
    const listed = available.find((s) => String(s).toLowerCase() === entry.size.toLowerCase());
    return listed ? String(listed) : null;
}
