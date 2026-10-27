/**
 * Grounds Zoro's shopping conversation in the real catalog.
 *
 * Product types, colours, sizes, brands and prices are read from the products themselves.
 * The word lists below only map how people speak ("gym shoes", "daily walks", "hoodie") onto
 * the sub-categories that exist. A mapping marked `closest` is not an exact category: Zoro says
 * so and asks the shopper to confirm it.
 */
import { CATEGORIES } from "./storeCategories";
import { brandOf, categoryOf, normalizeText, editDistance } from "./productMatching";
import { normalizeSpeech, parseShoeSize, parseSizeSystem, parseBudget, parseQuantity } from "./speechParsers";
import { sizesFromProducts, isSizeAvailable } from "./sizeGuide";

export const CATEGORY_WORDS = {
    Shoes: ["shoe", "shoes", "footwear", "sneaker", "sneakers", "trainers", "boot", "boots"],
    Electronics: ["electronics", "electronic", "gadget", "gadgets"],
    Clothes: ["clothes", "clothing", "apparel", "outfit", "outfits"],
    Food: ["food", "grocery", "groceries"],
};

/** How shoppers name product types, mapped to catalog sub-categories (category[1]). */
export const TYPE_WORDS = [
    { words: ["sports", "sport", "athletic"], category: "Shoes", type: "sports" },
    { words: ["gym", "training", "workout", "running", "jogging", "football", "basketball"], category: "Shoes", type: "sports", closest: true },
    { words: ["casual", "everyday", "lifestyle"], category: "Shoes", type: "casual" },
    { words: ["walking", "walks", "walk"], category: "Shoes", type: "casual", closest: true },
    { words: ["formal", "office", "oxford", "oxfords", "loafers"], category: "Shoes", type: null },
    { words: ["phone", "phones", "mobile", "mobiles", "smartphone", "smartphones"], category: "Electronics", type: "phones" },
    { words: ["laptop", "laptops", "notebook", "notebooks"], category: "Electronics", type: "laptop" },
    { words: ["tv", "tvs", "television", "televisions"], category: "Electronics", type: "tv" },
    { words: ["shirt", "shirts"], category: "Clothes", type: "shirts" },
    { words: ["t shirt", "t shirts", "tshirt", "tshirts", "tee", "tees"], category: "Clothes", type: "tshirts" },
    { words: ["sweatshirt", "sweatshirts", "hoodie", "hoodies", "jumper", "sweater"], category: "Clothes", type: "sweatshirts" },
    { words: ["pants", "trousers", "joggers", "jeans"], category: "Clothes", type: "pants" },
    { words: ["dress", "dresses"], category: "Clothes", type: "dresses" },
    { words: ["snack", "snacks", "chips", "crisps", "namkeen"], category: "Food", type: "dry snacks" },
];

/** Colour words people say. Only colours that products actually list can be chosen. */
export const COLOR_WORDS = [
    "black", "white", "red", "blue", "green", "grey", "gray", "brown", "pink", "purple", "yellow", "orange",
    "navy", "beige", "silver", "gold", "maroon", "cream", "olive", "teal", "violet", "tan", "khaki",
];
const SAME_COLOR = { gray: "grey" }; // spelling only; shades such as navy and blue are not merged
// What speech recognition writes for a colour said on its own; used only when a colour is the
// expected answer, and the colour is read back for confirmation.
const COLOR_SOUNDALIKES = { read: "red", blew: "blue", block: "black" };

const TYPE_LABELS = { sports: "sports", casual: "casual", phones: "phones", laptop: "laptops", tv: "TVs", shirts: "shirts", tshirts: "T-shirts", sweatshirts: "sweatshirts", pants: "trousers and joggers", dresses: "dresses", "dry snacks": "snacks" };
const NOUNS = { Shoes: "shoes", Electronics: "electronics", Clothes: "clothes", Food: "food" };

export const typeLabel = (type) => TYPE_LABELS[type] || type;
export const categoryNoun = (category) => NOUNS[category] || String(category || "").toLowerCase();

const hasWord = (text, phrase) => new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text);
const prep = (text) => ` ${normalizeSpeech(text).replace(/-/g, " ").replace(/\./g, " ").replace(/\s+/g, " ").trim()} `;

const isStoreProduct = (p) => CATEGORIES.some((c) => c.toLowerCase() === categoryOf(p).toLowerCase());
export const storeCategoryOf = (p) => CATEGORIES.find((c) => c.toLowerCase() === categoryOf(p).toLowerCase()) || null;
export const typeOf = (p) => (Array.isArray(p.category) && p.category[1] ? String(p.category[1]).toLowerCase() : "");
export const colorsOf = (p) => (Array.isArray(p.color) ? p.color.map((c) => String(c).toLowerCase()) : []);

