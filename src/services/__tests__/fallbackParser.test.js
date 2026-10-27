import { fallbackVoiceParser, normalizeAction } from "../groqVoiceService";

// Every example command from the VoiceCart spec must work even when the AI is unavailable.
const cases = [
    ["open shoes", { intent: "NAVIGATE", target: "/categories/Shoes" }],
    ["search for Nike Air Force 1", { intent: "SEARCH", target: "nike air force 1" }],
    ["tell me about this product", { intent: "DESCRIBE_PRODUCT", target: null }],
    ["add Nike Air Force 1 to my cart", { intent: "ADD_TO_CART", target: "nike air force 1" }],
    ["increase the quantity to two", { intent: "SET_QUANTITY", target: null, quantity: 2 }],
    ["set the quantity of chilli chatka to 3", { intent: "SET_QUANTITY", target: "chilli chatka", quantity: 3 }],
    ["open my wishlist", { intent: "NAVIGATE", target: "/wishlist" }],
    ["tell me my cart total", { intent: "CART_TOTAL" }],
    ["open my account", { intent: "NAVIGATE", target: "/account" }],
    ["proceed to checkout", { intent: "CHECKOUT" }],
    ["place my order", { intent: "PLACE_ORDER" }],
    ["go back", { intent: "GO_BACK" }],
    ["stop listening", { intent: "STOP_LISTENING" }],
    ["buy iPhone 13 Pro", { intent: "ONE_SHOT_PURCHASE", target: "iphone 13 pro" }],
    ["turn on high contrast", { intent: "TOGGLE_CONTRAST" }],
    ["screen reader off", { intent: "TOGGLE_SCREEN_READER" }],
    ["what's the weather like", { intent: "UNKNOWN" }],
];

test.each(cases)("offline: %s", (text, expected) => {
    expect(fallbackVoiceParser(text, [])).toMatchObject(expected);
});

test("words like 'backpack' or 'paytm' do not trigger navigation or checkout", () => {
    expect(fallbackVoiceParser("add backpack to cart", []).intent).toBe("ADD_TO_CART");
    expect(fallbackVoiceParser("search paytm", []).intent).toBe("SEARCH");
});

test("server output is re-validated in the browser", () => {
    // eslint-disable-next-line no-script-url
    expect(normalizeAction({ intent: "NAVIGATE", target: "javascript:alert(1)" })).toBeNull();
    expect(normalizeAction({ intent: "EVAL", target: "x" })).toBeNull();
    expect(normalizeAction({ intent: "SET_QUANTITY", quantity: -1 })).toBeNull();
    expect(normalizeAction({ intent: "CART_TOTAL" }, "ai")).toMatchObject({ intent: "CART_TOTAL", source: "ai" });
});
