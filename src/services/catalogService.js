/**
 * The one place the browser reads products from Firestore.
 *
 * Firestore's quota counts document reads (the free tier allows 50,000 a day) and the live catalog
 * holds 442 documents, most of them copies of about 70 products. So each screen reads only what it
 * shows:
 *  - listings read one page at a time in name order (cursor pagination; the document id breaks ties);
 *  - a product page reads its product and that product's copies (to show the most complete copy);
 *  - a wishlist reads its saved products, and the home page a few top-rated ones;
 *  - Zoro reads the category being shopped;
 *  - only search, and a product named without a category, read the whole catalog. That snapshot is
 *    shared by every caller and reused for SNAPSHOT_TTL_MS, also across reloads (it is public product
 *    data; nothing about the shopper is stored with it).
 * Identical requests in flight share one call. After a quota error nothing is requested for
 * QUOTA_COOLDOWN_MS; temporary network errors are retried twice with backoff and jitter; a failed
 * load is an error, never an empty catalog.
 * Cached prices can be a few minutes old: checkout always re-reads prices and stock on the server.
 */
import { collection, query, where, orderBy, limit, startAfter, getDocsFromServer, getDocFromServer, doc, documentId } from "firebase/firestore";
import { database } from "../components/firebase";
import { dedupeProducts, keptCopyOf, categoryOf } from "./productMatching";
import { CATEGORIES } from "./storeCategories";

const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/** Documents per Firestore request, and products added to a listing per "Show more". */
export const CATALOG_PAGE_SIZE = positive(process.env.REACT_APP_CATALOG_PAGE_SIZE, 24);
export const LIST_TTL_MS = 5 * 60 * 1000;
export const PRODUCT_TTL_MS = 60 * 1000;
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
export const QUOTA_COOLDOWN_MS = 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
// One "Show more" reads at most this many pages, however many copies the catalog holds.
const MAX_REQUESTS_PER_STEP = 6;
const COPIES_LIMIT = 25;
const CATEGORY_PAGE_SIZE = 100;
// Candidates read for a category's picture, so a top product without a usable image can be skipped.
const COVER_CANDIDATES = 6;
const STORE_CATEGORIES = CATEGORIES.map((c) => c.toLowerCase());

// ---------------------------------------------------------------- errors

const MESSAGES = {
    quota: "The product catalog can't be loaded right now because the store has reached its database usage limit. Your cart hasn't been changed. Please try again later.",
    transient: "The product catalog couldn't be loaded. Check your internet connection and try again. Your cart hasn't been changed.",
    other: "The product catalog couldn't be loaded right now. Your cart hasn't been changed. Please try again later.",
};

/** A catalog request that failed. `kind` is "quota", "transient", "index" or "other"; the message is safe to show. */
export class CatalogError extends Error {
    constructor(kind, code) {
        super(MESSAGES[kind] || MESSAGES.other);
        this.name = "CatalogError";
        this.kind = kind;
        this.code = code || "";
    }
}