/** Product types (sub-categories) that exist in a category, e.g. Shoes -> ["casual", "sports"]. */
export function typesFor(category, products) {
    const types = new Set(products.filter((p) => storeCategoryOf(p) === category).map(typeOf).filter(Boolean));
    return [...types].sort();
}

export function colorsFrom(products) {
    const all = new Set();
    products.forEach((p) => colorsOf(p).forEach((c) => all.add(c)));
    return [...all].sort();
}

export function brandsFrom(products) {
    return [...new Set(products.map((p) => brandOf(p)).filter(Boolean))].sort();
}

// ---------------------------------------------------------------- brand names

/** A brand name or spoken words in one comparable form: "One Plus" and "onePlus" -> "oneplus", "H&M" -> "handm". */
const squash = (s) => normalizeText(String(s || "").replace(/&/g, " and ").replace(/'/g, "")).replace(/\b1\b/g, "one").replace(/\s+/g, "");

/**
 * The catalog brand named in the text: { brand, heard? }. Brand names match however they are spaced
 * or written ("one plus", "H&M", "chheda's"). Failing that, one close mishearing of a longer brand
 * ("nikey", "addidas", "samsang") is accepted only if it fits exactly one brand; `heard` is then set
 * and the brand is read back for confirmation like any detail. Returns null otherwise.
 */
export function findBrand(text, brands) {
    const words = normalizeText(String(text || "").replace(/&/g, " and ").replace(/'/g, "")).replace(/\b1\b/g, "one").split(" ").filter(Boolean);
    const runs = [];
    for (let i = 0; i < words.length; i++) {
        for (let len = 1; len <= 4 && i + len <= words.length; len++) runs.push(words.slice(i, i + len).join(""));
    }
    const exact = brands.find((b) => runs.includes(squash(b)));
    if (exact) return { brand: exact };
    const near = new Set();
    let heard = null;
    for (const b of brands) {
        const target = squash(b);
        if (target.length < 4) continue;
        for (const run of runs) {
            if (run.length < 5 || run[0] !== target[0] || run === `${target}s` || target === `${run}s`) continue;
            if (editDistance(run, target) <= (target.length >= 8 ? 2 : 1)) { near.add(b); heard = run; }
        }
    }
    return near.size === 1 ? { brand: [...near][0], heard } : null;
}

/**
 * Pulls shopping details out of what was said, checked against the catalog:
 * { category, type, typeWord, closest, unavailableType, brand, brandHeard, color, colorWord, size,
 *   sizeSystem, budgetMax, budgetMin, quantity }. Missing details are simply absent.
 * options.expect "color": a colour is the answer being asked for, so sound-alike words count ("read" -> red).
 */
export function extractEntities(text, products = [], { expect } = {}) {
    let t = prep(text);
    if (expect === "color") t = t.replace(/\b(read|blew|block)\b/g, (w) => COLOR_SOUNDALIKES[w]);
    const out = {};

    for (const entry of TYPE_WORDS) {
        const word = entry.words.find((w) => hasWord(t, w));
        if (!word) continue;
        out.category = entry.category;
        out.typeWord = word;
        if (entry.type && typesFor(entry.category, products).includes(entry.type)) {
            out.type = entry.type;
            if (entry.closest) out.closest = true;
        } else {
            out.unavailableType = word;
        }
        break;
    }
    if (!out.category) {
        const found = Object.keys(CATEGORY_WORDS).find((c) => CATEGORY_WORDS[c].some((w) => hasWord(t, w)));
        if (found) out.category = found;
    }

    const brand = findBrand(t, brandsFrom(products.filter(isStoreProduct)));
    if (brand) {
        out.brand = brand.brand;
        if (brand.heard) out.brandHeard = brand.heard;
    }

    const catalogColors = colorsFrom(products);
    const colorWord = COLOR_WORDS.find((c) => hasWord(t, c));
    if (colorWord) {
        const wanted = SAME_COLOR[colorWord] || colorWord;
        const match = catalogColors.find((c) => (SAME_COLOR[c] || c) === wanted);
        if (match) out.color = match;
        else out.colorWord = colorWord;
    }

    // Sizes only when clearly meant as a size ("size 9", "UK 9", "128 GB").
    const sizeMatch = t.match(/\bsize\s+(.+?)(?=\s(?:in|and|under|below|for|with|please)\s|\s*$)/);
    const systemMatch = t.match(/\b(uk|us|eu)\s+(\d+(?:\.\d+)?|\w+)\b/);
    const sized = parseShoeSize(sizeMatch ? sizeMatch[1] : systemMatch ? systemMatch[0] : "");
    if (sized) {
        out.size = sized.size;
        if (sized.system || parseSizeSystem(t)) out.sizeSystem = sized.system || parseSizeSystem(t);
    }
    const storage = t.match(/\b(\d+)\s*gb\b/);
    if (storage) out.size = `${storage[1]} GB`;

    const budget = parseBudget(text);
    if (budget && budget.max) out.budgetMax = budget.max;
    if (budget && budget.min) out.budgetMin = budget.min;
    const quantity = parseQuantity(text);
    if (quantity) out.quantity = quantity;

    if (!out.category && out.brand) {
        const branded = products.filter((p) => brandOf(p) === out.brand && isStoreProduct(p));
        const cats = [...new Set(branded.map(storeCategoryOf))];
        if (cats.length === 1) out.category = cats[0];
    }
    return out;
}

// Words that describe what is wanted but never name one product on their own.
const DESCRIBING = new Set([
    ...COLOR_WORDS, ...Object.values(CATEGORY_WORDS).flat(), ...TYPE_WORDS.flatMap((e) => e.words.flatMap((w) => w.split(" "))),
    "size", "uk", "us", "eu", "india", "indian", "pair", "pairs", "one", "some", "new", "good", "nice", "cheap", "cheaper",
    "under", "below", "above", "over", "rupees", "rs", "and", "with", "in", "a", "an", "the", "for", "me", "my",
    "please", "something", "anything", "looking", "need", "want", "show", "find", "get", "of", "to", "i", "im", "am", "is",
    "it", "that", "this", "can", "you", "do", "have", "any", "which", "what", "like", "id", "would",
]);

/**
 * True when the words name a product rather than only describe one: "Nike Air Force 1" and
 * "Vans Old Skool" do; "black shoes", "Nike shoes in size 9" or "sports shoes" do not, even though
 * a product name may contain "Black" or "Nike". Brand names, numbers and sizes alone never count.
 */
export function namesAProduct(text, products = []) {
    const brands = new Set(brandsFrom(products).map((b) => normalizeText(b)));
    const words = normalizeText(String(text || "").replace(/'/g, "")).split(" ").filter(Boolean);
    const describing = (w) => DESCRIBING.has(w) || DESCRIBING.has(w.replace(/s$/, "")) || brands.has(w) || /^\d+(\.\d+)?$/.test(w);
    return words.some((w) => !describing(w));
}

/** Products matching the conversation's details. Products without colour or size data never match a colour or size. */
export function filterProducts(products, s, { ignore = [] } = {}) {
    const skip = new Set(ignore);
    return products.filter((p) => {
        if (!isStoreProduct(p)) return false;
        if (s.category && !skip.has("category") && storeCategoryOf(p) !== s.category) return false;
        if (s.type && !skip.has("type") && typeOf(p) !== s.type) return false;
        if (s.brand && !skip.has("brand") && brandOf(p).toLowerCase() !== s.brand.toLowerCase()) return false;
        if (s.color && !skip.has("color") && !colorsOf(p).includes(s.color)) return false;
        if (s.size && !skip.has("size") && !(Array.isArray(p.size) && isSizeAvailable(s.size, p.size.map(String)))) return false;
        const price = Number(p.price);
        if (s.budgetMax && !skip.has("budget") && !(price <= s.budgetMax)) return false;
        if (s.budgetMin && !skip.has("budget") && !(price >= s.budgetMin)) return false;
        if (s.cheaperThan && !skip.has("budget") && !(price < s.cheaperThan)) return false;
        return true;
    });
}

const validRating = (p) => {
    const r = Number(p.rating);
    return Number.isFinite(r) && r >= 0 && r <= 5 ? r : -1;
};

/** Ranks matches with real data only: cheapest first when price matters, otherwise rating, then price. */
export function rankProducts(products, s = {}) {
    const byPrice = Boolean(s.budgetMax || s.cheaperThan);
    return [...products].sort((a, b) =>
        (byPrice ? Number(a.price) - Number(b.price) : validRating(b) - validRating(a) || Number(a.price) - Number(b.price)) ||
        String(a.name).localeCompare(String(b.name)));
}

/**
 * When nothing matches, which single detail is blocking? Returns, for each detail the shopper set,
 * how many products match without it and what is available instead.
 */
export function alternativesFor(products, s) {
    const out = [];
    for (const field of ["color", "size", "brand", "budget", "type"]) {
        const set = field === "budget" ? s.budgetMax || s.budgetMin || s.cheaperThan : s[field];
        if (!set) continue;
        const without = filterProducts(products, s, { ignore: [field] });
        if (!without.length) continue;
        const options = field === "color" ? colorsFrom(without)
            : field === "size" ? sizesFromProducts(without)
            : field === "brand" ? brandsFrom(without)
            : field === "type" ? [...new Set(without.map(typeOf))]
            : [];
        out.push({ field, count: without.length, options, cheapest: Math.min(...without.map((p) => Number(p.price))) });
    }
    return out;
}
