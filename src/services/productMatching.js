// Matches a spoken product name against the real catalog.
// Never guesses: returns "none" or "ambiguous" instead of picking a product the user
// may not have meant, because blind users cannot visually check the selection.

export function normalizeText(text) {
    return (text || "")
        .toLowerCase()
        .replace(/\bone\b/g, "1").replace(/\btwo\b/g, "2").replace(/\bthree\b/g, "3")
        .replace(/[^a-z0-9%]+/g, " ")
        .trim();
}

const STOP_WORDS = new Set(["the", "a", "an", "my", "to", "of", "for", "please", "pair", "some", "shoe", "shoes"]);

/** Edit distance between two short words (insertions, deletions, substitutions). */
export function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}

/** A likely mishearing of a longer word ("mercurial" / "mercureal"): same first letter, one or two letters apart. */
export function nearWord(heard, word) {
    if (heard.length < 5 || word.length < 5 || heard[0] !== word[0] || heard === word) return false;
    if (heard === `${word}s` || word === `${heard}s`) return false;
    return editDistance(heard, word) <= (word.length >= 8 ? 2 : 1);
}

function words(text) {
    return normalizeText(text).split(" ").filter((w) => w && !STOP_WORDS.has(w));
}

export function brandOf(product) {
    return product.brand || (Array.isArray(product.category) ? product.category[2] : "") || "";
}

export function categoryOf(product) {
    return (Array.isArray(product.category) ? product.category[0] : product.category) || "";
}

/**
 * Resolves a spoken product name.
 * Returns { status: "one", product } | { status: "ambiguous", matches, partial? } | { status: "none" }.
 */
export function resolveProduct(spokenName, products) {
    const target = normalizeText(spokenName);
    if (!target || !Array.isArray(products) || products.length === 0) return { status: "none" };

    const exact = products.filter((p) => normalizeText(p.name) === target);
    if (exact.length === 1) return { status: "one", product: exact[0] };
    if (exact.length > 1) return { status: "ambiguous", matches: exact };

    const targetWords = words(spokenName);
    if (targetWords.length === 0) return { status: "none" };

    // Score = share of the spoken words found in the product name; all spoken words must match
    // for a confident pick, so "Nike" alone never selects one specific Nike product.
    const scored = products
        .map((p) => {
            const nameWords = new Set(normalizeText(p.name).split(" "));
            const hits = targetWords.filter((w) => nameWords.has(w)).length;
            return { product: p, hits, coverage: hits / targetWords.length, extra: nameWords.size - hits };
        })
        .filter((s) => s.hits > 0);

    const full = scored.filter((s) => s.coverage === 1);
    if (full.length === 1) return { status: "one", product: full[0].product };
    if (full.length > 1) {
        // Prefer a product whose name is fully spoken ("macbook air" vs "macbook air pro").
        const tightest = Math.min(...full.map((s) => s.extra));
        const best = full.filter((s) => s.extra === tightest);
        if (best.length === 1 && tightest === 0) return { status: "one", product: best[0].product };
        return { status: "ambiguous", matches: full.map((s) => s.product).slice(0, 5) };
    }

    // Words that sound misheard ("air forse", "mercureal"). Products they match are only ever
    // offered as suggestions to choose from, never selected, even when there is just one.
    const fuzzy = products
        .map((p) => {
            const nameWords = normalizeText(p.name).split(" ");
            const hits = targetWords.filter((w) => nameWords.includes(w) || nameWords.some((n) => nearWord(w, n))).length;
            return { product: p, hits, coverage: hits / targetWords.length };
        })
        .filter((s) => s.hits > 0 && s.coverage >= 0.5)
        .sort((a, b) => b.coverage - a.coverage);
    const suggest = (list, extra = {}) => ({ status: "ambiguous", partial: true, ...extra, matches: list.map((s) => s.product).slice(0, 5) });
    const whole = fuzzy.filter((s) => s.coverage === 1);
    if (whole.length) return suggest(whole, { fuzzy: true });

    const partial = scored.filter((s) => s.coverage >= 0.5).sort((a, b) => b.coverage - a.coverage);
    // Only some spoken words match: offer these as suggestions, flagged as not an exact find.
    if (partial.length) return suggest(partial);
    if (fuzzy.length) return suggest(fuzzy, { fuzzy: true });
    return { status: "none" };
}

const ORDINALS = { first: 0, "1st": 0, "1": 0, second: 1, "2nd": 1, "2": 1, third: 2, "3rd": 2, "3": 2, fourth: 3, "4th": 3, "4": 3, fifth: 4, "5th": 4, "5": 4 };

/** Picks one product from a clarification list by ordinal ("the second one", "number 2") or by name. */
export function pickFromList(answer, options) {
    const match = normalizeText(answer).match(/^(?:the )?(?:number |option )?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|1|2|3|4|5)(?: 1)?$/);
    if (match) return options[ORDINALS[match[1]]] || null;
    const result = resolveProduct(answer, options);
    return result.status === "one" ? result.product : null;
}

/** Products whose name, brand or category contains the query (same rule as the search page). */
export function searchProducts(queryText, products) {
    const q = (queryText || "").toLowerCase().trim();
    if (!q) return [];
    return products.filter((p) =>
        (p.name || "").toLowerCase().includes(q) ||
        brandOf(p).toLowerCase().includes(q) ||
        categoryOf(p).toLowerCase() === q
    );
}

/** Variant fields a product may have, in the order they are asked for. */
export const VARIANT_FIELDS = ["size", "color"];

/** Variant options of a product that need a choice, e.g. { size: ["6","7"], color: [...] }. */
export function variantOptions(product) {
    const options = {};
    for (const field of VARIANT_FIELDS) {
        if (Array.isArray(product[field]) && product[field].length > 1) options[field] = product[field].map(String);
    }
    return options;
}

const IDENTITY_FIELDS = ["name", "price", "description", "category"];
const identity = (p) => JSON.stringify(IDENTITY_FIELDS.map((f) => (f === "price" ? Number(p[f]) : p[f] ?? null)));
const fieldCount = (p) => Object.keys(p).filter((k) => p[k] !== undefined && p[k] !== null).length;

/** True if every field of `small` (except id) has the same value in `big`. */
function isSubsetOf(small, big) {
    return Object.keys(small).every((k) => k === "id" || small[k] === undefined || JSON.stringify(small[k]) === JSON.stringify(big[k]));
}

/**
 * The live catalog contains repeated copies of each product (the seed script was run many
 * times), and for some products one copy also has size/colour options. Copies with the same
 * name, price, description and category are merged into the most complete copy when every
 * other copy is a subset of it; copies that genuinely conflict are all kept. Choice is stable
 * (most fields, then smallest id).
 */
export function dedupeProducts(products) {
    const groups = new Map();
    for (const p of products) {
        const key = identity(p);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    }
    const keep = new Set();
    for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => fieldCount(b) - fieldCount(a) || (String(a.id) < String(b.id) ? -1 : 1));
        const representatives = [];
        for (const p of sorted) {
            if (!representatives.some((r) => isSubsetOf(p, r))) representatives.push(p);
        }
        representatives.forEach((r) => keep.add(r));
    }
    return products.filter((p) => keep.has(p));
}

/** The copy dedupeProducts() shows for `product` among `copies` (the product itself when it is kept). */
export function keptCopyOf(product, copies) {
    const all = copies.some((c) => c.id === product.id) ? copies : [product, ...copies];
    const kept = dedupeProducts(all);
    return kept.find((k) => k.id === product.id)
        || kept.find((k) => identity(k) === identity(product) && isSubsetOf(product, k))
        || product;
}
