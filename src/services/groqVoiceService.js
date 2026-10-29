/**
 * Voice intent recognition.
 *
 * The browser sends the spoken text (and the real product names, as hints) to the backend
 * endpoint POST /api/voice/intent, which holds the Groq key server-side. No API key is
 * present in this bundle. The model only classifies intent; products are resolved against
 * the real catalog and every action is executed by deterministic app code.
 *
 * If the backend or the AI is unavailable, a local keyword parser is used instead.
 *
 * Privacy: nothing is sent while a password field has focus, and answers to Zoro's questions
 * (email, phone, address, measurements) are parsed locally and never reach this function.
 */
import { apiRequest } from "./apiClient";
import { brandOf, categoryOf, normalizeText } from "./productMatching";

export const INTENTS = [
    "NAVIGATE", "SEARCH", "ADD_TO_CART", "ONE_SHOT_PURCHASE", "SET_QUANTITY", "DESCRIBE_PRODUCT",
    "CART_TOTAL", "CHECKOUT", "PLACE_ORDER", "GO_BACK", "STOP_LISTENING",
    "TOGGLE_CONTRAST", "TOGGLE_SCREEN_READER", "FIND_PRODUCT", "SIGN_IN", "REGISTER", "HELP", "UNKNOWN",
];

const ENTITY_CATEGORIES = ["Shoes", "Electronics", "Clothes", "Food"];
const SIZE_SYSTEMS = ["UK", "US", "EU", "INDIA"];

/** Entities from the server are hints: re-checked here, then grounded in the catalog by Zoro. */
export function normalizeEntities(raw) {
    const e = raw && typeof raw === "object" ? raw : {};
    const out = {};
    const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);
    for (const key of ["productQuery", "productType", "brand", "color", "size"]) if (str(e[key])) out[key] = str(e[key]);
    const category = ENTITY_CATEGORIES.find((c) => c.toLowerCase() === String(e.category || "").toLowerCase());
    if (category) out.category = category;
    const system = SIZE_SYSTEMS.find((x) => x === String(e.sizeSystem || "").toUpperCase());
    if (system) out.sizeSystem = system;
    const budget = Number(e.budgetMax);
    if (Number.isFinite(budget) && budget > 0 && budget <= 10000000) out.budgetMax = Math.round(budget);
    const quantity = Number(e.quantity);
    if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 20) out.quantity = quantity;
    if (e.confirmation === "yes" || e.confirmation === "no") out.confirmation = e.confirmation;
    if (e.correction === true) out.correction = true;
    if (e.needsClarification === true) out.needsClarification = true;
    return out;
}

/** True while the shopper is typing in a password field: speech is never sent anywhere then. */
export function isSensitiveInputFocused() {
    const el = typeof document !== "undefined" ? document.activeElement : null;
    return Boolean(el && el.tagName === "INPUT" && String(el.type).toLowerCase() === "password");
}

// Pages the assistant may open, with the words that refer to them.
export const NAV_TARGETS = {
    "/": ["home", "homepage", "main page"],
    "/categories/Shoes": ["shoes", "shoe", "footwear", "sneakers"],
    "/categories/Electronics": ["electronics", "electronic", "gadgets"],
    "/categories/Food": ["food", "snacks", "grocery"],
    "/categories/Clothes": ["clothes", "clothing", "apparel"],
    // "add to cart page" is deliberately not listed here: it collides with the ADD_TO_CART regex
    // below ("add ... to cart"), which runs first. The Groq prompt (server/src/voice.js) still
    // hints at that phrasing for the LLM path, which reasons about the whole sentence instead.
    "/cart": ["cart", "basket", "shopping cart", "view cart", "my cart", "go to cart"],
    "/wishlist": ["wishlist", "wish list"],
    "/account": ["account", "profile"],
    "/billing": ["billing"],
};

const MAX_PRODUCT_HINTS = 150;

/** Re-validates whatever the server returns; anything unexpected is dropped. */
export function normalizeAction(raw, source) {
    if (!raw || typeof raw !== "object") return null;
    const intent = String(raw.intent || "").toUpperCase();
    if (!INTENTS.includes(intent)) return null;
    let target = typeof raw.target === "string" && raw.target.trim() ? raw.target.trim().slice(0, 150) : null;
    if (intent === "NAVIGATE") {
        target = Object.keys(NAV_TARGETS).find((p) => p.toLowerCase() === (target || "").toLowerCase()) || null;
        if (!target) return null;
    }
    if (["SEARCH", "ADD_TO_CART", "ONE_SHOT_PURCHASE"].includes(intent) && !target) return null;
    let quantity = null;
    if (intent === "SET_QUANTITY") {
        quantity = Number(raw.quantity);
        if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) return null;
    }
    return { intent, target, quantity, speechResponse: typeof raw.speechResponse === "string" ? raw.speechResponse : "", entities: normalizeEntities(raw.entities), source };
}

/**
 * Turns speech into a validated action: backend AI first, local parser as fallback.
 * `signal` lets the assistant cancel a pending request when it is stopped.
 */
