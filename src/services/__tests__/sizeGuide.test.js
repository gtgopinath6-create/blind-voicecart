import { estimateFromFootLength, sizesFromProducts, isSizeAvailable, matchAvailableSize, matchLetterSize, SIZE_CHARTS, STORE_SHOE_SIZE_SYSTEM } from "../sizeGuide";

// A test-only chart. The shipped SIZE_CHARTS is empty because no chart has been verified.
const charts = { nike: { source: "test fixture", checked: "2026-10-26", rows: [{ footCm: 25, UK: "7" }, { footCm: 26, UK: "8" }, { footCm: 27, UK: "9" }] } };

test("no invented charts or sizing system ship with the app", () => {
    expect(SIZE_CHARTS).toEqual({});
    expect(STORE_SHOE_SIZE_SYSTEM).toBeNull();
    expect(estimateFromFootLength(26.4, "Nike")).toEqual({ status: "no_chart" });
});

test("a foot length uses the brand's chart only when the store's sizing system is known", () => {
    expect(estimateFromFootLength(26.4, "Nike", { charts, storeSystem: null })).toEqual({ status: "no_system" });
    expect(estimateFromFootLength(26.4, "Nike", { charts, storeSystem: "UK" })).toEqual({ status: "ok", size: "9", system: "UK", source: "test fixture" });
    expect(estimateFromFootLength(26, "Nike", { charts, storeSystem: "UK" }).size).toBe("8");
    expect(estimateFromFootLength(31, "Nike", { charts, storeSystem: "UK" })).toEqual({ status: "out_of_range" });
    expect(estimateFromFootLength(26, "Adidas", { charts, storeSystem: "UK" })).toEqual({ status: "no_chart" });
});

test("available sizes come from the products, and unavailable sizes are rejected", () => {
    const sizes = sizesFromProducts([{ size: ["10", "6", "8"] }, { size: ["9", "6"] }, { name: "no sizes" }]);
    expect(sizes).toEqual(["6", "8", "9", "10"]);
    expect(isSizeAvailable("9", sizes)).toBe(true);
    expect(isSizeAvailable("9.0", sizes)).toBe(true);
    expect(isSizeAvailable("11", sizes)).toBe(false);
    expect(matchAvailableSize("9.0", sizes)).toBe("9");
    expect(isSizeAvailable("1", ["10"])).toBe(false);
});

test("spoken clothing sizes match only sizes the product lists", () => {
    const sizes = ["S", "M", "L", "XL"];
    expect(matchLetterSize("medium", sizes)).toBe("M");
    expect(matchLetterSize("extra large please", sizes)).toBe("XL");
    expect(matchLetterSize("size m", sizes)).toBe("M");
    expect(matchLetterSize("it's medium", sizes)).toBe("M"); // the "s" of "it's" is not size S
    expect(matchLetterSize("double extra large", sizes)).toBeNull(); // XXL is not listed
    expect(matchLetterSize("I'd like a small one", ["M", "L"])).toBeNull();
});
