// The shared catalog service against an in-memory stand-in for Firestore that behaves like the
// real queries (name order with the id as tie-breaker, array-contains-any, limit, startAfter).
import {
    configureCatalog, getCatalogStats, invalidateCatalog, fetchProductPage, createListing, loadCatalog, loadCategory,
    getProduct, loadProductsNamed, loadTopRated, loadCategoryCover, CatalogError, catalogRetryDelay, QUOTA_COOLDOWN_MS,
    SNAPSHOT_TTL_MS, visibleProducts,
} from "../catalogService";

jest.mock("../../components/firebase", () => ({ database: { app: { options: { projectId: "test-project" } } } }));

const byNameThenId = (a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function fakeSource(docs) {
    const calls = [];
    const sorted = () => [...docs].sort(byNameThenId);
    const inCategory = (category) => (d) => d.category.some((c) => String(c).toLowerCase() === category.toLowerCase());
    const failures = [];
    async function answer(call, value) {
        calls.push(call);
        await Promise.resolve();
        if (failures.length) throw failures.shift();
        // Each answer is a new set of objects, as with real snapshots.
        return value().map((d) => JSON.parse(JSON.stringify(d)));
    }
    return {
        calls,
        failNext(...errors) { failures.push(...errors); },
        page: ({ category, after, size }) => answer(["page", category, after ? after.id : undefined, size], () => {
            let list = sorted();
            if (category) list = list.filter(inCategory(category));
            if (after) list = list.filter((d) => byNameThenId(d, after) > 0);
            return list.slice(0, size);
        }),
        unorderedCategory: (category) => answer(["unordered", category], () => docs.filter(inCategory(category))),
        all: () => answer(["all"], () => sorted()),
        byId: (id) => answer(["byId", id], () => docs.filter((d) => d.id === id)),
        byName: (name) => answer(["byName", name], () => docs.filter((d) => d.name === name)),
        topRated: ({ after, size }) => answer(["topRated"], () => {
            const list = docs.filter((d) => typeof d.rating === "number" && d.rating <= 5)
                .sort((a, b) => b.rating - a.rating || (a.id < b.id ? 1 : -1));
            const start = after ? list.findIndex((d) => d.id === after.id) + 1 : 0;
            return list.slice(start, start + size);
        }),
        cover: (category, size) => answer(["cover", category], () => docs.filter(inCategory(category)).filter((d) => typeof d.rating === "number" && d.rating <= 5)
            .sort((a, b) => b.rating - a.rating || (a.id < b.id ? 1 : -1)).slice(0, size)),
        anyInCategory: (category, size) => answer(["any", category], () => docs.filter(inCategory(category)).slice(0, size)),
    };
}

const product = (id, name, category, extra = {}) => ({
    id, name, price: 1000, description: `${name} description`, image: [], rating: 4, category: [category, "type", "brand"], ...extra,
});

/** 40 distinct shoes, 30 electronics, 10 food: 80 documents, no copies. */
function plainCatalog() {
    const docs = [];
    for (let i = 0; i < 40; i += 1) docs.push(product(`s${String(i).padStart(2, "0")}`, `Shoe ${String(i).padStart(2, "0")}`, "shoes"));
    for (let i = 0; i < 30; i += 1) docs.push(product(`e${String(i).padStart(2, "0")}`, `Gadget ${String(i).padStart(2, "0")}`, "electronics"));
    for (let i = 0; i < 10; i += 1) docs.push(product(`f${i}`, `Snack ${i}`, "food"));
    return docs;
}

/** Like the live catalog: every product stored six times; for one, a single copy also lists sizes. */
function copiedCatalog() {
    const docs = [];
    for (let i = 0; i < 10; i += 1) {
        for (let copy = 0; copy < 6; copy += 1) {
            const extra = i === 3 && copy === 4 ? { size: ["7", "8", "9"] } : {};
            docs.push(product(`p${i}c${copy}`, `Shoe ${i}`, "shoes", extra));
        }
    }
    return docs;
}

let clock;
let sleeps;
function setup(docs) {
    const source = fakeSource(docs);
    clock = 1_000_000;
    sleeps = [];
    configureCatalog({ source, now: () => clock, sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0.5 });
    return source;
}

beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

test("a first page reads no more documents than the page size", async () => {
    const source = setup(plainCatalog());
    const page = await fetchProductPage({ category: "shoes", pageSize: 24 });
    expect(page.docs).toHaveLength(24);
    expect(page.done).toBe(false);
    expect(source.calls).toEqual([["page", "shoes", undefined, 24]]);
    expect(getCatalogStats().reads).toBe(24);
});

test("the next page continues from the cursor and never fetches the first page again", async () => {
    const source = setup(plainCatalog());
    const first = await fetchProductPage({ category: "shoes", pageSize: 24 });
    const second = await fetchProductPage({ category: "shoes", pageSize: 24, cursor: first.cursor });
    expect(second.docs.map((d) => d.id)).toEqual(Array.from({ length: 16 }, (_, i) => `s${String(i + 24).padStart(2, "0")}`));
    expect(second.done).toBe(true);
    // Going back to the first page uses the cache.
    await fetchProductPage({ category: "shoes", pageSize: 24 });
    expect(source.calls).toEqual([["page", "shoes", undefined, 24], ["page", "shoes", "s23", 24]]);
    expect(getCatalogStats().reads).toBe(40);
});

test("identical requests made at the same time share one Firestore call", async () => {
    const source = setup(plainCatalog());
    const [a, b, c] = await Promise.all([
        fetchProductPage({ category: "shoes" }), fetchProductPage({ category: "shoes" }), fetchProductPage({ category: "shoes" }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(source.calls).toHaveLength(1);
});

test("a category listing pages through that category only, without repeats", async () => {
    setup(plainCatalog());
    const listing = createListing({ category: "electronics", pageSize: 12 });
    const first = await listing.more();
    expect(first.products.length).toBeGreaterThanOrEqual(12);
    expect(first.done).toBe(false);
    let result = first;
    while (!result.done) result = await listing.more();
    const ids = result.products.map((p) => p.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(result.products.every((p) => p.category[0] === "electronics")).toBe(true);
    expect(ids).toEqual([...ids].sort());
});

test("a double click on Show more loads once", async () => {
    const source = setup(plainCatalog());
    const listing = createListing({ category: "shoes", pageSize: 10 });
    await listing.more();
    const before = source.calls.length;
    const [a, b] = await Promise.all([listing.more(), listing.more()]);
    expect(a).toBe(b);
    expect(source.calls.length - before).toBe(1);
});

test("with copied documents every product appears once, as its most complete copy, across pages", async () => {
    const source = setup(copiedCatalog());
    const listing = createListing({ category: "shoes", pageSize: 4 });
    let result = await listing.more();
    const seen = [...result.products];
    while (!result.done) {
        const before = result.products.length;
        result = await listing.more();
        seen.push(...result.products.slice(before));
    }
    expect(seen.map((p) => p.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Shoe ${i}`));
    expect(seen.find((p) => p.name === "Shoe 3").size).toEqual(["7", "8", "9"]);
    expect(source.calls.every(([kind]) => kind === "page")).toBe(true);
});

test("while more pages remain, the last name is held back until its copies are loaded", () => {
    const docs = [product("a1", "Alpha", "shoes"), product("b1", "Beta", "shoes"), product("b2", "Beta", "shoes", { size: ["9"] })];
    expect(visibleProducts(docs, false).map((p) => p.name)).toEqual(["Alpha"]);
    expect(visibleProducts(docs, true).map((p) => p.id)).toEqual(["a1", "b2"]);
});

test("one Show more never reads more than six pages, however many copies there are", async () => {
    const docs = [];
    for (let i = 0; i < 400; i += 1) docs.push(product(`x${String(i).padStart(3, "0")}`, "Same name", "shoes"));
    const source = setup(docs);
    const listing = createListing({ category: "shoes", pageSize: 24 });
    const result = await listing.more();
    expect(source.calls).toHaveLength(6);
    expect(result.done).toBe(false);
    expect(result.products).toEqual([]);
});

test("after a product changes, invalidating the catalog shows the new data", async () => {
    const docs = plainCatalog();
    const source = setup(docs);
    expect((await getProduct("s01")).price).toBe(1000);
    docs.find((d) => d.id === "s01").price = 1500;
    expect((await getProduct("s01")).price).toBe(1000); // cached for a minute
    invalidateCatalog();
    expect((await getProduct("s01")).price).toBe(1500);
    expect(source.calls.filter(([kind]) => kind === "byId")).toHaveLength(2);
});

test("a product page reads its product and that product's copies, never the whole catalog", async () => {
    const source = setup(copiedCatalog());
    const shown = await getProduct("p3c0");
    expect(shown.id).toBe("p3c4"); // the copy that lists sizes
    expect(source.calls).toEqual([["byId", "p3c0"], ["byName", "Shoe 3"]]);
    expect(getCatalogStats().reads).toBe(7);
    expect(await getProduct("../users/x")).toBeNull();
    expect(source.calls).toHaveLength(2);
});

test("a quota error is not retried, and nothing is requested until the cool-down ends", async () => {
    const source = setup(plainCatalog());
    source.failNext(Object.assign(new Error("Quota exceeded."), { code: "resource-exhausted" }));
    const error = await fetchProductPage({ category: "shoes" }).catch((e) => e);
    expect(error).toBeInstanceOf(CatalogError);
    expect(error.kind).toBe("quota");
    expect(error.message).toMatch(/Your cart hasn't been changed/);
    expect(source.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);

    // Other screens and Zoro fail at once without another request.
    await expect(loadCategory("food")).rejects.toMatchObject({ kind: "quota" });
    await expect(loadCatalog()).rejects.toMatchObject({ kind: "quota" });
    expect(source.calls).toHaveLength(1);
    expect(catalogRetryDelay()).toBe(QUOTA_COOLDOWN_MS);

    clock += QUOTA_COOLDOWN_MS;
    expect((await fetchProductPage({ category: "shoes" })).docs).toHaveLength(24);
    expect(source.calls).toHaveLength(2);
});

test("temporary network errors are retried twice with growing, jittered delays", async () => {
    const source = setup(plainCatalog());
    const unavailable = () => Object.assign(new Error("offline"), { code: "unavailable" });
    source.failNext(unavailable(), unavailable());
    const page = await fetchProductPage({ category: "food" });
    expect(page.docs).toHaveLength(10);
    expect(source.calls).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]); // half the cap plus jitter (0.5 here) of 500 ms, then 1000 ms

    source.failNext(unavailable(), unavailable(), unavailable());
    const error = await fetchProductPage({ category: "shoes" }).catch((e) => e);
    expect(error.kind).toBe("transient");
    expect(source.calls).toHaveLength(6);
});

test("a failed load is an error, never an empty catalog", async () => {
    const source = setup(plainCatalog());
    source.failNext(Object.assign(new Error("denied"), { code: "permission-denied" }));
    await expect(loadCatalog()).rejects.toBeInstanceOf(CatalogError);
    expect(source.calls).toHaveLength(1);
});

test("Zoro's category search reads that category, not the whole catalog", async () => {
    const source = setup(plainCatalog());
    const shoes = await loadCategory("Shoes");
    expect(shoes).toHaveLength(40);
    expect(source.calls.every(([kind, category]) => kind === "page" && category === "Shoes")).toBe(true);
    expect(getCatalogStats().reads).toBe(40);
    await loadCategory("Shoes");
    expect(getCatalogStats().reads).toBe(40);
});

test("a listing of a fully loaded category is served without new reads", async () => {
    const source = setup(plainCatalog());
    await loadCategory("food");
    const calls = source.calls.length;
    const result = await createListing({ category: "food" }).more();
    expect(result.products).toHaveLength(10);
    expect(source.calls).toHaveLength(calls);
});

test("the whole catalog is read once and reused, also after a reload, until it is ten minutes old", async () => {
    const docs = plainCatalog();
    const source = setup(docs);
    expect(await loadCatalog()).toHaveLength(80);
    expect(await loadCatalog()).toHaveLength(80);
    expect(source.calls).toEqual([["all"]]);

    // A reload: memory is empty, the stored public snapshot is used.
    configureCatalog({ source, now: () => clock });
    expect(await loadCatalog()).toHaveLength(80);
    expect(source.calls).toEqual([["all"]]);
    const stored = JSON.parse(window.localStorage.getItem("vc-catalog-v1:test-project"));
    expect(Object.keys(stored)).toEqual(["at", "docs"]);

    clock += SNAPSHOT_TTL_MS;
    configureCatalog({ source, now: () => clock });
    await loadCatalog();
    expect(source.calls).toEqual([["all"], ["all"]]);
});

test("when the category index is missing, the category is read once without paging instead of failing", async () => {
    const source = setup(plainCatalog());
    source.failNext(Object.assign(new Error("The query requires an index."), { code: "failed-precondition" }));
    const page = await fetchProductPage({ category: "food", pageSize: 4 });
    expect(page.docs.map((d) => d.id)).toEqual(["f0", "f1", "f2", "f3"]);
    const next = await fetchProductPage({ category: "food", pageSize: 4, cursor: page.cursor });
    expect(next.docs.map((d) => d.id)).toEqual(["f4", "f5", "f6", "f7"]);
    expect(source.calls).toEqual([["page", "food", undefined, 4], ["unordered", "food"]]);
});

test("the home page reads a few top-rated products and one picture per category", async () => {
    const docs = plainCatalog();
    docs[5].rating = 5;
    docs[45].rating = 4.8;
    docs.push(product("odd", "Odd one", "los", { rating: 5 }));
    const source = setup(docs);
    const top = await loadTopRated(4);
    expect(top[0].id).toBe("s05");
    expect(top.some((p) => p.id === "odd")).toBe(false); // not a store category
    expect((await loadCategoryCover("shoes")).id).toBe("s05");
    expect(source.calls.map(([kind]) => kind)).toEqual(["topRated", "cover"]);
    expect(getCatalogStats().reads).toBe(24 + 6);
    expect(await loadProductsNamed(["Shoe 05", "Shoe 05"])).toHaveLength(1);
});

test("image lists survive paging, merging copies, caching and the stored snapshot unchanged", async () => {
    const docs = copiedCatalog().map((d, i) => ({ ...d, image: [`/images/shoe${i}a.png`, `/images/shoe${i}b.png`] }));
    const source = setup(docs);
    const listing = createListing({ category: "shoes", pageSize: 4 });
    let result = await listing.more();
    while (!result.done) result = await listing.more();
    for (const p of result.products) expect(p.image).toEqual(docs.find((d) => d.id === p.id).image);

    await loadCatalog();
    configureCatalog({ source, now: () => clock }); // a reload: the snapshot comes from storage
    const fromStorage = await loadCatalog();
    expect(fromStorage.find((p) => p.id === "p3c4").image).toEqual(["/images/shoe22a.png", "/images/shoe22b.png"]);
    expect((await getProduct("p3c4")).image).toEqual(["/images/shoe22a.png", "/images/shoe22b.png"]);
});

test("a category picture skips top products without a usable image, and breaks rating ties by name", async () => {
    const docs = [
        product("zz-test", "test", "electronics", { rating: 5, image: ["/images/test-1.png"] }),
        product("yy-watch", "watch", "electronics", { rating: 5, image: ["/images/watch-1.png"] }),
        product("e-hp", "HP Pavilion 14", "electronics", { rating: 5, image: ["/images/hp1.png"] }),
        product("e-asus", "ASUS Zenbook", "electronics", { rating: 4.4, image: ["/images/asus1.png"] }),
    ];
    setup(docs);
    const usable = (p) => !p.image.some((i) => /test-|watch-/.test(i));
    expect((await loadCategoryCover("electronics", { usable })).id).toBe("e-hp");
    expect(await loadCategoryCover("electronics", { usable: () => false })).toBeNull();
});

test("a rating above 5 (not shown by the store) never chooses a category picture", async () => {
    const source = setup([
        product("bad", "maggiu", "food", { rating: 6, image: ["/images/prod11.png"] }),
        product("ok", "Chilli Chatka", "food", { rating: 4.5, image: ["/images/kurkure1.png"] }),
    ]);
    expect((await loadCategoryCover("food")).id).toBe("ok");
    // The same rule applies when the category is already in memory.
    await loadCategory("food");
    expect((await loadCategoryCover("food")).id).toBe("ok");
    expect(source.calls.map(([k]) => k)).toEqual(["cover", "page"]);
});