export async function interpretCommand(userInput, products = [], { signal, localOnly = false } = {}) {
    const text = (userInput || "").trim().slice(0, 300);
    if (!text) return null;
    if (localOnly || isSensitiveInputFocused()) return fallbackVoiceParser(text, products);
    try {
        const data = await apiRequest("/api/voice/intent", {
            body: {
                text,
                products: products.slice(0, MAX_PRODUCT_HINTS).map((p) => ({ name: p.name, category: categoryOf(p), brand: brandOf(p) })),
            },
            signal,
        });
        const action = normalizeAction(data && data.action, "ai");
        if (action) return action;
    } catch (e) {
        if (e.name === "AbortError") throw e;
        console.warn(`AI voice service unavailable (${e.code || e.message}); using the offline parser.`);
    }
    return fallbackVoiceParser(text, products);
}

const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function mentionsAny(text, phrases) {
    return phrases.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

/** Deterministic keyword parser used when the AI backend is unavailable. */
export function fallbackVoiceParser(userInput, products = []) {
    const lower = (userInput || "").toLowerCase().replace(/[^a-z0-9%' ]+/g, " ").replace(/\s+/g, " ").trim();
    const result = (intent, target = null, extra = {}) => ({ intent, target, quantity: null, speechResponse: "", entities: {}, source: "offline", ...extra });

    if (mentionsAny(lower, ["stop listening", "go to sleep", "cancel listening"])) return result("STOP_LISTENING");
    if (mentionsAny(lower, ["create an account", "create account", "sign up", "signup", "register", "new account"])) return result("REGISTER");
    if (mentionsAny(lower, ["sign in", "sign me in", "log in", "log me in", "login"])) return result("SIGN_IN");
    if (/^(help|what can you do|what can i say|how does this work)$/.test(lower)) return result("HELP");
    // A general shopping request ("I'm looking for shoes"); Zoro grounds the details in the catalog.
    if (/\b(i'?m looking for|i am looking for|looking for|i need|i want|i'?d like|i would like|find me|get me|shop for|i'?m after|do you have)\b/.test(lower) &&
        !mentionsAny(lower, ["cart", "wishlist", "account", "checkout", "check out", "order", "pay", "buy", "purchase", "add", "sign in", "log in"])) {
        return result("FIND_PRODUCT", null);
    }
    if (mentionsAny(lower, ["go back", "previous page"])) return result("GO_BACK");
    if (mentionsAny(lower, ["contrast", "dark mode", "light mode", "colours", "colors"])) return result("TOGGLE_CONTRAST");
    if (mentionsAny(lower, ["screen reader", "stop reading", "start reading"])) return result("TOGGLE_SCREEN_READER");
    if (mentionsAny(lower, ["place my order", "place the order", "place order", "pay now", "confirm payment"])) return result("PLACE_ORDER");
    if (mentionsAny(lower, ["checkout", "check out", "proceed to pay", "billing"])) return result("CHECKOUT", "/billing");
    if (mentionsAny(lower, ["cart total", "my total", "what is in my cart", "what's in my cart", "how much"])) return result("CART_TOTAL");

    const qty = lower.match(/\b(?:quantity|increase|decrease|set|change|make)\b.*?\b(?:to|as)\s+(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    if (qty) {
        const quantity = /^\d+$/.test(qty[1]) ? Number(qty[1]) : NUMBER_WORDS[qty[1]];
        const named = lower.match(/\b(?:of|for)\s+(.+?)\s+(?:to|as)\s+/);
        const target = named && !/^(this|it|the product)$/.test(named[1]) ? named[1] : null;
        if (quantity <= 20) return result("SET_QUANTITY", target, { quantity });
    }

    const describe = lower.match(/\b(?:tell me about|describe|details of|what is)\s+(.+)$/);
    if (describe) {
        const target = /^(this|it|this product|this item|the product)$/.test(describe[1].trim()) ? null : describe[1].trim();
        return result("DESCRIBE_PRODUCT", target);
    }

    const buy = lower.match(/\b(?:buy|order|purchase)\s+(.+)$/);
    if (buy) return result("ONE_SHOT_PURCHASE", buy[1].replace(/\b(please|now|for me)\b/g, "").trim());
    const add = lower.match(/\badd\s+(.+?)(?:\s+to\s+(?:my\s+|the\s+)?cart)?$/);
    if (add) return result("ADD_TO_CART", add[1].replace(/\b(please)\b/g, "").trim());

    const search = lower.match(/\b(?:search for|search|find|look for|show me)\s+(.+)$/);
    if (search) return result("SEARCH", search[1].trim());

    const page = Object.keys(NAV_TARGETS).find((p) => mentionsAny(lower, NAV_TARGETS[p]));
    if (page) return result("NAVIGATE", page);

    const brand = products.map(brandOf).find((b) => b && mentionsAny(lower, [normalizeText(b)]));
    if (brand) return result("SEARCH", brand);

    return result("UNKNOWN");
}
