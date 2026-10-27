import { extractEntities, findBrand, namesAProduct } from "../shoppingCatalog";

// Test fixtures shaped like the store's catalog (brand names as stored in category[2]).
const PRODUCTS = [
    { id: "op", name: "OnePlus Nord", price: 30000, category: ["electronics", "phones", "onePlus"] },
    { id: "hm", name: "H&M Hoodie", price: 1999, category: ["clothes", "sweatshirts", "h and m"] },
    { id: "ms", name: "M&S Shirt", price: 2499, category: ["clothes", "shirts", "marks and spencer"] },
    { id: "ch", name: "Banana Chips", price: 120, category: ["food", "dry snacks", "Chheda's"] },
    { id: "nk", name: "Nike Mercurial", price: 8000, category: ["shoes", "sports", "nike"], color: ["black", "red"], size: ["8", "9"] },
    { id: "ad", name: "Adidas Ultraboost", price: 12000, category: ["shoes", "sports", "adidas"], color: ["blue"], size: ["9"] },
    { id: "ua", name: "UA HOVR", price: 9000, category: ["shoes", "sports", "under armour"] },
    { id: "ss", name: "Galaxy S22", price: 70000, category: ["electronics", "phones", "samsung"] },
    { id: "ap", name: "iPhone 13", price: 70000, category: ["electronics", "phones", "apple"] },
];
const BRANDS = ["onePlus", "h and m", "marks and spencer", "Chheda's", "nike", "adidas", "under armour", "samsung", "apple"];

test("brand names match however speech recognition spaces or writes them", () => {
    expect(findBrand("show me one plus phones", BRANDS)).toEqual({ brand: "onePlus" });
    expect(findBrand("anything from H&M", BRANDS)).toEqual({ brand: "h and m" });
    expect(findBrand("marks & spencer shirts", BRANDS)).toEqual({ brand: "marks and spencer" });
    expect(findBrand("chheda's chips", BRANDS)).toEqual({ brand: "Chheda's" });
    expect(findBrand("under armour shoes", BRANDS)).toEqual({ brand: "under armour" });
});

test("a close mishearing of a longer brand is accepted only when it fits one brand, and is flagged", () => {
    expect(findBrand("nikey shoes", BRANDS)).toEqual({ brand: "nike", heard: "nikey" });
    expect(findBrand("addidas", BRANDS)).toEqual({ brand: "adidas", heard: "addidas" });
    expect(findBrand("samsang phone", BRANDS)).toEqual({ brand: "samsung", heard: "samsang" });
    expect(findBrand("apples", BRANDS)).toBeNull();    // a plural word, not the brand
    expect(findBrand("pumps", ["puma"])).toBeNull();   // too short to guess
    expect(findBrand("something nice", BRANDS)).toBeNull();
});

test("the brand found is grounded in the catalog, and a misheard one sets the category", () => {
    expect(extractEntities("show me nikey shoes", PRODUCTS)).toMatchObject({ category: "Shoes", brand: "nike", brandHeard: "nikey" });
    expect(extractEntities("one plus phones under 40000", PRODUCTS)).toMatchObject({ category: "Electronics", type: "phones", brand: "onePlus", budgetMax: 40000 });
});

test("sound-alike colours count only when a colour is the expected answer", () => {
    expect(extractEntities("read", PRODUCTS, { expect: "color" }).color).toBe("red");
    expect(extractEntities("blew", PRODUCTS, { expect: "color" }).color).toBe("blue");
    expect(extractEntities("read", PRODUCTS).color).toBeUndefined();
    expect(extractEntities("I read the reviews", PRODUCTS).color).toBeUndefined();
});

test("descriptions are not product names, even when a product name contains the same word", () => {
    const shoes = [...PRODUCTS, { id: "vw", name: "Vans Old Skool Black/White", price: 5000, category: ["shoes", "casual", "vans"] }];
    for (const said of ["black shoes", "Nike shoes in size 9", "sports shoes", "a pair of black and white shoes", "something cheaper under 3000"]) {
        expect(namesAProduct(said, shoes)).toBe(false);
    }
    for (const said of ["Nike Air Force 1", "Vans Old Skool", "galaxy s22", "ultraboost"]) expect(namesAProduct(said, shoes)).toBe(true);
});
