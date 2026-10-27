import { runVoiceCommand, resolvePending, classifyConfirmation, clearProductCache } from "../voiceActions";
import { addToCart, getCart, setLineQuantity } from "../cartStore";
import { apiRequest } from "../apiClient";
import { configureCatalog } from "../catalogService";
import { registerBilling } from "../voiceContext";

const CATALOG = [
    { id: "af1", name: "Nike Air Force 1", price: 9000, category: ["shoes", "casual", "nike"], description: "Classic." },
    { id: "aj", name: "Nike Air Jordan", price: 7500, category: ["shoes", "casual", "nike"] },
    { id: "chips", name: "Chilli Chatka", price: 15, category: ["food", "dry snacks", "kurkure"] },
    { id: "ip", name: "iPhone 13 Pro", price: 100000, size: ["128 GB", "256 GB"], category: ["electronics", "phones", "apple"] },
];

// The whole catalog, as the catalog service would read it from Firestore.
const getAllProducts = jest.fn();
jest.mock("../cartStore", () => ({
    addToCart: jest.fn(async () => {}),
    getCart: jest.fn(async () => []),
    setLineQuantity: jest.fn(async () => []),
    estimateTotal: jest.fn(() => 0),
}));
jest.mock("../apiClient", () => ({ apiRequest: jest.fn() }));

const ctx = () => ({
    user: null,
    navigate: jest.fn(),
    goBack: jest.fn(),
    setSearch: jest.fn(),
    toggleContrast: jest.fn(),
    toggleScreenReader: jest.fn(),
});

// The AI returns this intent for every command in a test.
const aiSays = (action) => apiRequest.mockImplementation(async (path) => {
    if (path === "/api/voice/intent") return { action };
    throw Object.assign(new Error("unavailable"), { status: 503 });
});

// CRA resets mock implementations before each test (resetMocks: true).
beforeEach(() => {
    configureCatalog({ source: { all: () => getAllProducts() } });
    clearProductCache();
    getAllProducts.mockResolvedValue(CATALOG);
    getCart.mockResolvedValue([]);
});

test("an unknown product is reported and nothing is added", async () => {
    aiSays({ intent: "ADD_TO_CART", target: "Samsung Galaxy Fridge" });
    const outcome = await runVoiceCommand("add samsung galaxy fridge to my cart", ctx());
    expect(outcome.type).toBe("done");
    expect(outcome.message).toMatch(/could not find/i);
    expect(addToCart).not.toHaveBeenCalled();
});

test("a product that only partly matches is offered as a suggestion, never added automatically", async () => {
    aiSays({ intent: "ADD_TO_CART", target: "Nike Air Max 270" });
    const c = ctx();
    const outcome = await runVoiceCommand("add nike air max 270 to my cart", c);
    expect(outcome.type).toBe("ask");
    expect(outcome.message).toMatch(/could not find Nike Air Max 270 exactly/);
    expect(outcome.message).toMatch(/Nothing has been added yet/);
    expect(addToCart).not.toHaveBeenCalled();
    const cancelled = await resolvePending(outcome.pending, "cancel", c);
    expect(cancelled.message).toMatch(/Nothing was added/);
    expect(addToCart).not.toHaveBeenCalled();
});

test("an ambiguous product asks which one, then adds only the chosen product", async () => {
    aiSays({ intent: "ADD_TO_CART", target: "Nike" });
    const c = ctx();
    const outcome = await runVoiceCommand("add nike to cart", c);
    expect(outcome.type).toBe("ask");
    expect(outcome.pending.kind).toBe("chooseProduct");
    expect(outcome.message).toMatch(/1: Nike Air Force 1.*2: Nike Air Jordan/);
    expect(addToCart).not.toHaveBeenCalled();

    const done = await resolvePending(outcome.pending, "the second one", c);
    expect(done.message).toMatch(/Added 1 Nike Air Jordan/);
    expect(addToCart).toHaveBeenCalledWith(expect.objectContaining({ id: "aj" }), null, 1);
});

test("an exact, inexpensive product is added directly with name and price read back", async () => {
    aiSays({ intent: "ADD_TO_CART", target: "Nike Air Force 1" });
    const outcome = await runVoiceCommand("add nike air force 1 to my cart", ctx());
    expect(outcome.message).toBe("Added 1 Nike Air Force 1 at ₹9000 each to your cart.");
    expect(addToCart).toHaveBeenCalledTimes(1);
});

