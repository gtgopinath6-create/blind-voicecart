// Security properties of the Zoro voice assistant.
import { interpretCommand, normalizeEntities, INTENTS } from "../groqVoiceService";
import { runVoiceCommand, resolvePending, clearProductCache } from "../voiceActions";
import { zoroTurn, createConversation } from "../zoroDialogue";
import { apiRequest } from "../apiClient";
import { configureCatalog } from "../catalogService";
import { registerBilling } from "../voiceContext";

jest.mock("../apiClient", () => ({ apiRequest: jest.fn() }));
// The whole catalog, as the catalog service would read it from Firestore.
const getAllProducts = jest.fn();
jest.mock("../cartStore", () => ({
    addToCart: jest.fn(async () => {}),
    getCart: jest.fn(async () => []),
    setLineQuantity: jest.fn(async () => []),
    estimateTotal: jest.fn(() => 0),
}));

const CATALOG = [
    { id: "merc", name: "Nike Mercurial", price: 8000, rating: 5, category: ["shoes", "sports", "nike"], size: ["9", "10"], color: ["black"] },
];

beforeEach(() => {
    configureCatalog({ source: { all: () => getAllProducts() } });
    clearProductCache();
    getAllProducts.mockResolvedValue(CATALOG);
    document.body.innerHTML = "";
});

test("nothing is sent to the AI service while a password field has focus", async () => {
    document.body.innerHTML = '<input type="password" id="pw">';
    document.getElementById("pw").focus();
    apiRequest.mockResolvedValue({ action: { intent: "UNKNOWN" } });
    await interpretCommand("my password is correct horse battery staple", []);
    expect(apiRequest).not.toHaveBeenCalled();
});

test("answers parsed locally (localOnly) never reach the AI service", async () => {
    apiRequest.mockResolvedValue({ action: { intent: "UNKNOWN" } });
    await interpretCommand("asha at example dot com", [], { localOnly: true });
    expect(apiRequest).not.toHaveBeenCalled();
});

test("AI entities cannot carry product ids, prices or anything else", () => {
    expect(normalizeEntities({ productId: "invented", price: 1, password: "x", color: "black", category: "Weapons", budgetMax: -1 }))
        .toEqual({ color: "black" });
});

test("a product chosen from AI hints is the catalog's product, at the catalog's price", async () => {
    const added = [];
    const env = {
        user: { uid: "u1" },
        products: async () => CATALOG,
        // The AI claims a product id and a price; both are ignored.
        interpret: async () => ({ intent: "FIND_PRODUCT", target: null, entities: normalizeEntities({ category: "Shoes", productType: "sports", color: "black", size: "9", productId: "fake", price: 1 }) }),
        legacyRun: jest.fn(), legacyResolve: jest.fn(), navigate: jest.fn(), setSpeechRate: jest.fn(),
        addToCart: async (item, quantity) => { added.push({ item, quantity }); },
        signIn: async () => null, billing: async () => null, quote: async () => null, currentProduct: () => null,
    };
    let conv = createConversation();
    for (const line of ["I need black sports shoes in size 9", "yes", "yes"]) conv = (await zoroTurn(line, conv, env)).conv;
    expect(added).toHaveLength(1);
    expect(added[0].item).toMatchObject({ id: "merc", price: 8000 });
});

test("there is no voice intent that touches the wallet, and wallet requests are never made by voice", async () => {
    expect(INTENTS.filter((i) => /WALLET|REFILL|CREDIT|PAY/.test(i))).toEqual([]);
    apiRequest.mockImplementation(async (path) => {
        if (path === "/api/voice/intent") return { action: { intent: "ADD_TO_CART", target: "5000 rupees to my wallet" } };
        throw new Error("unexpected request");
    });
    const outcome = await runVoiceCommand("add 5000 rupees to my wallet", { user: { uid: "u1" }, navigate: jest.fn() });
    expect(outcome.message).toMatch(/could not find a product/);
    expect(apiRequest.mock.calls.map((c) => c[0])).toEqual(["/api/voice/intent"]);
});

test("an order the server did not confirm is never announced as placed", async () => {
    const placeOrder = jest.fn(async () => ({ ok: false, message: "The order was not placed: your wallet balance is too low. Nothing was charged." }));
    const unregister = registerBilling({ getSummary: () => ({ ready: true, problems: [], total: 9440, itemCount: 1 }), placeOrder });
    const result = await resolvePending({ kind: "confirmOrder" }, "yes, place order", { user: { uid: "u1" } });
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.message).toBe("The order was not placed: your wallet balance is too low. Nothing was charged.");
    expect(result.message).not.toMatch(/Order placed/);
    unregister();
});

test("an unclear answer to the order question never places the order", async () => {
    const placeOrder = jest.fn();
    const unregister = registerBilling({ getSummary: () => ({ ready: true, problems: [], total: 9440, itemCount: 1 }), placeOrder });
    for (const said of ["uh huh", "maybe", "yes no", "what"]) {
        const result = await resolvePending({ kind: "confirmOrder" }, said, { user: { uid: "u1" } });
        expect(result.type).toBe("ask");
    }
    expect(placeOrder).not.toHaveBeenCalled();
    unregister();
});