export function classifyCatalogError(error) {
    const code = String((error && error.code) || "").replace(/^firestore\//, "");
    if (code === "resource-exhausted") return "quota";
    if (code === "unavailable" || code === "deadline-exceeded") return "transient";
    // For queries this means the composite index is missing (see firestore.indexes.json).
    if (code === "failed-precondition") return "index";
    if (!code && error && /network|offline|failed to fetch/i.test(String(error.message))) return "transient";
    return "other";
}

/** The text to show or speak for any catalog failure. */
export function catalogErrorMessage(error) {
    return error && error.name === "CatalogError" ? error.message : MESSAGES.other;
}

// ---------------------------------------------------------------- Firestore access

const withId = (snap) => ({ id: snap.id, ...snap.data() });

/** Spellings a category may be stored with; the seed data uses lower case. */
function categoryValues(category) {
    const lower = String(category).toLowerCase();
    return [...new Set([lower, lower.charAt(0).toUpperCase() + lower.slice(1)])];
}

/**
 * Product queries against one Firestore database. Every method resolves to an array of { id, ...data }.
 * Reads always go to the server: offline, plain getDocs() answers from the SDK's memory cache, which
 * is usually empty, and an unreachable server would look like a catalog with no products.
 */
export function createFirestoreSource(db, collectionName = "products") {
    const products = () => collection(db, collectionName);
    const run = async (...parts) => (await getDocsFromServer(query(products(), ...parts))).docs.map(withId);
    const inCategory = (category) => where("category", "array-contains-any", categoryValues(category));
    return {
        page({ category, after, size }) {
            const parts = category ? [inCategory(category)] : [];
            parts.push(orderBy("name"), orderBy(documentId()));
            if (after) parts.push(startAfter(after.name, after.id));
            return run(...parts, limit(size));
        },
        /** A whole category in id order: used only while the category index is not deployed. */
        unorderedCategory(category) {
            return run(inCategory(category));
        },
        all() {
            return run(orderBy("name"));
        },
        async byId(id) {
            const snap = await getDocFromServer(doc(db, collectionName, id));
            return snap.exists() ? [withId(snap)] : [];
        },
        byName(name) {
            return run(where("name", "==", name), limit(COPIES_LIMIT));
        },
        topRated({ after, size }) {
            // The range keeps only numeric ratings up to 5 (the ones the store shows).
            const parts = [where("rating", "<=", 5), orderBy("rating", "desc"), orderBy(documentId(), "desc")];
            if (after) parts.push(startAfter(after.rating, after.id));
            return run(...parts, limit(size));
        },
        cover(category, size) {
            // Ratings above 5 are not shown by the store (see ratingOf in products.js), so they never win.
            return run(inCategory(category), where("rating", "<=", 5), orderBy("rating", "desc"), limit(size));
        },
        anyInCategory(category, size) {
            return run(inCategory(category), limit(size));
        },
    };
}

// ---------------------------------------------------------------- shared state

let source = null;
let clock = () => Date.now();
let pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let random = Math.random;
const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> promise
const categories = new Map(); // category -> { at, docs } for a fully loaded category
let snapshot = null; // { at, docs, products }
let storageChecked = false;
let generation = 0;
let quotaUntil = 0;
const stats = { requests: 0, reads: 0, cacheHits: 0 };
const warned = new Set();

const activeSource = () => source || (source = createFirestoreSource(database));
const projectId = () => (database && database.app && database.app.options && database.app.options.projectId) || "default";
const storageKey = () => `vc-catalog-v1:${projectId()}`;

/** Tests swap in a fake source, clock and timers. Everything cached is dropped. */
export function configureCatalog({ source: next = null, now = () => Date.now(), sleep, rand = Math.random } = {}) {
    source = next;
    clock = now;
    pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    random = rand;
    quotaUntil = 0;
    // Like a page load: memory is empty and this browser's stored snapshot is read again.
    forgetMemory();
    storageChecked = false;
    resetCatalogStats();
}

/** Requests sent, documents read (what the quota counts) and answers served from memory. */
export function getCatalogStats() {
    return { ...stats };
}

export function resetCatalogStats() {
    stats.requests = 0;
    stats.reads = 0;
    stats.cacheHits = 0;
}

function forgetMemory() {
    generation += 1;
    cache.clear();
    inflight.clear();
    categories.clear();
    snapshot = null;
}

/** Drops every cached product, here and in this browser's storage (after an admin change). */
export function invalidateCatalog() {
    forgetMemory();
    storageChecked = true;
    try {
        window.localStorage.removeItem(storageKey());
    } catch (e) {
        // Storage can be unavailable (private mode); there is then nothing to remove.
    }
}

/** Milliseconds until catalog requests are allowed again after a quota error (0 when allowed). */
export function catalogRetryDelay() {
    return Math.max(0, quotaUntil - clock());
}

function logOnce(text) {
    if (warned.has(text)) return;
    warned.add(text);
    console.warn(text);
}

/** Runs one request with the retry policy; `load` resolves to an array of documents. */
async function request(operation, load) {
    for (let attempt = 0; ; attempt += 1) {
        if (clock() < quotaUntil) throw new CatalogError("quota", "resource-exhausted");
        try {
            stats.requests += 1;
            const docs = await load();
            // Firestore bills each returned document, and at least one read per query.
            stats.reads += Math.max(1, docs.length);
            return docs;
        } catch (error) {
            const kind = classifyCatalogError(error);
            // Codes only: messages can contain request details that do not belong in logs.
            console.warn(`[catalog] ${operation} failed: ${kind}${error && error.code ? ` (${error.code})` : ""}`);
            if (kind === "quota") {
                // Retrying would only use up more quota; wait, and let the shopper decide when to try again.
                quotaUntil = clock() + QUOTA_COOLDOWN_MS;
                throw new CatalogError("quota", error.code);
            }
            if (kind === "transient" && attempt < MAX_RETRIES) {
                const cap = RETRY_BASE_MS * 2 ** attempt;
                await pause(cap / 2 + random() * (cap / 2));
                continue;
            }
            throw new CatalogError(kind, error && error.code);
        }
    }
}

/** One piece of work shared by everyone asking for the same key while it runs. */
function shared(key, work) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = work().finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
}

