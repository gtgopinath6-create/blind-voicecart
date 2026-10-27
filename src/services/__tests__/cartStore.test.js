import { addToCart, readGuestCart, mergeGuestCartInto, writeGuestCart, addToWishlist, getWishlist } from "../cartStore";
import { readData, setCartBeforeBilling } from "../../components/firebaseservices";

jest.mock("../../components/firebaseservices", () => {
    const actual = jest.requireActual("../../components/firebaseservices");
    return {
        sameCartLine: actual.sameCartLine,
        toCartLine: actual.toCartLine,
        readData: jest.fn(),
        updateCart: jest.fn(),
        setCartBeforeBilling: jest.fn(async () => {}),
        setWishlist: jest.fn(async () => {}),
    };
});
jest.mock("../../components/firebase", () => ({ database: {} }));

const af1 = { id: "af1", name: "Nike Air Force 1", price: 9000, image: ["/images/a.png"], category: ["shoes", "casual", "nike"] };
const chips = { id: "chips", name: "Chilli Chatka", price: 15, image: [], category: ["food", "dry snacks", "kurkure"] };

beforeEach(() => {
    localStorage.clear();
    setCartBeforeBilling.mockResolvedValue();
});

test("guest cart adds merge into one line per product", async () => {
    await addToCart(af1, null);
    await addToCart(af1, null);
    await addToCart(chips, null, 3);
    const cart = readGuestCart();
    expect(cart).toHaveLength(2);
    expect(cart.find((l) => l.id === "af1").quantity).toBe(2);
    expect(cart.find((l) => l.id === "chips").quantity).toBe(3);
});

test("merging the guest cart after login sums quantities without duplicates and clears the guest cart", async () => {
    writeGuestCart([{ ...af1, quantity: 2 }, { ...chips, quantity: 1 }]);
    readData.mockResolvedValue({ cart: [{ ...af1, quantity: 1 }] });
    const merged = await mergeGuestCartInto({ uid: "u1" });
    expect(merged).toBe(true);
    const saved = setCartBeforeBilling.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved.find((l) => l.id === "af1").quantity).toBe(3);
    expect(readGuestCart()).toEqual([]);
});

test("the guest cart is kept if saving to the account fails", async () => {
    writeGuestCart([{ ...af1, quantity: 1 }]);
    readData.mockResolvedValue({ cart: [] });
    setCartBeforeBilling.mockRejectedValueOnce(new Error("offline"));
    await expect(mergeGuestCartInto({ uid: "u1" })).rejects.toThrow("offline");
    expect(readGuestCart()).toHaveLength(1);
});

test("legacy cart lines without ids merge by name", async () => {
    writeGuestCart([{ ...af1, quantity: 1 }]);
    readData.mockResolvedValue({ cart: [{ name: "Nike Air Force 1", price: 9000, quantity: 2 }] });
    await mergeGuestCartInto({ uid: "u1" });
    const saved = setCartBeforeBilling.mock.calls[0][0];
    expect(saved).toHaveLength(1);
    expect(saved[0].quantity).toBe(3);
});

test("guest wishlist is stored and read from the same place, without duplicates", async () => {
    expect(await addToWishlist(af1, null)).toBe(true);
    expect(await addToWishlist(af1, null)).toBe(false);
    expect((await getWishlist(null)).map((p) => p.id)).toEqual(["af1"]);
});
