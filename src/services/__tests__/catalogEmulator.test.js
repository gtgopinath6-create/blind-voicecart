/**
 * @jest-environment node
 */
// The real Firestore queries of the catalog service against the Firestore emulator. Read-only: it
// never writes. Runs only when CATALOG_EMULATOR_HOST is set, for example:
//   CATALOG_EMULATOR_HOST=127.0.0.1:8181 CI=true npm test -- catalogEmulator
// The emulator does not require composite indexes, so this cannot prove that
// firestore.indexes.json is deployed; it checks ordering, cursors, filters and read counts.
import { initializeApp, deleteApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, terminate } from "firebase/firestore";
import { createFirestoreSource, configureCatalog, createListing, getCatalogStats, loadCategory, fetchProductPage } from "../catalogService";

jest.mock("../../components/firebase", () => ({ database: null }));

const host = process.env.CATALOG_EMULATOR_HOST;
const maybe = host ? describe : describe.skip;

maybe("catalog queries on the Firestore emulator", () => {
    let app;
    let db;
    let source;
    let everything;

    beforeAll(async () => {
        app = initializeApp({ projectId: process.env.CATALOG_EMULATOR_PROJECT || "demo-voicecart", apiKey: "demo-key" }, "catalog-emulator-test");
        db = getFirestore(app);
        const [h, port] = host.split(":");
        connectFirestoreEmulator(db, h, Number(port));
        source = createFirestoreSource(db);
        everything = await source.all();
    });

    afterAll(async () => {
        await terminate(db);
        await deleteApp(app);
    });

    beforeEach(() => configureCatalog({ source }));

    const key = (d) => `${d.name}\u0000${d.id}`;

    test("paging with a cursor returns every document once, in name-then-id order, never more than a page at a time", async () => {
        expect(everything.length).toBeGreaterThan(10);
        const seen = [];
        let after = null;
        for (;;) {
            const page = await source.page({ category: null, after, size: 10 });
            expect(page.length).toBeLessThanOrEqual(10);
            seen.push(...page);
            if (page.length < 10) break;
            after = { name: page[page.length - 1].name, id: page[page.length - 1].id };
        }
        expect(seen.map(key)).toEqual(everything.map(key));
        expect(new Set(seen.map((d) => d.id)).size).toBe(seen.length);
        const sorted = [...seen].sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.id < b.id ? -1 : 1));
        expect(seen.map(key)).toEqual(sorted.map(key));
    });

    test("category pages contain only that category and add up to the whole category", async () => {
        const expected = everything.filter((d) => Array.isArray(d.category) && d.category.includes("electronics"));
        const seen = [];
        let after = null;
        for (;;) {
            const page = await source.page({ category: "electronics", after, size: 7 });
            seen.push(...page);
            if (page.length < 7) break;
            after = { name: page[page.length - 1].name, id: page[page.length - 1].id };
        }
        expect(seen.every((d) => d.category.includes("electronics"))).toBe(true);
        expect(seen.map(key)).toEqual(expected.map(key));
    });

    test("a listing's first page reads only that page from Firestore", async () => {
        const listing = createListing({ category: "electronics", pageSize: 5 });
        const first = await listing.more();
        const stats = getCatalogStats();
        expect(first.products.length).toBeGreaterThanOrEqual(5);
        expect(stats.reads).toBeLessThan(everything.length);
        expect(stats.reads).toBe(stats.requests * 5);
    });

    test("Zoro's category read costs one read per document in that category", async () => {
        const shoes = everything.filter((d) => d.category[0] === "shoes");
        const products = await loadCategory("Shoes");
        expect(products.length).toBe(shoes.length);
        expect(getCatalogStats().reads).toBe(shoes.length);
        // A second page request for that category is answered from the loaded category.
        await fetchProductPage({ category: "shoes", pageSize: 4 });
        expect(getCatalogStats().reads).toBe(shoes.length);
    });

    test("single-product, name, top-rated and cover queries return real documents", async () => {
        const one = everything[0];
        expect(await source.byId(one.id)).toEqual([one]);
        expect(await source.byId("no-such-product")).toEqual([]);
        expect((await source.byName(one.name)).map((d) => d.id)).toContain(one.id);
        const top = await source.topRated({ after: null, size: 5 });
        expect(top.length).toBe(5);
        expect(top.map((d) => d.rating)).toEqual([...top.map((d) => d.rating)].sort((a, b) => b - a));
        const cover = await source.cover("food", 1);
        expect(cover).toHaveLength(1);
        expect(cover[0].category[0]).toBe("food");
    });
});