/** A shared request whose result is reused for `ttl` ms (unless the catalog was invalidated meanwhile). */
async function cached(key, ttl, operation, load) {
    const hit = cache.get(key);
    if (hit && clock() - hit.at < ttl) {
        stats.cacheHits += 1;
        return hit.value;
    }
    const startedIn = generation;
    const value = await shared(key, () => request(operation, load));
    if (startedIn === generation) cache.set(key, { at: clock(), value });
    return value;
}

// ---------------------------------------------------------------- the whole catalog

const byNameThenId = (a, b) => {
    const an = String(a.name);
    const bn = String(b.name);
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function rememberSnapshot(docs) {
    const sorted = [...docs].sort(byNameThenId);
    snapshot = { at: clock(), docs: sorted, products: dedupeProducts(sorted) };
    try {
        window.localStorage.setItem(storageKey(), JSON.stringify({ at: snapshot.at, docs: sorted }));
    } catch (e) {
        // Full or blocked storage only means the next page load reads the catalog again.
    }
}

function freshSnapshot() {
    if (snapshot && clock() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
    // Storage is read once per page load; after that the copy in memory is at least as new.
    if (storageChecked) return null;
    storageChecked = true;
    try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey()) || "null");
        if (saved && Array.isArray(saved.docs) && typeof saved.at === "number" && clock() - saved.at < SNAPSHOT_TTL_MS && saved.at <= clock()) {
            snapshot = { at: saved.at, docs: saved.docs, products: dedupeProducts(saved.docs) };
            return snapshot;
        }
    } catch (e) {
        // Unreadable storage is treated as empty.
    }
    return null;
}

/**
 * Every product (copies merged). Reads the whole collection, so it is only for search and for a
 * product named without a category; the result is shared and reused for SNAPSHOT_TTL_MS.
 */
export async function loadCatalog() {
    const fresh = freshSnapshot();
    if (fresh) {
        stats.cacheHits += 1;
        return fresh.products;
    }
    const startedIn = generation;
    const docs = await shared("all", () => request("catalog", () => activeSource().all()));
    if (startedIn === generation) rememberSnapshot(docs);
    return dedupeProducts([...docs].sort(byNameThenId));
}

/** Every product document, copies included (admin). */
export async function loadAllProductDocuments() {
    const fresh = freshSnapshot();
    if (fresh) {
        stats.cacheHits += 1;
        return fresh.docs;
    }
    const startedIn = generation;
    const docs = await shared("all", () => request("catalog", () => activeSource().all()));
    if (startedIn === generation) rememberSnapshot(docs);
    return [...docs].sort(byNameThenId);
}

// ---------------------------------------------------------------- pages and categories

const inCategory = (category) => (p) => categoryOf(p).toLowerCase() === String(category).toLowerCase();

/** Fully loaded documents for a category (or all of them), if any are fresh: no request needed. */
function knownDocs(category) {
    const all = freshSnapshot();
    if (all) return category ? all.docs.filter(inCategory(category)) : all.docs;
    if (!category) return null;
    const entry = categories.get(category.toLowerCase());
    return entry && clock() - entry.at < LIST_TTL_MS ? entry.docs : null;
}

