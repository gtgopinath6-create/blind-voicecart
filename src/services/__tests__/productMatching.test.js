import { resolveProduct, pickFromList, searchProducts, dedupeProducts, nearWord } from "../productMatching";

const products = [
    { id: "1", name: "Nike Mercurial", price: 8000, category: ["shoes", "sports", "nike"] },
    { id: "2", name: "Nike Air Force 1", price: 9000, category: ["shoes", "casual", "nike"] },
    { id: "3", name: "Nike Air Jordan", price: 7500, category: ["shoes", "casual", "nike"] },
    { id: "4", name: "iPhone 13 Pro", price: 100000, category: ["electronics", "phones", "apple"] },
    { id: "5", name: "iPhone 12 Pro Max", price: 95000, category: ["electronics", "phones", "apple"] },
    { id: "6", name: "MacBook Air", price: 83900, category: ["electronics", "laptop", "apple"] },
    { id: "7", name: "MacBook Pro", price: 112000, category: ["electronics", "laptop", "apple"] },
];

test("exact and spoken-number names resolve to one product", () => {
    expect(resolveProduct("Nike Air Force 1", products)).toEqual({ status: "one", product: products[1] });
    expect(resolveProduct("nike air force one", products).product.id).toBe("2");
    expect(resolveProduct("air force one", products).product.id).toBe("2");
    expect(resolveProduct("iphone 13 pro", products).product.id).toBe("4");
});

test("unknown products are never replaced by another product", () => {
    expect(resolveProduct("Nike Air Max 270", products).status).not.toBe("one");
    expect(resolveProduct("Samsung fridge", products)).toEqual({ status: "none" });
    expect(resolveProduct("", products)).toEqual({ status: "none" });
    expect(resolveProduct("anything", [])).toEqual({ status: "none" });
});

test("a brand or partial name is ambiguous, not silently picked", () => {
    const nike = resolveProduct("Nike", products);
    expect(nike.status).toBe("ambiguous");
    expect(nike.matches.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(resolveProduct("iphone pro", products).status).toBe("ambiguous");
    expect(resolveProduct("macbook", products).status).toBe("ambiguous");
});

test("a fully spoken name wins over longer names containing it", () => {
    expect(resolveProduct("macbook air", products).product.id).toBe("6");
});

test("choosing from a read-out list by number or name", () => {
    const options = products.slice(0, 3);
    expect(pickFromList("the second one", options).id).toBe("2");
    expect(pickFromList("number 3", options).id).toBe("3");
    expect(pickFromList("first", options).id).toBe("1");
    expect(pickFromList("air jordan", options).id).toBe("3");
    expect(pickFromList("the fifth", options)).toBeNull();
    expect(pickFromList("something else", options)).toBeNull();
});

test("search matches names, brands and categories", () => {
    expect(searchProducts("air", products).map((p) => p.id)).toEqual(["2", "3", "6"]);
    expect(searchProducts("apple", products)).toHaveLength(4);
    expect(searchProducts("shoes", products)).toHaveLength(3);
    expect(searchProducts("", products)).toEqual([]);
});

test("identical duplicate documents collapse to one; different versions are kept", () => {
    const base = { name: "Puffcorn", price: 20, description: "d", category: ["food", "dry snacks", "kurkure"], image: ["/images/puffcorn1.png"] };
    const list = [{ id: "z9", ...base }, { id: "a1", ...base }, { id: "m5", ...base }, { id: "b2", ...base, price: 25 }];
    const result = dedupeProducts(list);
    expect(result.map((p) => p.id).sort()).toEqual(["a1", "b2"]);
    // With duplicates collapsed, an exact name with two versions is still ambiguous (prices differ).
    expect(resolveProduct("Puffcorn", result).status).toBe("ambiguous");
    expect(resolveProduct("Puffcorn", dedupeProducts(list.slice(0, 3)))).toMatchObject({ status: "one", product: { id: "a1" } });
});

test("the most complete copy (with size and colour options) is kept", () => {
    const plain = { name: "Nike Air Force 1", price: 9000, description: "d", category: ["shoes", "casual", "nike"], image: ["/images/a.png"] };
    const rich = { ...plain, id: "zz", size: ["6", "7"], color: ["red", "black"] };
    const list = [{ id: "a1", ...plain }, { id: "b2", ...plain }, rich];
    expect(dedupeProducts(list)).toEqual([rich]);
    // Conflicting option lists are both kept.
    const other = { ...plain, id: "c3", size: ["8", "9"] };
    expect(dedupeProducts([...list, other]).map((p) => p.id).sort()).toEqual(["c3", "zz"]);
});

describe("misheard product names", () => {
    test("a near miss is only offered as a suggestion, never chosen, even when it is the only one", () => {
        const result = resolveProduct("nike mercureal", products);
        expect(result.status).toBe("ambiguous");
        expect(result.fuzzy).toBe(true);
        expect(result.matches.map((p) => p.id)).toEqual(["1"]);
    });

    test("short words and plurals are not treated as near misses", () => {
        expect(nearWord("air", "aid")).toBe(false);
        expect(nearWord("macbooks", "macbook")).toBe(false);
        expect(nearWord("mercureal", "mercurial")).toBe(true);
        expect(nearWord("jordon", "jordan")).toBe(true);
        expect(nearWord("pordan", "jordan")).toBe(false); // a different first sound
        expect(resolveProduct("toaster", products)).toEqual({ status: "none" });
    });
});