test("a costly product needs its option and an explicit yes before it is added", async () => {
    aiSays({ intent: "ADD_TO_CART", target: "iPhone 13 Pro" });
    const c = ctx();
    const sizeQ = await runVoiceCommand("add iphone 13 pro", c);
    expect(sizeQ.pending.kind).toBe("chooseVariant");
    expect(sizeQ.pending.field).toBe("size");
    const confirmQ = await resolvePending(sizeQ.pending, "256 GB", c);
    expect(confirmQ.pending.kind).toBe("confirmAdd");
    expect(confirmQ.message).toMatch(/size 256 GB, at ₹100000 each/);
    expect(addToCart).not.toHaveBeenCalled();

    // An unclear answer is asked again (never taken as yes), and the question stays open.
    const unclear = await resolvePending(confirmQ.pending, "maybe later", c);
    expect(unclear.type).toBe("ask");
    expect(unclear.message).toMatch(/didn't understand/);
    expect(unclear.pending).toBe(confirmQ.pending);
    expect(addToCart).not.toHaveBeenCalled();

    const declined = await resolvePending(confirmQ.pending, "no", c);
    expect(declined.message).toMatch(/cancelled/i);
    expect(addToCart).not.toHaveBeenCalled();

    await resolvePending(confirmQ.pending, "yes", c);
    expect(addToCart).toHaveBeenCalledWith(expect.objectContaining({ id: "ip", size: "256 GB" }), null, 1);
});

test("size and colour are both asked for, by whole-word match", async () => {
    getAllProducts.mockResolvedValue([{ id: "af1v", name: "Nike Air Force 1", price: 9000, size: ["6", "7", "8", "9", "10"], color: ["red", "black", "green"], category: ["shoes", "casual", "nike"] }]);
    aiSays({ intent: "ADD_TO_CART", target: "Nike Air Force 1" });
    const c = ctx();
    const q1 = await runVoiceCommand("add air force 1", c);
    expect(q1.pending).toMatchObject({ kind: "chooseVariant", field: "size" });
    const bad = await resolvePending(q1.pending, "size 1", c);
    expect(bad.message).toMatch(/not one of the options/);
    const q2 = await resolvePending(q1.pending, "size 10 please", c);
    expect(q2.pending).toMatchObject({ kind: "chooseVariant", field: "color" });
    const done = await resolvePending(q2.pending, "black", c);
    expect(done.message).toMatch(/size 10, colour black/);
    expect(addToCart).toHaveBeenCalledWith(expect.objectContaining({ id: "af1v", size: "10", color: "black" }), null, 1);
});

test('"buy" adds to the cart and opens billing, but never pays', async () => {
    aiSays({ intent: "ONE_SHOT_PURCHASE", target: "Chilli Chatka" });
    const c = ctx();
    const outcome = await runVoiceCommand("buy chilli chatka", c);
    expect(addToCart).toHaveBeenCalledTimes(1);
    expect(c.navigate).toHaveBeenCalledWith("/billing");
    expect(outcome.message).toMatch(/Nothing has been paid yet/);
    expect(apiRequest).not.toHaveBeenCalledWith("/api/checkout", expect.anything());
});

test("placing an order requires the billing page and an explicit yes", async () => {
    aiSays({ intent: "PLACE_ORDER" });
    const c = ctx();
    const noPage = await runVoiceCommand("place my order", c);
    expect(noPage.type).toBe("done");
    expect(c.navigate).toHaveBeenCalledWith("/billing");

    const placeOrder = jest.fn(async () => ({ ok: true, message: "Order placed. You paid ₹15." }));
    const unregister = registerBilling({ getSummary: () => ({ ready: true, problems: [], total: 17.7, itemCount: 1 }), placeOrder });
    const question = await runVoiceCommand("place my order", c);
    expect(question.type).toBe("ask");
    expect(question.message).toMatch(/pay ₹17.7/);
    await resolvePending(question.pending, "uh huh", c);
    expect(placeOrder).not.toHaveBeenCalled();
    const result = await resolvePending(question.pending, "yes place order", c);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(result.message).toBe("Order placed. You paid ₹15.");
    unregister();
});

test("an order that is not ready explains why instead of asking to pay", async () => {
    aiSays({ intent: "PLACE_ORDER" });
    const unregister = registerBilling({ getSummary: () => ({ ready: false, problems: ["Please complete your delivery details."], total: 0, itemCount: 0 }), placeOrder: jest.fn() });
    const outcome = await runVoiceCommand("place my order", ctx());
    expect(outcome.type).toBe("done");
    expect(outcome.message).toMatch(/delivery details/);
    unregister();
});

test("when the AI service fails, the offline parser is used safely", async () => {
    apiRequest.mockRejectedValue(Object.assign(new Error("down"), { status: 502 }));
    const c = ctx();
    const nav = await runVoiceCommand("open electronics", c);
    expect(c.navigate).toHaveBeenCalledWith("/categories/Electronics");
    expect(nav.message).toMatch(/Electronics/);
    const unknown = await runVoiceCommand("add a samsung fridge to my cart", c);
    expect(unknown.message).toMatch(/could not find/i);
    expect(addToCart).not.toHaveBeenCalled();
});

test("AI output with an unknown intent or unsafe page is not executed", async () => {
    aiSays({ intent: "NAVIGATE", target: "https://evil.example" });
    const c = ctx();
    await runVoiceCommand("open shoes", c);
    // Falls back to the local parser, which opens the real Shoes page.
    expect(c.navigate).toHaveBeenCalledWith("/categories/Shoes");
    expect(c.navigate).not.toHaveBeenCalledWith("https://evil.example");
});

test("quantity changes target the cart line, and removing asks first", async () => {
    getCart.mockResolvedValue([{ id: "af1", name: "Nike Air Force 1", price: 9000, quantity: 1 }]);
    aiSays({ intent: "SET_QUANTITY", target: null, quantity: 2 });
    const c = ctx();
    const outcome = await runVoiceCommand("increase the quantity to two", c);
    expect(setLineQuantity).toHaveBeenCalledWith(null, expect.objectContaining({ id: "af1" }), 2);
    expect(outcome.message).toMatch(/quantity is now 2/);

    aiSays({ intent: "SET_QUANTITY", target: "air force 1", quantity: 0 });
    const ask = await runVoiceCommand("set air force 1 to zero", c);
    expect(ask.type).toBe("ask");
    expect(setLineQuantity).toHaveBeenCalledTimes(1);
});

test("confirmation words", () => {
    expect(classifyConfirmation("Yes")).toBe("yes");
    expect(classifyConfirmation("yes, place order")).toBe("yes");
    expect(classifyConfirmation("no thanks")).toBe("no");
    expect(classifyConfirmation("cancel")).toBe("no");
    expect(classifyConfirmation("yes no maybe")).toBe("unclear");
    expect(classifyConfirmation("I want the blue one")).toBe("unclear");
});