function rememberCategory(category, docs) {
    categories.set(category.toLowerCase(), { at: clock(), docs: [...docs].sort(byNameThenId) });
}

function pageOf(docs, cursor, size) {
    const start = cursor ? docs.findIndex((d) => byNameThenId(d, cursor) > 0) : 0;
    const from = start === -1 ? docs.length : start;
    const page = docs.slice(from, from + size);
    return { docs: page, cursor: page.length ? cursorOf(page) : cursor, done: from + size >= docs.length };
}

const cursorOf = (docs) => ({ name: docs[docs.length - 1].name, id: docs[docs.length - 1].id });

async function categoryWithoutIndex(category) {
    logOnce("[catalog] The Firestore index for category pages is missing; reading the category unpaged. Deploy firestore.indexes.json.");
    const docs = await shared(`unordered:${category}`, () => request("category", () => activeSource().unorderedCategory(category)));
    rememberCategory(category, docs.filter(inCategory(category)));
    return knownDocs(category);
}

/**
 * One page of product documents in name order (copies included, not filtered):
 * { docs, cursor, done }. Pass the returned cursor to get the next page.
 */
export async function fetchProductPage({ category = null, cursor = null, pageSize = CATALOG_PAGE_SIZE } = {}) {
    const known = knownDocs(category);
    if (known) {
        stats.cacheHits += 1;
        return pageOf(known, cursor, pageSize);
    }
    const key = `page:${category || "*"}:${cursor ? `${cursor.name}\u0000${cursor.id}` : ""}:${pageSize}`;
    try {
        const docs = await cached(key, LIST_TTL_MS, "page", () => activeSource().page({ category, after: cursor, size: pageSize }));
        return { docs, cursor: docs.length ? cursorOf(docs) : cursor, done: docs.length < pageSize };
    } catch (error) {
        if (!(error.kind === "index" && category)) throw error;
        return pageOf(await categoryWithoutIndex(category), cursor, pageSize);
    }
}

/** Every product in one category (copies merged), read page by page and kept for LIST_TTL_MS. Used by Zoro. */
export async function loadCategory(category) {
    const known = knownDocs(category);
    if (known) {
        stats.cacheHits += 1;
        return dedupeProducts(known);
    }
    return shared(`category:${category.toLowerCase()}`, async () => {
        const startedIn = generation;
        let docs = [];
        let cursor = null;
        for (;;) {
            const page = await fetchProductPage({ category, cursor, pageSize: CATEGORY_PAGE_SIZE });
            docs = docs.concat(page.docs);
            cursor = page.cursor;
            if (page.done) break;
        }
        const inside = docs.filter(inCategory(category));
        if (startedIn === generation) rememberCategory(category, inside);
        return dedupeProducts([...inside].sort(byNameThenId));
    });
}

/**
 * The products a listing can show from the documents loaded so far: name order, one card per
 * product. Copies share a name, so they sit next to each other; while more pages remain, the last
 * name is held back because its other copies may be on the next page.
 */
export function visibleProducts(docs, done) {
    let end = docs.length;
    if (!done && end) {
        const last = docs[end - 1].name;
        while (end > 0 && docs[end - 1].name === last) end -= 1;
    }
    return dedupeProducts(docs.slice(0, end));
}

const isStoreProduct = (p) => STORE_CATEGORIES.includes(categoryOf(p).toLowerCase());

/**
 * A paged listing of one category, or of every store category when `category` is null.
 * more() adds about `pageSize` products (reading at most MAX_REQUESTS_PER_STEP pages) and resolves to
 * { products, done }. Calls made while one is running share it, so a double click loads once.
 */
export function createListing({ category = null, pageSize = CATALOG_PAGE_SIZE } = {}) {
    const wanted = category ? inCategory(category) : isStoreProduct;
    let docs = [];
    let cursor = null;
    let done = false;
    let running = null;
    const shown = () => visibleProducts(docs, done).filter(wanted);

    function more() {
        if (running) return running;
        running = (async () => {
            const before = shown().length;
            for (let i = 0; i < MAX_REQUESTS_PER_STEP && !done; i += 1) {
                const page = await fetchProductPage({ category, cursor, pageSize });
                docs = docs.concat(page.docs);
                cursor = page.cursor;
                done = page.done;
                if (shown().length - before >= pageSize) break;
            }
            // A listing read to the end is the whole category (or catalog): later screens reuse it.
            if (done && !knownDocs(category)) {
                if (category) rememberCategory(category, docs.filter(wanted));
                else rememberSnapshot(docs);
            }
            return { products: shown(), done };
        })().finally(() => {
            running = null;
        });
        return running;
    }

    return {
        more,
        get products() {
            return shown();
        },
        get done() {
            return done;
        },
    };
}

// ---------------------------------------------------------------- single products

/** All copies of a product name (the live catalog stores many). */
async function copiesNamed(name) {
    const all = freshSnapshot();
    if (all) return all.docs.filter((d) => d.name === name);
    return cached(`name:${name}`, LIST_TTL_MS, "copies", () => activeSource().byName(name));
}

/** The products with these names, copies merged (wishlist, home page). */
export async function loadProductsNamed(names) {
    const unique = [...new Set(names.filter((n) => typeof n === "string" && n))];
    const groups = await Promise.all(unique.map(copiesNamed));
    return dedupeProducts(groups.flat());
}

/**
 * A product for its page: the document is read fresh (current price, at most PRODUCT_TTL_MS old),
 * shown as the most complete copy of that product. Resolves to null if it does not exist.
 */
export async function getProduct(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const found = await cached(`id:${id}`, PRODUCT_TTL_MS, "product", () => activeSource().byId(id));
    if (!found.length) return null;
    const copies = await copiesNamed(found[0].name);
    const fresh = copies.map((c) => (c.id === id ? found[0] : c));
    return keptCopyOf(found[0], fresh);
}

/** Up to `count` of the highest-rated store products (real ratings only). */
export async function loadTopRated(count) {
    const all = freshSnapshot();
    let docs = [];
    if (all) {
        stats.cacheHits += 1;
        docs = all.docs;
    } else {
        let after = null;
        for (let i = 0; i < 3; i += 1) {
            const from = after;
            const page = await cached(`top:${from ? `${from.rating}\u0000${from.id}` : ""}`, LIST_TTL_MS, "top-rated",
                () => activeSource().topRated({ after: from, size: CATALOG_PAGE_SIZE }));
            docs = docs.concat(page);
            if (page.length < CATALOG_PAGE_SIZE) break;
            after = { rating: page[page.length - 1].rating, id: page[page.length - 1].id };
            if (dedupeProducts(docs).filter(isStoreProduct).length >= count) break;
        }
    }
    return dedupeProducts(docs).filter(isStoreProduct);
}

// Same rule as the store's ratingOf(): only numbers from 0 to 5 count as ratings.
const shownRating = (p) => {
    const r = Number(p && p.rating);
    return p && p.rating !== "" && p.rating !== null && Number.isFinite(r) && r >= 0 && r <= 5 ? r : -1;
};
const byRatingThenName = (a, b) => shownRating(b) - shownRating(a) || String(a.name).localeCompare(String(b.name));

/**
 * The product whose picture represents a category on the home page: the highest rated (ties by
 * name) among a few top-rated candidates for which `usable` is true (it has an image that can be
 * shown). Null when none qualifies.
 */
export async function loadCategoryCover(category, { usable = () => true } = {}) {
    const pick = (docs) => [...docs].sort(byRatingThenName).find(usable) || null;
    const known = knownDocs(category);
    if (known) {
        stats.cacheHits += 1;
        return pick(known);
    }
    try {
        return pick(await cached(`cover:${category}`, LIST_TTL_MS, "cover", () => activeSource().cover(category, COVER_CANDIDATES)));
    } catch (error) {
        if (error.kind !== "index") throw error;
        logOnce("[catalog] The Firestore index for category pictures is missing; using any products. Deploy firestore.indexes.json.");
        return pick(await cached(`any:${category}`, LIST_TTL_MS, "cover", () => activeSource().anyInCategory(category, COVER_CANDIDATES)));
    }
}

// Development builds expose the counters so read savings can be measured in the browser.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    window.__voicecartCatalogStats = getCatalogStats;
}
