/**
 * Zoro's conversation manager: a stateful, catalog-grounded shopping dialogue.
 *
 *   zoroTurn(text, conversation, env) -> { conv, reply }
 *   reply = { message, expect, choices }
 *     expect "command"  -> keep listening for a new request
 *     expect "answer"   -> a question was asked; the next utterance answers it
 *     expect "keyboard" -> the shopper must type (password, Google button); the mic pauses
 *     expect "stop"     -> turn the assistant off
 *
 * Rules it follows:
 *  - Important answers (type, colour, size, measurements, email, delivery details, the product)
 *    are read back and only used after a clear "yes". "No" keeps the same step; anything unclear
 *    is asked again and is never taken as a yes.
 *  - Details the shopper already gave are not asked for again.
 *  - Products, types, colours, sizes and prices come from the catalog. Nothing is ever picked
 *    for the shopper and no first-item fallback exists.
 *  - Answers to questions are parsed here, locally. Only new requests go to the AI intent service
 *    (through env.interpret); passwords are never spoken at all: the password field is typed.
 *  - Conversation state lives in memory only and holds no password or saved email address.
 *  - env.products({ category }) reads only the category being shopped; env.products() reads every
 *    product and is used only when a product or brand is named without a category.
 */
import { CATEGORIES } from "./storeCategories";
import {
    classifyAnswer, normalizeSpeech, parseOptionIndex, parseShoeSize, parseSizeAnswer, parseHeight, parseWeight, parseFootLength,
    parseDigits, parseEmail, speakableEmail, speakableDigits,
} from "./speechParsers";
import {
    extractEntities, filterProducts, rankProducts, alternativesFor, typesFor, typeLabel, categoryNoun, colorsFrom,
    colorsOf, brandsFrom, storeCategoryOf, namesAProduct,
} from "./shoppingCatalog";
import { sizesFromProducts, matchAvailableSize, matchLetterSize, estimateFromFootLength, HEIGHT_WEIGHT_NOTE, MEASURING_GUIDE, STORE_SHOE_SIZE_SYSTEM } from "./sizeGuide";
import { SHIPPING_FIELDS } from "./validation";
import { pickFromList, resolveProduct } from "./productMatching";

const LIST_PAGE = 3;
const HISTORY_LIMIT = 12;

export const GREETING = "Hello! I'm Zoro, your VoiceCart shopping assistant. How can I help you today?";
export const WELCOME_AFTER_SIGN_IN =
    "Welcome to VoiceCart. You can ask me to find a product, explore a category, search by brand, or manage your cart. What would you like to shop for?";
export const HELP_TEXT =
    'You can say things like "I\'m looking for shoes", "show me Nike shoes", "open electronics", "read my cart", ' +
    '"check out", or "sign in". Say "repeat that" to hear me again, "speak more slowly", "go back", "start over", or "stop listening". ' +
    "You can also type to me in the box below.";
/** A "yes" the browser was unsure it heard is never taken as consent. */
export const UNSURE_YES = "I think I heard yes, but I'm not sure. Please say yes or no again, or use the Yes and No buttons.";
/**
 * Browser confidence (0 to 1) below which a spoken yes is checked again. Whisper-transcribed
 * commands (speechInput.js's startWhisperSession, used when the browser's own recognition is
 * unavailable or not chosen) report no real per-word confidence and use a fixed value comfortably
 * above this threshold (WHISPER_CONFIDENCE), so this gate only ever re-checks Web Speech API answers.
 */
export const LOW_CONFIDENCE = 0.5;
export const INACTIVITY_MESSAGE =
    "I've paused listening because there has been no activity. Say 'Hey Zoro' or activate the microphone when you need me.";
export const CATALOG_UNAVAILABLE = "I can't load the product catalog right now. Your cart hasn't been changed. You can try again later.";

/** Products for a step: one category when it is known, otherwise every product. */
const productsFor = (env, category) => env.products(category ? { category } : undefined);
/** The store category a phrase names ("sports shoes" -> Shoes), from words alone: no catalog read. */
const spokenCategory = (text) => extractEntities(text).category || null;
// Requests that need the catalog when no category was said: products and brands are named.
const CATALOG_INTENTS = ["FIND_PRODUCT", "SEARCH", "ADD_TO_CART", "ONE_SHOT_PURCHASE", "DESCRIBE_PRODUCT", "UNKNOWN"];

const price = (n) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const sentenceList = (items, joiner = "and") => {
    const list = items.map(String);
    if (list.length <= 1) return list.join("");
    return `${list.slice(0, -1).join(", ")} ${joiner} ${list[list.length - 1]}`;
};
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

export function createConversation() {
    return {
        workflow: null,     // "discover" | "login" | "register" | "checkout" | null
        step: null,         // the question waiting for an answer
        confirm: null,      // a read-back waiting for yes/no
        slots: {},          // category, type, typeWord, closest, brand, color, anyColor, size, anySize, sizeSystem, budgetMax, budgetMin, cheaperThan, quantity
        sizing: {},         // mode, heightCm, weightKg, footCm, asked: { height, weight, fit, foot }
        shown: [],          // product ids read out in the current list
        listOffset: 0,
        productId: null,
        selected: {},       // size / color chosen for the selected product
        history: [],
        legacyPending: null, // a question asked by the command layer (voiceActions)
        guestChosen: false,
        deferred: null,     // a request to continue after the sign-in question
        notedSizeSystem: false,
        lastResponse: "",
        lastExpect: "command",
        lastChoices: [],
        lastNavigatedCategory: null, // the category page last opened for this conversation, so it is not re-opened every turn
        lastNavigatedProductId: null, // likewise for the product page opened once a single product is chosen
    };
}

function respond(conv, message, expect = "command", choices = [], extra = {}) {
    return { conv: { ...conv, lastResponse: message, lastExpect: expect, lastChoices: choices }, reply: { message, expect, choices, ...extra } };
}
/** A reply saying the shopper was not understood (the assistant offers typing after a few in a row). */
const notUnderstood = (conv, message, expect, choices) => respond(conv, message, expect, choices, { unclear: true });
const askStep = (conv, step, message, choices = []) => respond({ ...conv, step, confirm: null }, message, "answer", choices);
const askConfirm = (conv, confirm, message, choices = YES_NO) => respond({ ...conv, confirm }, message, "answer", choices);
const YES_NO = [{ label: "Yes", say: "yes" }, { label: "No", say: "no", quiet: true }];

function snapshot(conv) {
    const { slots, sizing, step, productId, selected, workflow } = conv;
    return { slots, sizing, step, productId, selected, workflow };
}
const remember = (conv) => ({ ...conv, history: [...conv.history, snapshot(conv)].slice(-HISTORY_LIMIT) });

function endWorkflow(conv) {
    return { ...conv, workflow: null, step: null, confirm: null, slots: {}, sizing: {}, shown: [], listOffset: 0, productId: null, selected: {}, deferred: null };
}

/** Called when the session pauses (inactivity): drops anything that could place an order or add to the cart. */
export function pauseConversation(conv) {
    const risky = conv.legacyPending && ["confirmOrder", "confirmAdd", "confirmQuantity"].includes(conv.legacyPending.kind);
    const riskyConfirm = conv.confirm && ["product", "checkout"].includes(conv.confirm.kind);
    return { ...conv, legacyPending: risky ? null : conv.legacyPending, confirm: riskyConfirm ? null : conv.confirm };
}

/** What Zoro says when the shopper turns it on again. */
export function resumeMessage(conv, firstTime) {
    if (firstTime) return GREETING;
    if (conv.workflow && conv.lastResponse && conv.lastExpect === "answer") return `Welcome back. ${conv.lastResponse}`;
    return "I'm listening. How can I help you?";
}

// ---------------------------------------------------------------- global commands

const GLOBAL = [
    { id: "repeat", re: /^(repeat( that| it| yourself| the question| what you said)?( again)?|say (that|it) again|again|come again|once more|explain that again|what did you say|what was that|pardon( me)?|sorry what|i didn'?t (hear|get|catch|understand) (that|you|it))$/ },
    { id: "slower", re: /\b((speak|talk|go|read)?\s*(more )?(slowly|slower)|slow down|too fast)\b/ },
    { id: "faster", re: /\b((speak|talk|go|read)?\s*(more )?(quickly|faster)|speed up|too slow)\b/ },
    { id: "normal", re: /\b((normal|regular|default) (speed|rate|pace)|speak normally|talk normally|reset (the )?speed)\b/ },
    { id: "mute", re: /^(mute|mute (yourself|your voice|zoro|the voice)|turn (off|down) your voice|stop talking out loud)$/ },
    { id: "unmute", re: /^(un ?mute|un ?mute (yourself|your voice|zoro)|turn (on|up) your voice|talk to me again|speak (out loud|aloud) again)$/ },
    { id: "startOver", re: /^(start (over|again)|restart|begin again|reset( the conversation)?)$/ },
    { id: "back", re: /^(go back one step|back one step|previous (step|question)|undo( that)?|go back a step)$/ },
    { id: "options", re: /^(what (are my )?options( do i have)?|what can i (say|do)|help|help me|options)$/ },
    { id: "quiet", re: /^(stop (speaking|talking|reading)|be quiet|quiet|shush|silence)$/ },
    { id: "changedMind", re: /\b(i (have |'ve )?changed my mind)\b/ },
];
// "go back" during a conversation steps back in it; outside one it goes to the previous page.
const BARE_BACK = /^(go back|back|previous)$/;

/** Polite and filler words around a command: "can you repeat that please" -> "repeat that". */
export function stripPolite(t) {
    return String(t || "")
        .replace(/^((um+|uh+|hmm+|okay so|ok so|so|well|hey|please|kindly)\s+)+/, "")
        .replace(/^(can|could|would|will) you (please )?/, "")
        .replace(/\s+(please|for me|now|zoro)$/, "")
        .replace(/^please\s+/, "")
        .trim();
}

function globalCommand(t) {
    const plain = stripPolite(t);
    const found = GLOBAL.find((g) => g.re.test(plain));
    return found ? found.id : null;
}

/** True when a spoken answer came with a confidence the browser itself rated low. */
const unsure = (heard) => Boolean(heard) && heard.source === "voice" && typeof heard.confidence === "number" && heard.confidence < LOW_CONFIDENCE;

// ---------------------------------------------------------------- main entry

/**
 * One turn of the conversation. Never throws for ordinary input.
 * heard (optional): { source: "voice" | "typed" | "button", confidence, alternatives } for the text.
 *
 * This is a thin wrapper around zoroTurnCore: it keeps the page in step with what the conversation
 * has learned so far (env.navigate/env.setVoiceFilter), on top of zoroTurnCore's own spoken reply,
 * so every path through the conversation gets this for free rather than each step having to call
 * navigate itself. See syncPageWithConversation below.
 */
export async function zoroTurn(text, conv, env, heard = {}) {
    const result = await zoroTurnCore(text, conv, env, heard);
    return { ...result, conv: syncPageWithConversation(env, conv, result.conv) };
}

/**
 * Opens the category page as soon as it is known, and keeps it (and its brand/type/colour/size/
 * budget filter) in step as the conversation narrows — without re-navigating every turn once the
 * shopper is already on the right page. Once the conversation narrows to one specific product, its
 * page opens too. A bare brand or type with no resolved category has no single page to jump to, so
 * nothing happens until a category is known (see extractEntities/CATEGORY_WORDS in shoppingCatalog.js).
 *
 * prevConv is the conversation as it stood before this turn: a reset such as "start over" builds a
 * brand new conversation object (via createConversation()) that already has no memory of having
 * navigated anywhere, so prevConv is what lets a stale filter actually get cleared in that case.
 */
function syncPageWithConversation(env, prevConv, conv) {
    let next = conv;
    const s = conv.slots || {};
    const wasOnCategoryPage = Boolean(prevConv && prevConv.lastNavigatedCategory);
    if (!s.category) {
        if (wasOnCategoryPage && env.setVoiceFilter) env.setVoiceFilter(null);
        if (next.lastNavigatedCategory) next = { ...next, lastNavigatedCategory: null };
    } else {
        if (env.setVoiceFilter) {
            env.setVoiceFilter({ category: s.category, type: s.type, brand: s.brand, color: s.color, size: s.size, budgetMax: s.budgetMax, budgetMin: s.budgetMin });
        }
        if (env.navigate && next.lastNavigatedCategory !== s.category) {
            env.navigate(`/categories/${s.category}`);
            next = { ...next, lastNavigatedCategory: s.category };
        }
    }
    if (conv.productId && conv.productId !== next.lastNavigatedProductId) {
        if (env.navigate) env.navigate(`/product/${conv.productId}`);
        next = { ...next, lastNavigatedProductId: conv.productId };
    } else if (!conv.productId && next.lastNavigatedProductId) {
        next = { ...next, lastNavigatedProductId: null };
    }
    return next;
}

async function zoroTurnCore(text, conv, env, heard = {}) {
    const t = normalizeSpeech(text).replace(/\b(hey zoro|zoro)\b/g, "").replace(/\s+/g, " ").trim();
    if (!t) return notUnderstood(conv, "Sorry, I didn't catch that. Please say it again.", conv.lastExpect, conv.lastChoices);

    let g = globalCommand(t);
    if (!g && BARE_BACK.test(stripPolite(t)) && conv.workflow && conv.history.length) g = "back";
    if (g === "repeat") return respond(conv, conv.lastResponse || "I haven't said anything yet. How can I help you?", conv.lastExpect, conv.lastChoices);
    if (g === "slower" || g === "faster" || g === "normal") {
        env.setSpeechRate && env.setSpeechRate(g);
        const said = g === "slower" ? "Okay, I'll speak more slowly." : g === "faster" ? "Okay, I'll speak faster." : "Okay, back to normal speed.";
        return respond(conv, conv.lastExpect === "answer" ? `${said} ${conv.lastResponse}` : said, conv.lastExpect, conv.lastChoices);
    }
    if (g === "quiet") return respond(conv, "Okay.", conv.lastExpect, conv.lastChoices);
    if (g === "mute" || g === "unmute") {
        if (env.setMuted) env.setMuted(g === "mute");
        const said = g === "mute"
            ? 'Okay, I\'ll stay quiet. My replies are still shown on screen. Say "unmute" to hear me again.'
            : "Okay, I'll speak my replies again.";
        return respond(conv, conv.lastExpect === "answer" ? `${said} ${conv.lastResponse}` : said, conv.lastExpect, conv.lastChoices);
    }
    if (g === "startOver") {
        const fresh = { ...createConversation(), guestChosen: conv.guestChosen };
        return askStep({ ...fresh, workflow: "discover" }, "category", "Okay, let's start again. What would you like to shop for? I can help with shoes, electronics, clothes or food.", categoryChoices());
    }
    if (g === "options") return respond(conv, optionsText(conv), conv.lastExpect, conv.lastChoices);
    if (g === "back" && !conv.history.length) {
        return respond(conv, `There is no earlier step. ${conv.lastResponse}`.trim(), conv.lastExpect, conv.lastChoices);
    }
    if (g === "changedMind" && conv.workflow === "discover") {
        const fresh = { ...endWorkflow(conv), workflow: "discover" };
        return askStep(remember(fresh), "category", "No problem. What would you like to shop for instead?", categoryChoices());
    }

    try {
        if (g === "back") {
            const previous = conv.history[conv.history.length - 1];
            const restored = { ...conv, ...previous, history: conv.history.slice(0, -1), confirm: null, shown: [], listOffset: 0 };
            return withPrefix("Okay, going back one step.", await advanceDiscovery(restored, env));
        }
        if (conv.legacyPending) return await answerLegacy(text, conv, env, heard);
        if (conv.confirm) return await answerConfirm(t, text, conv, env, heard);
        if (conv.step) return await answerStep(t, text, conv, env, heard);
        return await newRequest(text, conv, env);
    } catch (e) {
        if (e && e.name === "AbortError") throw e;
        // A catalog that cannot be read is said plainly; it is never treated as "no matches".
        if (e && e.name === "CatalogError") return respond(conv, CATALOG_UNAVAILABLE, conv.lastExpect, conv.lastChoices);
        console.error("Zoro turn failed:", e);
        return respond(conv, "Sorry, something went wrong. Nothing was changed. Please try again.", conv.lastExpect, conv.lastChoices);
    }
}

function withPrefix(prefix, result) {
    const message = `${prefix} ${result.reply.message}`;
    return { conv: { ...result.conv, lastResponse: message }, reply: { ...result.reply, message } };
}

function optionsText(conv) {
    if (conv.lastExpect === "answer" && conv.lastChoices && conv.lastChoices.length) {
        return `You can say ${sentenceList(conv.lastChoices.map((c) => `"${c.label}"`), "or")}. ${conv.lastResponse}`;
    }
    if (conv.confirm) return `Please say yes or no, or tell me what you would like to change. ${conv.lastResponse}`;
    return HELP_TEXT;
}

const categoryChoices = () => CATEGORIES.map((c) => ({ label: c, say: c }));

// ---------------------------------------------------------------- answers to the command layer's questions

const LEGACY_CHOICE_LIMIT = 5;
export function legacyChoices(pending) {
    if (!pending) return [];
    if (pending.kind === "chooseProduct") {
        return [...pending.options.slice(0, LEGACY_CHOICE_LIMIT).map((p, i) => ({ label: p.name, say: String(i + 1) })), { label: "Cancel", say: "no", quiet: true }];
    }
    if (pending.kind === "chooseVariant") return [...pending.options.map((o) => ({ label: o, say: o })), { label: "Cancel", say: "no", quiet: true }];
    return [{ label: pending.kind === "confirmOrder" ? "Yes, place the order" : "Yes", say: "yes" }, { label: "No", say: "no", quiet: true }];
}

function fromLegacy(conv, outcome) {
    if (!outcome) return respond({ ...conv, legacyPending: null }, "Okay.");
    if (outcome.type === "stop") return respond({ ...conv, legacyPending: null }, outcome.message, "stop");
    const extra = outcome.unclear ? { unclear: true } : {};
    if (outcome.type === "ask") return respond({ ...conv, legacyPending: outcome.pending }, outcome.message, "answer", legacyChoices(outcome.pending), extra);
    return respond({ ...conv, legacyPending: null }, outcome.message, "command", [], extra);
}

const CONSENT_QUESTIONS = ["confirmAdd", "confirmQuantity", "confirmOrder"];

async function answerLegacy(text, conv, env, heard) {
    if (CONSENT_QUESTIONS.includes(conv.legacyPending.kind) && classifyAnswer(text).answer === "yes" && unsure(heard)) {
        return notUnderstood(conv, UNSURE_YES, "answer", conv.lastChoices);
    }
    const outcome = await env.legacyResolve(conv.legacyPending, text);
    return fromLegacy(conv, outcome);
}

// ---------------------------------------------------------------- new requests

const STRONG_COMMANDS = ["NAVIGATE", "CART_TOTAL", "CHECKOUT", "PLACE_ORDER", "GO_BACK", "STOP_LISTENING", "TOGGLE_CONTRAST", "TOGGLE_SCREEN_READER", "SET_QUANTITY", "SIGN_IN", "REGISTER"];

const READ_SIZES = /\b(what|which|read|tell me)\b.*\bsizes?\b/;
const READ_COLORS = /\b(what|which|read|tell me)\b.*\b(colou?rs?)\b/;

async function newRequest(text, conv, env) {
    const t = normalizeSpeech(text);
    if (READ_SIZES.test(t) || READ_COLORS.test(t)) {
        const answered = await readOptions(t, conv, env);
        if (answered) return answered;
    }
    // A category in the request limits the read to that category ("black gym shoes" reads shoes).
    const category = spokenCategory(text);
    // "Something cheaper" with nothing to compare against: ask, instead of searching for the words.
    if (CHEAPER.test(t) && !category && !extractEntities(text).type) {
        return respond(conv, 'Cheaper than what? Tell me what you\'re looking for, for example "cheaper shoes" or "phones under 20000".');
    }
    let products = category ? await productsFor(env, category) : [];
    let action = await env.interpret(text, products);
    let intent = action ? action.intent : "UNKNOWN";
    if (!category && CATALOG_INTENTS.includes(intent)) {
        products = await productsFor(env);
        // A brand on its own ("show me Nike") is recognised only against the catalog's brands.
        if (intent === "UNKNOWN") {
            action = await env.interpret(text, products, { localOnly: true });
            intent = action ? action.intent : "UNKNOWN";
        }
    }
    // Local, catalog-checked details win; the AI's hints are grounded the same way before use.
    const entities = { ...groundAiEntities(action && action.entities, products), ...extractEntities(text, products) };

    const discoveryWords = entities.category || entities.type || entities.unavailableType || entities.color || entities.colorWord;
    if (intent === "FIND_PRODUCT") {
        // "I'm looking for Nike Air Force 1": one exact product goes straight to it.
        // Only words that name a product go straight to it: "black shoes" must not pick the one
        // product whose name happens to contain "Black".
        const named = (action && action.target) || stripRequest(text);
        const exact = namesAProduct(named, products) ? resolveProduct(named, products) : { status: "none" };
        if (exact.status === "one" && (env.user || conv.guestChosen)) {
            const base = { ...endWorkflow(conv), workflow: "discover", guestChosen: conv.guestChosen, slots: slotValues({ ...entities, category: storeCategoryOf(exact.product) || entities.category }) };
            return chooseProduct(remember(base), exact.product, env, `I found ${exact.product.name}.`);
        }
    }
    if (intent === "FIND_PRODUCT" || ((intent === "SEARCH" || intent === "UNKNOWN") && discoveryWords && !entitiesOnlyBrand(entities))) {
        return startDiscovery(text, entities, conv, env);
    }
    if (intent === "HELP") return respond(conv, HELP_TEXT);
    if (intent === "SIGN_IN") return startSignIn(conv, env, { includeGuest: !env.user });
    if (intent === "REGISTER") return startRegister(conv, env);
    if (intent === "CHECKOUT") return startCheckout(conv, env);
    if (intent === "PLACE_ORDER") return placeOrder(conv, env);
    if (intent === "NAVIGATE" && action.target === "/account" && !env.user && !conv.guestChosen) {
        return startSignIn({ ...conv, deferred: text }, env, { includeGuest: true, reason: "account" });
    }
    if ((intent === "ADD_TO_CART" || intent === "ONE_SHOT_PURCHASE") && discoveryWords && !productNamed(action.target, products)) {
        return startDiscovery(text, entities, conv, env);
    }
    const outcome = await env.legacyRun(action, products);
    return fromLegacy(conv, outcome);
}

/** AI entities are hints: map them through the same catalog vocabulary as spoken words. */
function groundAiEntities(ai, products) {
    if (!ai) return {};
    const phrase = [ai.productType, ai.color, ai.brand, ai.size ? `size ${ai.size}` : "", ai.sizeSystem && ai.size ? `${ai.sizeSystem} ${ai.size}` : ""].filter(Boolean).join(" ");
    const grounded = phrase ? extractEntities(phrase, products) : {};
    if (ai.category && !grounded.category) grounded.category = ai.category;
    if (ai.budgetMax && !grounded.budgetMax) grounded.budgetMax = ai.budgetMax;
    if (ai.quantity && !grounded.quantity) grounded.quantity = ai.quantity;
    // An inferred type is never exact: it is read back as the closest match for confirmation.
    if (grounded.type && ai.productType) grounded.closest = grounded.closest || !typesFor(grounded.category, products).includes(String(ai.productType).toLowerCase());
    return grounded;
}

const stripRequest = (text) => normalizeSpeech(text).replace(/^(hi|hello|hey)\s+/, "").replace(/\b(i'?m|i am) looking for|i need|i want|i'?d like|i would like|find me|get me|show me|do you have|a pair of|please\b/g, " ").replace(/\s+/g, " ").trim();
const entitiesOnlyBrand = (e) => e.brand && !e.category && !e.type && !e.color && !e.colorWord && !e.unavailableType;
function productNamed(target, products) {
    const t = normalizeSpeech(target || "");
    return Boolean(t) && products.some((p) => t.includes(normalizeSpeech(p.name)) || normalizeSpeech(p.name).includes(t));
}

async function readOptions(t, conv, env) {
    const products = conv.slots.category ? await productsFor(env, conv.slots.category) : [];
    let pool = null;
    let what = "";
    if (conv.productId) {
        const p = products.find((x) => x.id === conv.productId);
        if (p) { pool = [p]; what = p.name; }
    }
    if (!pool && conv.workflow === "discover" && conv.slots.category) {
        pool = filterProducts(products, { ...conv.slots, color: null, size: null });
        what = describeWanted(conv.slots);
    }
    if (!pool && env.currentProduct && env.currentProduct()) {
        const p = env.currentProduct();
        pool = [p];
        what = p.name;
    }
    if (!pool || !pool.length) return null;
    if (READ_SIZES.test(t)) {
        const sizes = sizesFromProducts(pool);
        const message = sizes.length ? `Sizes available for ${what}: ${sentenceList(sizes)}.` : `No sizes are listed for ${what}.`;
        return respond(conv, conv.lastExpect === "answer" ? `${message} ${conv.lastResponse}` : message, conv.lastExpect, conv.lastChoices);
    }
    const colors = colorsFrom(pool);
    const message = colors.length ? `Colours available for ${what}: ${sentenceList(colors)}.` : `No colours are listed for ${what}.`;
    return respond(conv, conv.lastExpect === "answer" ? `${message} ${conv.lastResponse}` : message, conv.lastExpect, conv.lastChoices);
}

// ---------------------------------------------------------------- discovery

function describeWanted(s, { withSize = true } = {}) {
    const parts = [];
    if (s.color) parts.push(s.color);
    if (s.brand) parts.push(cap(s.brand));
    if (s.type) parts.push(s.closest && s.typeWord ? s.typeWord : typeLabel(s.type));
    const noun = s.category === "Shoes" ? "shoes" : s.type ? "" : categoryNoun(s.category || "products");
    let text = [...parts, noun].filter(Boolean).join(" ");
    if (s.category === "Shoes" && s.type && !/shoes$/.test(text)) text += " shoes";
    if (withSize && s.size) text += s.category === "Shoes" ? ` in size ${s.sizeSystem ? `${s.sizeSystem} ` : ""}${s.size}` : `, ${s.size}`;
    if (s.budgetMax) text += ` under ${price(s.budgetMax)}`;
    if (s.budgetMin) text += ` over ${price(s.budgetMin)}`;
    return text.trim() || "products";
}

/** Read-back for newly captured details, with an honest note when a type is only the closest match. */
function confirmSlotsMessage(values, conv) {
    const merged = { ...conv.slots, ...values };
    let message = `I understood that you're looking for ${describeWanted(merged)}.`;
    if (values.type && merged.closest && merged.typeWord) {
        message = `I understood that you're looking for ${describeWanted(merged)}. I don't have a separate ${merged.typeWord} category; ${typeLabel(merged.type)} ${merged.category === "Shoes" ? "shoes are" : "is"} the closest match.`;
    }
    return `${message} Is that correct?`;
}

function slotValues(entities) {
    const v = {};
    for (const k of ["category", "type", "typeWord", "closest", "brand", "color", "size", "sizeSystem", "budgetMax", "budgetMin", "quantity"]) {
        if (entities[k] !== undefined && entities[k] !== null) v[k] = entities[k];
    }
    if (v.type && !v.closest) v.closest = false;
    return v;
}

async function startDiscovery(text, entities, conv, env) {
    if (!env.user && !conv.guestChosen) {
        return startSignIn({ ...conv, deferred: text }, env, { includeGuest: true, reason: "shopping" });
    }
    const base = { ...endWorkflow(conv), workflow: "discover", guestChosen: conv.guestChosen, legacyPending: null };
    const notes = [];
    if (entities.unavailableType) {
        notes.push(`There are no ${entities.unavailableType} ${categoryNoun(entities.category)} in the store at the moment.`);
    }
    if (entities.colorWord) notes.push(`I don't see ${entities.colorWord} listed for any product.`);
    const values = slotValues(entities);
    if (Object.keys(values).filter((k) => !["closest", "typeWord"].includes(k)).length) {
        return withNotes(notes, askConfirm({ ...base, step: null }, { kind: "slots", values }, confirmSlotsMessage(values, base)));
    }
    return withNotes(notes, await advanceDiscovery(base, env));
}

function withNotes(notes, result) {
    return notes.length ? withPrefix(notes.join(" "), result) : result;
}

/** Works out the next question from what is known. */
async function advanceDiscovery(conv, env, { prefix = "" } = {}) {
    const s = conv.slots;
    const say = (result) => (prefix ? withPrefix(prefix, result) : result);

    if (!s.category) {
        return say(askStep(conv, "category", "What would you like to shop for? I can help with shoes, electronics, clothes or food.", categoryChoices()));
    }
    const products = await productsFor(env, s.category);
    const types = typesFor(s.category, products);
    if (!s.type && types.length > 1) {
        const labels = types.map(typeLabel);
        const noun = categoryNoun(s.category);
        let message = `What type of ${noun} are you looking for? I have ${sentenceList(labels.map((l) => (s.category === "Shoes" ? `${l} shoes` : l)), "or")}.`;
        if (s.category === "Shoes" && types.includes("sports")) message += " For gym or running, sports shoes are the closest match.";
        return say(askStep(conv, "type", message, types.map((ty) => ({ label: cap(typeLabel(ty)), say: typeLabel(ty) }))));
    }
    if (!s.type && types.length === 1) conv = { ...conv, slots: { ...s, type: types[0] } };

    const slots = conv.slots;
    const base = filterProducts(products, { ...slots, color: null, size: null });
    if (!base.length) return say(noMatches(conv, products));

    const colors = colorsFrom(base);
    if (colors.length && !slots.color && !slots.anyColor) {
        return say(askStep(conv, "color", `What colour would you prefer? Available colours are ${sentenceList(colors)}. You can also say "any colour".`,
            [...colors.map((c) => ({ label: cap(c), say: c })), { label: "Any colour", say: "any colour", quiet: true }]));
    }
    const withColor = filterProducts(products, { ...slots, size: null });
    if (!withColor.length) return say(noMatches(conv, products));

    const sizes = sizesFromProducts(withColor);
    if (sizes.length && !slots.size && !slots.anySize) {
        if (slots.category === "Shoes") return say(sizeModeQuestion(conv));
        return say(askStep(conv, "size", `Which ${sizeWord(slots)} would you like? Available options are ${sentenceList(sizes)}. You can also say "any".`,
            [...sizes.map((x) => ({ label: x, say: x })), { label: "Any", say: "any", quiet: true }]));
    }
    const matches = rankProducts(filterProducts(products, slots), slots);
    if (!matches.length) return say(noMatches(conv, products));
    return say(listProducts({ ...conv, shown: matches.map((p) => p.id), listOffset: 0 }, matches, env));
}

const sizeWord = (s) => (s.category === "Electronics" ? "storage option" : "size");

function sizeModeQuestion(conv) {
    return askStep(conv, "sizeMode", "Do you already know your shoe size, or would you like help choosing one?",
        [{ label: "I know my size", say: "I know my size" }, { label: "Help me choose", say: "help me choose" }]);
}

function noMatches(conv, products) {
    const s = conv.slots;
    const alternatives = alternativesFor(products, s);
    const what = describeWanted(s);
    const lines = [`I couldn't find any ${what}.`];
    for (const alt of alternatives.slice(0, 2)) {
        if (alt.field === "color" && alt.options.length) lines.push(`Without the colour, there ${alt.count === 1 ? "is 1 match" : `are ${alt.count} matches`}, in ${sentenceList(alt.options)}.`);
        else if (alt.field === "size" && alt.options.length) lines.push(`The sizes available are ${sentenceList(alt.options)}.`);
        else if (alt.field === "brand" && alt.options.length) lines.push(`Other brands that match are ${sentenceList(alt.options.map(cap))}.`);
        else if (alt.field === "budget") lines.push(`Without the price limit there ${alt.count === 1 ? "is 1 match" : `are ${alt.count} matches`}, from ${price(alt.cheapest)}.`);
        else if (alt.field === "type" && alt.options.length) lines.push(`Other types that match are ${sentenceList(alt.options.map(typeLabel))}.`);
    }
    lines.push("Would you like to change the colour, size, brand, type or budget? You can also say \"start over\".");
    return askStep({ ...conv, shown: [] }, "refine", lines.join(" "));
}

function describeOption(p, s) {
    const bits = [p.name];
    if (s.color && colorsOf(p).includes(s.color)) bits.push(s.color);
    if (s.size && Array.isArray(p.size)) bits.push(s.category === "Shoes" ? `size ${matchAvailableSize(s.size, p.size.map(String)) || s.size}` : s.size);
    bits.push(price(p.price));
    return bits.join(", ");
}

function listProducts(conv, matches, env) {
    const s = conv.slots;
    if (matches.length === 1) {
        const only = matches[0];
        return chooseProduct({ ...conv, shown: [only.id] }, only, env, "", { single: true });
    }
    const page = matches.slice(conv.listOffset, conv.listOffset + LIST_PAGE);
    const intro = conv.listOffset === 0
        ? `I found ${plural(matches.length, "matching option")}.`
        : `Here are options ${conv.listOffset + 1} to ${conv.listOffset + page.length} of ${matches.length}.`;
    const lines = page.map((p, i) => `Option ${i + 1}: ${describeOption(p, s)}.`);
    const more = matches.length > conv.listOffset + page.length ? ' Say "more options" to hear more.' : "";
    const message = `${intro} ${lines.join(" ")}${more} Which option would you like?`;
    return askStep({ ...conv, shown: page.map((p) => p.id) }, "chooseProduct", message,
        page.map((p, i) => ({ label: p.name, say: `option ${i + 1}` })));
}

/** After a product is picked: ask any option it still needs, then read it back with the add question. */
function chooseProduct(conv, product, env, intro = "", { single = false } = {}) {
    const s = conv.slots;
    const selected = { ...conv.selected };
    const colors = colorsOf(product);
    const sizes = Array.isArray(product.size) ? product.size.map(String) : [];
    if (colors.length && !selected.color) {
        if (s.color && colors.includes(s.color)) selected.color = s.color;
        else if (colors.length === 1) selected.color = colors[0];
    }
    if (sizes.length && !selected.size) {
        const matched = s.size ? matchAvailableSize(s.size, sizes) : null;
        if (matched) selected.size = matched;
        else if (sizes.length === 1) selected.size = sizes[0];
    }
    const next = { ...conv, productId: product.id, selected };
    const prefix = intro ? `${intro} ` : single ? `I found one match: ${product.name}, ${price(product.price)}. ` : "";
    if (colors.length > 1 && !selected.color) {
        return askStep(next, "productColor", `${prefix}${product.name} comes in ${sentenceList(colors, "or")}. Which colour would you like?`,
            colors.map((c) => ({ label: cap(c), say: c })));
    }
    if (sizes.length > 1 && !selected.size) {
        if (s.category === "Shoes" && !next.sizing.mode) return withPrefix(prefix.trim(), sizeModeQuestion(next));
        return askStep(next, "productSize", `${prefix}${product.name} is available in ${sizeWord(s) === "size" ? "sizes" : ""} ${sentenceList(sizes, "or")}. Which ${sizeWord(s)} would you like?`.replace(/\s+/g, " "),
            sizes.map((x) => ({ label: x, say: x })));
    }
    const readBack = productReadBack(product, selected, s.quantity || 1);
    const message = single ? `I found one match: ${readBack}.` : `${prefix}You selected ${readBack}.`;
    return askConfirm({ ...next, step: null }, { kind: "product" }, `${message} Shall I add this item to your cart?`);
}

function productReadBack(product, selected, quantity) {
    const bits = [product.name];
    if (selected.color) bits.push(selected.color);
    if (selected.size) bits.push(/gb$/i.test(selected.size) ? selected.size : `size ${selected.size}`);
    const each = quantity > 1 ? ` each, ${quantity} in total` : "";
    return `${bits.join(", ")}, for ${price(product.price)}${each}`;
}

async function addSelected(conv, env) {
    const products = await productsFor(env, conv.slots.category);
    const product = products.find((p) => p.id === conv.productId);
    if (!product) return respond(endWorkflow(conv), "Sorry, that product is no longer in the catalog. Nothing was added.");
    const quantity = conv.slots.quantity || 1;
    const item = { ...product, ...conv.selected };
    try {
        await env.addToCart(item, quantity);
    } catch (e) {
        console.error("Zoro add to cart failed:", e);
        return askConfirm(conv, { kind: "product" }, "Sorry, I couldn't add it to your cart, so nothing was added. Shall I try again?");
    }
    const option = [conv.selected.color, conv.selected.size && (/gb$/i.test(conv.selected.size) ? conv.selected.size : `size ${conv.selected.size}`)].filter(Boolean).join(", ");
    if (env.navigate) env.navigate("/cart");
    const kept = { ...endWorkflow(conv), workflow: "afterAdd", guestChosen: conv.guestChosen, history: [] };
    return askStep(kept, "afterAdd",
        `Added ${quantity > 1 ? `${quantity} of ` : ""}${product.name}${option ? `, ${option},` : ""} to your cart. Would you like to keep shopping, or check out?`,
        [{ label: "Keep shopping", say: "keep shopping" }, { label: "Check out", say: "check out" }]);
}

// ---------------------------------------------------------------- answers to questions

const SKIP = /^(skip|skip it|no|nope|i'?d rather not( say)?|rather not|i don'?t know|don'?t know|not sure|no idea|pass)$/;
const ANY = /\b(any|anything|doesn'?t matter|does not matter|no preference|whatever|either)\b/;
const MORE = /\b(more options|more|next|other options)\b/;
const CHEAPER = /\b(cheaper|less expensive|lower price|more affordable)\b/;
const CORRECTION_CUE = /\b(actually|instead|change|switch|rather|make it|i want|i'd like|i would like|how about|what about)\b/;

// Steps whose answers the browser's alternative hearings may help with: each is read back first.
const ALTERNATIVE_STEPS = ["category", "type", "color", "size", "knownSize", "fitSize", "productColor", "productSize", "height", "weight", "footLength", "loginEmail", "registerEmail"];

/** Other ways the browser heard a short spoken answer, best first (never for typed text or buttons). */
function otherHearings(heard, text) {
    if (!heard || heard.source !== "voice" || !Array.isArray(heard.alternatives)) return [];
    const said = normalizeSpeech(text);
    return heard.alternatives.filter((a) => normalizeSpeech(a) && normalizeSpeech(a) !== said).slice(0, 3);
}

async function answerStep(t, text, conv, env, heard) {
    const step = conv.step;
    if (conv.workflow === "discover" || conv.workflow === "afterAdd") {
        const corrected = await maybeCorrection(t, text, conv, env);
        if (corrected) return corrected;
    }
    const handler = STEP_HANDLERS[step];
    const result = handler ? await handler(t, text, conv, env) : null;
    if (result) return result;
    // The browser's next-best hearing ("blew" -> "blue"), only when it gives an answer that is read
    // back for a yes or no; nothing is chosen from it directly.
    if (handler && ALTERNATIVE_STEPS.includes(step)) {
        for (const alt of otherHearings(heard, text)) {
            const retried = await handler(normalizeSpeech(alt), alt, conv, env);
            if (retried && retried.conv.confirm) return retried;
        }
    }
    // Not an answer: if it is clearly a different command, leave this step and do that instead.
    const products = await productsFor(env, spokenCategory(text) || conv.slots.category);
    const local = await env.interpret(text, products, { localOnly: true });
    if (local && STRONG_COMMANDS.includes(local.intent)) {
        return newRequest(text, { ...endWorkflow(conv), legacyPending: null }, env);
    }
    return notUnderstood(conv, `Sorry, I didn't catch that. ${conv.lastResponse}`, "answer", conv.lastChoices);
}

/** "Actually, I want blue", "change my size to 10", "show cheaper options". */
async function maybeCorrection(t, text, conv, env) {
    if (CHEAPER.test(t)) {
        const products = await productsFor(env, conv.slots.category);
        const shown = conv.shown.map((id) => products.find((p) => p.id === id)).filter(Boolean);
        const selected = conv.productId && products.find((p) => p.id === conv.productId);
        const reference = selected ? Number(selected.price) : shown.length ? Math.min(...shown.map((p) => Number(p.price))) : null;
        if (!reference) return respond(conv, `Cheaper than what? ${conv.lastResponse}`, "answer", conv.lastChoices);
        const next = remember({ ...conv, slots: { ...conv.slots, cheaperThan: reference }, productId: null, selected: {}, shown: [], listOffset: 0 });
        const cheaper = filterProducts(products, next.slots);
        if (!cheaper.length) return respond(conv, `There are no cheaper options that match. ${conv.lastResponse}`, "answer", conv.lastChoices);
        return withPrefix(`Here are options under ${price(reference)}.`, await advanceDiscovery(next, env));
    }
    if (!CORRECTION_CUE.test(t)) return null;
    // "Actually, a laptop" moves to another category: its words decide which products to read.
    const products = await productsFor(env, spokenCategory(text) || conv.slots.category);
    const e = extractEntities(text, products);
    const values = slotValues(e);
    delete values.quantity;
    const stepField = { color: "color", size: "size", type: "type", category: "category", productColor: "color", productSize: "size" }[conv.step];
    const fields = Object.keys(values).filter((k) => !["closest", "typeWord"].includes(k));
    if (stepField && fields.length && fields.every((k) => k === stepField || (stepField === "type" && k === "category"))) return null;
    if (!Object.keys(values).filter((k) => !["closest", "typeWord"].includes(k)).length) {
        if (e.colorWord) return respond(conv, `I don't see ${e.colorWord} listed for these products. ${conv.lastResponse}`, "answer", conv.lastChoices);
        return null;
    }
    return askConfirm(conv, { kind: "slots", values, correction: true }, confirmSlotsMessage(values, conv).replace("you're looking for", "you'd now like"));
}

const STEP_HANDLERS = {
    async category(t, text, conv, env) {
        const named = CATEGORIES.find((c) => t.includes(c.toLowerCase()));
        const answered = spokenCategory(text) || named;
        const e = extractEntities(text, answered ? await productsFor(env, answered) : []);
        if (!e.category && named) e.category = named;
        if (!e.category) return null;
        return askConfirm(conv, { kind: "slots", values: slotValues(e) }, confirmSlotsMessage(slotValues(e), conv));
    },
    async type(t, text, conv, env) {
        const products = await productsFor(env, conv.slots.category);
        const e = extractEntities(text, products);
        const types = typesFor(conv.slots.category, products);
        let type = e.category === conv.slots.category ? e.type : null;
        if (!type) type = types.find((ty) => t.includes(ty) || t.includes(typeLabel(ty).toLowerCase()));
        if (!type) {
            if (e.unavailableType) {
                return respond(conv, `There are no ${e.unavailableType} ${categoryNoun(conv.slots.category)} at the moment. ${conv.lastResponse}`, "answer", conv.lastChoices);
            }
            return null;
        }
        const values = { type, typeWord: e.type === type ? e.typeWord : typeLabel(type), closest: e.type === type ? Boolean(e.closest) : false };
        ["color", "size", "sizeSystem", "brand", "budgetMax"].forEach((k) => { if (e[k]) values[k] = e[k]; });
        return askConfirm(conv, { kind: "slots", values }, confirmSlotsMessage(values, conv));
    },
    async color(t, text, conv, env) {
        if (ANY.test(t)) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, anyColor: true } }), env);
        const products = await productsFor(env, conv.slots.category);
        const e = extractEntities(text, products, { expect: "color" });
        if (e.color) return askConfirm(conv, { kind: "slots", values: { color: e.color } }, `You'd prefer ${e.color}. Is that correct?`);
        if (e.colorWord) {
            const colors = colorsFrom(filterProducts(products, { ...conv.slots, color: null, size: null }));
            return respond(conv, `Sorry, ${e.colorWord} isn't available for these ${categoryNoun(conv.slots.category)}. Available colours are ${sentenceList(colors)}. Which would you like?`, "answer", conv.lastChoices);
        }
        return null;
    },
    async size(t, text, conv, env) {
        const products = await productsFor(env, conv.slots.category);
        const chosen = conv.productId && products.find((p) => p.id === conv.productId);
        if (ANY.test(t) && !chosen) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, anySize: true } }), env);
        const sizes = chosen ? sizesFromProducts([chosen]) : sizesFromProducts(filterProducts(products, { ...conv.slots, size: null }));
        const letter = matchLetterSize(t, sizes);
        if (letter) return askConfirm(conv, { kind: "slots", values: { size: letter } }, `You selected ${letter}. Is that correct?`);
        const storage = t.match(/\b(\d+)\s*gb\b/);
        const parsed = storage ? { size: `${storage[1]} GB` } : parseSizeAnswer(text);
        if (parsed && parsed.notShoeSize) return notWholeOrHalf(conv, parsed.notShoeSize, sizes);
        const picked = parsed && matchAvailableSize(parsed.size, sizes);
        if (!picked) {
            if (!parsed) return null;
            return respond(conv, `Sorry, ${parsed.size} isn't available. Available options are ${sentenceList(sizes)}. Which would you like?`, "answer", conv.lastChoices);
        }
        return askConfirm(conv, { kind: "slots", values: { size: picked } }, `You selected ${conv.slots.category === "Shoes" ? `size ${picked}` : picked}. Is that correct?`);
    },
    async sizeMode(t, text, conv, env) {
        const direct = parseShoeSize(text);
        if (direct && /\d|\b(size|uk|us|eu)\b/.test(t) && !/\bhelp\b/.test(t)) return knownSizeAnswer(direct, conv);
        if (/\b(know|yes|i do)\b/.test(t) && !/\b(don'?t|do not|not)\b/.test(t)) {
            return askStep({ ...conv, sizing: { ...conv.sizing, mode: "known" } }, "knownSize", "Great. What shoe size do you usually wear?");
        }
        if (/\b(help|don'?t know|do not know|not sure|no|estimate|choose)\b/.test(t)) {
            const next = { ...conv, sizing: { ...conv.sizing, mode: "help" } };
            return askStep(next, "height",
                `Don't worry. I can help you narrow down a suitable size. I'll ask a few questions, but ${HEIGHT_WEIGHT_NOTE.charAt(0).toLowerCase()}${HEIGHT_WEIGHT_NOTE.slice(1)} What is your height? You can tell me in centimetres or in feet and inches, or say "skip".`);
        }
        return null;
    },
    async knownSize(t, text, conv) {
        const parsed = parseSizeAnswer(text);
        if (parsed && parsed.notShoeSize) return notWholeOrHalf(conv, parsed.notShoeSize);
        return parsed ? knownSizeAnswer(parsed, conv) : null;
    },
    async height(t, text, conv) {
        if (SKIP.test(t)) return askWeight(conv);
        const h = parseHeight(text);
        if (!h) return null;
        return askConfirm(conv, { kind: "height", cm: h.cm }, `I understood your height as ${h.cm} centimetres. Is that correct?`);
    },
    async weight(t, text, conv) {
        if (SKIP.test(t)) return askFit(conv);
        const w = parseWeight(text);
        if (!w) return null;
        return askConfirm(conv, { kind: "weight", kg: w.kg }, `I understood your weight as ${w.kg} kilograms. Is that correct?`);
    },
    async fitSize(t, text, conv) {
        const parsed = /\d|\b(size|uk|us|eu)\b/.test(t) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(t) ? parseShoeSize(text) : null;
        if (parsed) return knownSizeAnswer(parsed, conv, "Your comfortable shoes are");
        if (SKIP.test(t) || /\b(no|don'?t have)\b/.test(t)) return askFoot(conv);
        return null;
    },
    async footLength(t, text, conv, env) {
        if (/\b(measure|how|guide|guidance|help)\b/.test(t)) {
            return askStep(conv, "footLength", `${MEASURING_GUIDE} When you're ready, tell me the length in centimetres, or say "skip".`);
        }
        if (SKIP.test(t)) return chooseSizeAfterHelp(conv, env, null);
        const f = parseFootLength(text);
        if (!f) return null;
        return askConfirm(conv, { kind: "foot", cm: f.cm }, `I understood your foot length as ${f.cm} centimetres. Is that correct?`);
    },
    async chooseProduct(t, text, conv, env) {
        const products = await productsFor(env, conv.slots.category);
        const all = rankProducts(filterProducts(products, conv.slots), conv.slots);
        if (MORE.test(t) && !/\b(option|number)\s+\w+/.test(t)) {
            const offset = conv.listOffset + LIST_PAGE;
            if (offset >= all.length) return respond(conv, `Those are all the options. ${conv.lastResponse}`, "answer", conv.lastChoices);
            return listProducts({ ...conv, listOffset: offset }, all, env);
        }
        const shown = conv.shown.map((id) => products.find((p) => p.id === id)).filter(Boolean);
        const index = parseOptionIndex(text, shown.length);
        const product = index !== null ? shown[index] : pickFromList(text, shown);
        if (!product) return null;
        return chooseProduct(remember(conv), product, env);
    },
    async productColor(t, text, conv, env) {
        const products = await productsFor(env, conv.slots.category);
        const product = products.find((p) => p.id === conv.productId);
        const heardColor = product && extractEntities(text, [product], { expect: "color" }).color;
        const color = product && (heardColor || colorsOf(product).find((c) => t.includes(c)));
        if (!color) return null;
        return askConfirm(conv, { kind: "variant", field: "color", value: color }, `You'd like ${color}. Is that correct?`);
    },
    async productSize(t, text, conv, env) {
        const products = await productsFor(env, conv.slots.category);
        const product = products.find((p) => p.id === conv.productId);
        const sizes = product && Array.isArray(product.size) ? product.size.map(String) : [];
        const letter = matchLetterSize(t, sizes);
        if (letter) return askConfirm(conv, { kind: "variant", field: "size", value: letter }, `You selected ${letter}. Is that correct?`);
        const storage = t.match(/\b(\d+)\s*gb\b/);
        const parsed = storage ? { size: `${storage[1]} GB` } : parseSizeAnswer(text);
        if (parsed && parsed.notShoeSize) return notWholeOrHalf(conv, parsed.notShoeSize, sizes);
        const picked = parsed && matchAvailableSize(parsed.size, sizes);
        if (!picked) return parsed ? respond(conv, `Sorry, ${parsed.size} isn't available for ${product.name}. Available options are ${sentenceList(sizes)}.`, "answer", conv.lastChoices) : null;
        return askConfirm(conv, { kind: "variant", field: "size", value: picked }, `You selected ${/gb$/i.test(picked) ? picked : `size ${picked}`}. Is that correct?`);
    },
    async refine(t, text, conv, env) {
        const products = await productsFor(env, spokenCategory(text) || conv.slots.category);
        const e = extractEntities(text, products);
        const values = slotValues(e);
        delete values.quantity;
        if (/\b(colou?r)\b/.test(t) && !values.color) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, color: null, anyColor: false } }), env);
        if (/\b(size)\b/.test(t) && !values.size) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, size: null, anySize: false }, sizing: {} }), env);
        if (/\b(brand)\b/.test(t) && !values.brand) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, brand: null } }), env);
        if (/\b(budget|price)\b/.test(t) && !values.budgetMax) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, budgetMax: null, budgetMin: null, cheaperThan: null } }), env);
        if (/\b(type)\b/.test(t) && !values.type) return advanceDiscovery(remember({ ...conv, slots: { ...conv.slots, type: null, typeWord: null, closest: false } }), env);
        if (!Object.keys(values).length) return null;
        return askConfirm(conv, { kind: "slots", values, correction: true }, confirmSlotsMessage(values, conv).replace("you're looking for", "you'd now like"));
    },
    async afterAdd(t, text, conv, env) {
        if (/\b(check ?out|checkout|pay|billing)\b/.test(t)) return startCheckout(endWorkflow(conv), env);
        if (/\b(keep|continue|more|shopping|shop)\b/.test(t)) {
            return askStep({ ...endWorkflow(conv), workflow: "discover", guestChosen: conv.guestChosen }, "category", "Great. What would you like to shop for next?", categoryChoices());
        }
        return null;
    },
    // ---- sign-in and registration
    async loginMethod(t, text, conv, env) {
        if (/\b(google)\b/.test(t)) return googleHandoff(conv, env);
        if (/\b(create|new account|register|sign up|signup)\b/.test(t)) return startRegister(conv, env);
        if (/\b(guest|browse|browsing|continue|skip|no thanks|not now)\b/.test(t) && conv.allowGuest) return continueAsGuest(conv, env);
        if (/\b(email|e mail|password|sign in|log in|login)\b/.test(t)) return askEmail(conv, env);
        return null;
    },
    async loginEmail(t, text, conv) {
        const email = parseEmail(text);
        if (!email) {
            return respond(conv, 'Sorry, that doesn\'t sound like a complete email address. Please say it again slowly, including "at" and "dot", for example "name at example dot com".', "answer");
        }
        return askConfirm(conv, { kind: "email", email }, `I heard ${speakableEmail(email)}. That is ${email.replace("@", " at ").replace(/\./g, " dot ")}. Is that correct?`);
    },
    async awaitAuth(t, text, conv, env) {
        const retry = await STEP_HANDLERS.loginRetry(t, text, conv, env);
        if (retry) return retry;
        const field = conv.workflow === "register" ? "the password fields, then press Enter to create your account" : "the password field and press Enter";
        return respond(conv, `I'm waiting for you to finish signing in. Type your password in ${field}. Or say "use Google", "change email" or "continue as a guest".`, "keyboard");
    },
    async loginRetry(t, text, conv, env) {
        if (/\b(google)\b/.test(t)) return googleHandoff(conv, env);
        if (/\b(guest|browse|continue)\b/.test(t)) return continueAsGuest(conv, env);
        if (/\b(email|address)\b/.test(t)) return askEmail(conv, env);
        if (/\b(again|password|retry|try|type)\b/.test(t)) return passwordHandoff(conv, env, "login");
        return null;
    },
    async registerName(t, text, conv) {
        const name = String(text || "").replace(/^(my name is|it's|it is|i am|i'm|call me)\s+/i, "").replace(/[^\p{L}\p{M}' .-]/gu, "").trim().slice(0, 80);
        if (name.length < 2) return null;
        return askConfirm(conv, { kind: "name", name }, `Your name is ${name}. Is that correct?`);
    },
    async registerEmail(t, text, conv) {
        const email = parseEmail(text);
        if (!email) return respond(conv, 'Sorry, that doesn\'t sound like a complete email address. Please say it again slowly, including "at" and "dot".', "answer");
        return askConfirm(conv, { kind: "email", email, register: true }, `I heard ${speakableEmail(email)}. That is ${email.replace("@", " at ").replace(/\./g, " dot ")}. Is that correct?`);
    },
    // ---- checkout
    async deliveryField(t, text, conv, env) {
        const rule = SHIPPING_FIELDS.find((r) => r.field === conv.deliveryField);
        if (!rule) return null;
        const numeric = rule.inputMode === "numeric";
        const value = numeric ? parseDigits(text) : String(text || "").replace(/^(it'?s|it is|my (address|city|state) is)\s+/i, "").trim();
        if (!value) return null;
        const error = fieldError(rule, value);
        if (error) return respond(conv, `${error} ${conv.lastResponse}`, "answer");
        const spoken = numeric ? speakableDigits(value) : value;
        return askConfirm(conv, { kind: "field", field: rule.field, value }, `I heard ${spoken}. Is that correct?`);
    },
};

/** A number was heard that is not a whole or half size: say so, never round it. */
function notWholeOrHalf(conv, heardSize, sizes = []) {
    const options = sizes.length ? ` The available sizes are ${sentenceList(sizes)}.` : "";
    return respond(conv, `I heard ${heardSize}. Shoe sizes here are whole or half sizes, such as 9 or 9.5.${options} Which size would you like?`, "answer", conv.lastChoices);
}

function knownSizeAnswer(parsed, conv, lead = "You usually wear") {
    const label = `${parsed.system ? `${parsed.system === "INDIA" ? "India" : parsed.system} ` : ""}size ${parsed.size}`;
    return askConfirm(conv, { kind: "knownSize", size: parsed.size, system: parsed.system }, `${lead} ${label}. Is that correct?`);
}

function askWeight(conv) {
    return askStep(conv, "weight", 'What is your weight in kilograms? You can also say "skip".');
}
function askFit(conv) {
    return askStep(conv, "fitSize", 'Do you have a pair of shoes that fits you comfortably? If so, what size is printed on it? For example, say "UK 9". Or say "no".');
}
function askFoot(conv) {
    return askStep(conv, "footLength", 'Do you know the length of your foot in centimetres? Tell me the length, say "help me measure", or say "skip".');
}

async function chooseSizeAfterHelp(conv, env, estimate) {
    const products = await productsFor(env, conv.slots.category);
    const chosen = conv.productId && products.find((p) => p.id === conv.productId);
    const sizes = chosen ? sizesFromProducts([chosen]) : sizesFromProducts(filterProducts(products, { ...conv.slots, size: null }));
    const s = conv.sizing;
    const parts = [];
    if (estimate) parts.push(estimate);
    else if (s.heightCm || s.weightKg) parts.push("With only height and weight, I don't have enough information to recommend a shoe size reliably.");
    parts.push(`The available sizes are ${sentenceList(sizes)}. Which size would you like?`);
    return askStep(conv, "size", parts.join(" "), sizes.map((x) => ({ label: x, say: `size ${x}` })));
}

async function sizeFromFoot(conv, env) {
    const products = await productsFor(env, conv.slots.category);
    const pool = filterProducts(products, { ...conv.slots, size: null });
    const brands = brandsFrom(pool);
    const brand = conv.slots.brand || (brands.length === 1 ? brands[0] : null);
    const options = env.sizing || {};
    const result = brand ? estimateFromFootLength(conv.sizing.footCm, brand, { charts: options.charts, storeSystem: options.storeSystem === undefined ? STORE_SHOE_SIZE_SYSTEM : options.storeSystem }) : { status: "no_chart" };
    const sizes = sizesFromProducts(pool);
    if (result.status === "ok") {
        const available = matchAvailableSize(result.size, sizes);
        const estimate = `Based on your foot length of ${conv.sizing.footCm} centimetres and ${cap(brand)}'s size chart, size ${result.size} appears to be the closest match. This is an estimate, not a guarantee of fit; check the brand's fit guidance too.` +
            (available ? "" : ` Size ${result.size} isn't available here.`);
        return chooseSizeAfterHelp(conv, env, estimate);
    }
    const reason = result.status === "no_system"
        ? "this store doesn't say whether its shoe sizes are UK or US sizes"
        : `I don't have a verified size chart for ${brand ? cap(brand) : "these brands"}`;
    return chooseSizeAfterHelp(conv, env, `Thank you. Unfortunately ${reason}, so I can't turn a foot length into a size reliably. Compare your measurement with the brand's own size guide on its website.`);
}

// ---------------------------------------------------------------- confirmations

async function answerConfirm(t, text, conv, env, heard) {
    const { answer, rest } = classifyAnswer(text);
    const c = conv.confirm;
    if (answer === "yes" && unsure(heard)) return notUnderstood(conv, UNSURE_YES, "answer", conv.lastChoices);
    if (answer === "yes") return applyConfirm(remember({ ...conv, confirm: null }), c, env);
    if (answer === "no") {
        if (rest) {
            // "No, size 10": treat the rest as the corrected answer to the same question.
            const retried = await reanswer(rest, { ...conv, confirm: null, step: stepFor(c, conv) }, env);
            if (retried) return mergeSlotCorrection(c, retried, conv);
        }
        return reaskAfterNo(conv, c, env);
    }
    // Unclear: "show cheaper options" or "actually, blue" are corrections; a new value for the same
    // question replaces the old one; anything else is asked again.
    if (conv.workflow === "discover") {
        const corrected = await maybeCorrection(t, text, { ...conv, confirm: null }, env);
        if (corrected) return corrected;
    }
    const retried = await reanswer(text, { ...conv, confirm: null, step: stepFor(c, conv) }, env);
    if (retried && retried.conv.confirm) return mergeSlotCorrection(c, retried, conv);
    return notUnderstood(conv, "Sorry, I didn't understand. Please say yes or no, or tell me what you would like to change.", "answer", conv.lastChoices);
}

/** A correction to a multi-detail read-back keeps the other details: "black Nike, size 9?" "No, blue." */
function mergeSlotCorrection(c, retried, conv) {
    const next = retried.conv.confirm;
    if (c.kind !== "slots" || !next || next.kind !== "slots") return retried;
    // "Black?" "No, grey.": the correction replaces everything that was asked; read back just that.
    if (Object.keys(c.values).every((k) => k in next.values)) return retried;
    const values = { ...c.values, ...next.values };
    return askConfirm({ ...conv, confirm: null }, { kind: "slots", values, correction: c.correction }, confirmSlotsMessage(values, conv));
}

function stepFor(c, conv) {
    switch (c.kind) {
        case "slots": return c.values.color && Object.keys(c.values).length === 1 ? "color" : c.values.size && Object.keys(c.values).length === 1 ? "size" : conv.step || "refine";
        case "knownSize": return conv.sizing.mode === "help" ? "fitSize" : "knownSize";
        case "height": return "height";
        case "weight": return "weight";
        case "foot": return "footLength";
        case "variant": return c.field === "color" ? "productColor" : "productSize";
        case "email": return c.register ? "registerEmail" : "loginEmail";
        case "name": return "registerName";
        case "field": return "deliveryField";
        default: return conv.step;
    }
}

async function reanswer(text, conv, env) {
    const handler = STEP_HANDLERS[conv.step];
    if (!handler) return null;
    const t = normalizeSpeech(text);
    const result = await handler(t, text, conv, env);
    return result && result.conv.confirm ? result : null;
}

async function reaskAfterNo(conv, c, env) {
    const base = { ...conv, confirm: null };
    switch (c.kind) {
        case "slots":
            if (c.correction) return respond(base, "Okay, I kept your earlier choice. What would you like to change?", "answer", base.lastChoices);
            return askStep(base, base.step || "refine", base.step ? `Okay. ${questionAgain(base)}` : "Okay. What would you like instead? You can tell me the type, colour, size, brand or budget.");
        case "knownSize": return askStep(base, stepFor(c, conv), "Okay. What size is it?");
        case "height": return askStep(base, "height", 'Okay. What is your height? Or say "skip".');
        case "weight": return askStep(base, "weight", 'Okay. What is your weight in kilograms? Or say "skip".');
        case "foot": return askStep(base, "footLength", 'Okay. What is the length of your foot in centimetres? Or say "skip".');
        case "variant": return askStep(base, stepFor(c, conv), `Okay. ${c.field === "color" ? "Which colour would you like?" : "Which size would you like?"}`, base.lastChoices);
        case "product": return askStep(base, "refine", 'Okay, I haven\'t added it. What would you like to change? You can choose another option, or change the colour, size or budget. Say "start over" to begin again.');
        case "email": return askStep(base, c.register ? "registerEmail" : "loginEmail", "Okay. Please say the email address again, slowly.");
        case "name": return askStep(base, "registerName", "Okay. What name would you like on your account?");
        case "field": return askStep(base, "deliveryField", `Okay. ${fieldQuestion(base.deliveryField)}`);
        case "checkout": return respond(endWorkflow(base), "Okay, I won't open checkout. What would you like to do?");
        default: return respond(base, "Okay.");
    }
}

function questionAgain(conv) {
    const prompts = {
        category: "What would you like to shop for?",
        type: "Which type would you like?",
        color: "Which colour would you like?",
        size: "Which size would you like?",
        refine: "What would you like to change?",
    };
    return prompts[conv.step] || "What would you like instead?";
}

async function applyConfirm(conv, c, env) {
    switch (c.kind) {
        case "slots": {
            const slots = { ...conv.slots, ...c.values };
            if (c.values.category && c.values.category !== conv.slots.category && !c.values.type) {
                Object.assign(slots, { type: null, typeWord: null, closest: false });
            }
            if (c.values.color) slots.anyColor = false;
            if (c.values.size) slots.anySize = false;
            let next = { ...conv, slots, step: null, shown: [], listOffset: 0 };
            // A changed preference drops a selection that no longer fits it.
            if (next.productId) {
                const products = await productsFor(env, slots.category);
                const p = products.find((x) => x.id === next.productId);
                if (!p || !filterProducts([p], slots).length) next = { ...next, productId: null, selected: {} };
                else next = { ...next, selected: { ...next.selected, ...(c.values.color ? { color: c.values.color } : {}), ...(c.values.size ? { size: c.values.size } : {}) } };
            }
            if (next.productId) {
                const products = await productsFor(env, slots.category);
                return chooseProduct(next, products.find((x) => x.id === next.productId), env);
            }
            return advanceDiscovery(next, env);
        }
        case "knownSize": {
            const products = await productsFor(env, conv.slots.category);
            const chosen = conv.productId && products.find((p) => p.id === conv.productId);
            const sizes = chosen ? sizesFromProducts([chosen]) : sizesFromProducts(filterProducts(products, { ...conv.slots, size: null }));
            const matched = matchAvailableSize(c.size, sizes);
            const systemNote = c.system && !STORE_SHOE_SIZE_SYSTEM && !conv.notedSizeSystem
                ? "Note: this store lists shoe sizes as plain numbers and doesn't say whether they are UK or US sizes, so I can't convert between sizing systems. Please check the brand's size guide."
                : "";
            const next = { ...conv, notedSizeSystem: conv.notedSizeSystem || Boolean(systemNote) };
            if (!matched) {
                return askStep(next, "size", `${systemNote} Size ${c.size} isn't available for these shoes. The available sizes are ${sentenceList(sizes)}. Which size would you like?`.trim(),
                    sizes.map((x) => ({ label: x, say: `size ${x}` })));
            }
            const sized = { ...next, slots: { ...next.slots, size: matched, sizeSystem: c.system || null, anySize: false } };
            const advanced = chosen ? chooseProduct(sized, chosen, env) : await advanceDiscovery(sized, env);
            return systemNote ? withPrefix(systemNote, advanced) : advanced;
        }
        case "height": return askWeight({ ...conv, sizing: { ...conv.sizing, heightCm: c.cm } });
        case "weight": return askFit({ ...conv, sizing: { ...conv.sizing, weightKg: c.kg } });
        case "foot": return sizeFromFoot({ ...conv, sizing: { ...conv.sizing, footCm: c.cm } }, env);
        case "variant": {
            const products = await productsFor(env, conv.slots.category);
            const product = products.find((p) => p.id === conv.productId);
            return chooseProduct({ ...conv, selected: { ...conv.selected, [c.field]: c.value } }, product, env);
        }
        case "product": return addSelected(conv, env);
        case "email": return c.register ? registerEmailConfirmed(conv, c.email, env) : loginEmailConfirmed(conv, c.email, env);
        case "name": return registerNameConfirmed(conv, c.name, env);
        case "field": return deliveryFieldConfirmed(conv, c.field, c.value, env);
        case "checkout": return openCheckout(conv, env);
        default: return respond(conv, "Okay.");
    }
}

// ---------------------------------------------------------------- sign in and registration

async function startSignIn(conv, env, { includeGuest = true, reason = "" } = {}) {
    if (env.user) return respond(conv, "You're already signed in.");
    const lead = reason === "checkout" ? "To check out you need to sign in." : "You're not signed in yet.";
    const choices = [{ label: "Email and password", say: "email and password" }, { label: "Google", say: "Google" }, { label: "Create an account", say: "create an account" }];
    if (includeGuest) choices.push({ label: "Continue as a guest", say: "continue as a guest", quiet: true });
    const message = includeGuest
        ? `${lead} Would you like to sign in using your email and password, continue with Google, or continue browsing as a guest? You can also create an account.`
        : `${lead} Would you like to sign in using your email and password, continue with Google, or create an account?`;
    return askStep({ ...conv, workflow: "login", allowGuest: includeGuest, confirm: null, legacyPending: null }, "loginMethod", message, choices);
}

async function askEmail(conv, env) {
    env.navigate("/sign");
    const handlers = await env.signIn();
    if (handlers) handlers.setMode("login");
    return askStep({ ...conv, workflow: "login" }, "loginEmail",
        'Please tell me the email address associated with your account. Say it slowly, for example "name at example dot com".');
}

async function loginEmailConfirmed(conv, email, env) {
    const handlers = await env.signIn();
    if (!handlers) return respond(endWorkflow(conv), "The sign-in page isn't open, so I couldn't fill in your email. Say \"sign in\" to try again.");
    handlers.setMode("login");
    handlers.setLoginEmail(email);
    return passwordHandoff(conv, env, "login");
}

/** Passwords are typed, never spoken: speech would go through the browser's speech service. */
async function passwordHandoff(conv, env, kind) {
    const handlers = await env.signIn();
    if (handlers) (kind === "register" ? handlers.focusSignupPassword : handlers.focusLoginPassword)();
    const next = { ...conv, workflow: kind === "register" ? "register" : "login", step: "awaitAuth", confirm: null };
    const message = kind === "register"
        ? "Thank you. For your privacy, passwords are typed, not spoken: speech is processed by your browser's speech service. I've moved to the password field. Type a password of at least 8 characters, type it again in Confirm password, then press Enter to create your account. I'll continue when you're signed in."
        : "Thank you. For your privacy, I don't take passwords by voice: speech is processed by your browser's speech service, and someone nearby could hear it. I've moved to the password field. Type your password and press Enter. You can also use a password manager. I'll continue when you're signed in.";
    return respond(next, message, "keyboard");
}

async function googleHandoff(conv, env) {
    env.navigate("/sign");
    const handlers = await env.signIn();
    if (handlers) handlers.focusGoogle();
    return respond({ ...conv, workflow: "login", step: "awaitAuth", confirm: null },
        'Google sign-in opens a separate Google window, which needs a key press. I\'ve moved to the "Sign in with Google" button. Press Enter to open it. I\'ll continue when you\'re signed in.', "keyboard");
}

async function continueAsGuest(conv, env) {
    const deferred = conv.deferred;
    const next = { ...endWorkflow(conv), guestChosen: true };
    const lead = "Okay, you can keep browsing as a guest. Your cart is saved on this device.";
    if (deferred) return withPrefix(lead, await zoroTurnCore(deferred, next, env));
    return respond(next, `${lead} What would you like to shop for?`);
}

async function startRegister(conv, env) {
    if (env.user) return respond(conv, "You're already signed in.");
    env.navigate("/sign");
    const handlers = await env.signIn();
    if (handlers) handlers.setMode("signup");
    return askStep({ ...conv, workflow: "register", confirm: null }, "registerName", "Let's create your account. What name would you like on your account?");
}

async function registerNameConfirmed(conv, name, env) {
    const handlers = await env.signIn();
    if (handlers) { handlers.setMode("signup"); handlers.setSignupField("newName", name); }
    return askStep(conv, "registerEmail", 'What email address would you like to use? Say it slowly, for example "name at example dot com".');
}

async function registerEmailConfirmed(conv, email, env) {
    const handlers = await env.signIn();
    if (!handlers) return respond(endWorkflow(conv), "The sign-up page isn't open, so I couldn't fill in your email. Say \"create an account\" to try again.");
    handlers.setSignupField("newEmail", email);
    return passwordHandoff(conv, env, "register");
}

/**
 * Sign-in results from the sign-in page. Returns { conv, reply } to speak, or null when Zoro was
 * not helping with sign-in.
 */
export function zoroAuthEvent(conv, event, env) {
    if (!(conv.workflow === "login" || conv.workflow === "register") || conv.step !== "awaitAuth") return null;
    if (event.ok) {
        env.navigate("/");
        return respond({ ...endWorkflow(conv), guestChosen: false }, `You're signed in successfully. ${WELCOME_AFTER_SIGN_IN}`);
    }
    const message = `That didn't work: ${event.message || "Sign-in failed."} Would you like to type your password again, change the email address, use Google, or continue as a guest?`;
    return askStep({ ...conv, allowGuest: true }, "loginRetry", message, [
        { label: "Type password again", say: "type my password again" }, { label: "Change email", say: "change email" },
        { label: "Google", say: "Google" }, { label: "Continue as a guest", say: "continue as a guest", quiet: true },
    ]);
}

// ---------------------------------------------------------------- checkout

async function startCheckout(conv, env) {
    if (!env.user) return startSignIn({ ...conv, deferred: "check out" }, env, { includeGuest: false, reason: "checkout" });
    let quote;
    try {
        quote = await env.quote();
    } catch (e) {
        return respond(conv, "Sorry, I couldn't get your order total from the server right now. Your cart is saved. Please try again in a moment.");
    }
    if (!quote || !quote.items || !quote.items.length) return respond({ ...endWorkflow(conv) }, "Your cart is empty.");
    const lines = quote.items.map((l) => {
        const opts = [l.color, l.size && (/gb$/i.test(String(l.size)) ? l.size : `size ${l.size}`)].filter(Boolean).join(", ");
        return `${l.quantity} ${l.name}${opts ? `, ${opts}` : ""}`;
    });
    const problems = quote.problems && quote.problems.length ? ` Note: ${quote.problems.join(" ")}` : "";
    const message = `Your cart has ${sentenceList(lines)}. The subtotal is ${price(quote.subtotal)}, tax is ${price(quote.tax)}, and the total is ${price(quote.total)}, as calculated by the server.${problems} Would you like to continue to checkout?`;
    return askConfirm({ ...conv, workflow: "checkout", step: null }, { kind: "checkout" }, message);
}

async function openCheckout(conv, env) {
    env.navigate("/billing");
    const billing = await env.billing();
    if (!billing) return respond(endWorkflow(conv), "I've opened the checkout page. Say \"place my order\" when your delivery details are filled in.");
    return nextDeliveryStep({ ...conv, workflow: "checkout" }, billing, env);
}

function fieldError(rule, value) {
    const raw = String(value || "").trim();
    const compact = raw.replace(/\s+/g, "");
    const bad = (rule.min !== undefined && raw.length < rule.min) || (rule.max !== undefined && raw.length > rule.max) || (rule.pattern && !rule.pattern.test(compact));
    return bad ? rule.message : null;
}

const FIELD_QUESTIONS = {
    customerMobile: "What is your 10-digit mobile number? Say the digits one by one.",
    customerAddress: "What is your delivery address? Say the house number, street and area.",
    customerCity: "Which city should we deliver to?",
    customerState: "Which state is that in?",
    customerPincode: "What is the 6-digit pincode?",
};
const fieldQuestion = (field) => FIELD_QUESTIONS[field] || "Please tell me the next detail.";

async function nextDeliveryStep(conv, billing, env, prefix = "") {
    const shipping = billing.getShipping();
    const missing = SHIPPING_FIELDS.find((rule) => fieldError(rule, shipping[rule.field]));
    if (missing) {
        const intro = prefix || (SHIPPING_FIELDS.every((r) => !String(shipping[r.field] || "").trim()) ? "I need your delivery details." : "");
        return askStep({ ...conv, deliveryField: missing.field }, "deliveryField", `${intro} ${fieldQuestion(missing.field)}`.trim());
    }
    return finalOrderQuestion(conv, billing, prefix);
}

async function deliveryFieldConfirmed(conv, field, value, env) {
    const billing = await env.billing();
    if (!billing) return respond(endWorkflow(conv), "The checkout page is no longer open, so I couldn't fill that in. Say \"check out\" to continue.");
    billing.setShippingField(field, value);
    // The page re-renders before the next read.
    await new Promise((r) => setTimeout(r, 0));
    return nextDeliveryStep(conv, billing, env, "Thank you.");
}

function finalOrderQuestion(conv, billing, prefix = "") {
    const summary = billing.getSummary();
    if (!summary.ready) {
        return respond(endWorkflow(conv), `${prefix} Your delivery details are complete, but the order can't be placed yet. ${summary.problems.join(" ")} Nothing has been charged.`.trim());
    }
    const pending = { kind: "confirmOrder" };
    const message = `${prefix} Your delivery details are complete. The final total is ${price(summary.total)} for ${plural(summary.itemCount, "item")}, paid from your VoiceCart wallet. Say "yes, place order" to place the order, or "no" to stop. Nothing has been charged yet.`.trim();
    return respond({ ...endWorkflow(conv), legacyPending: pending }, message, "answer", legacyChoices(pending));
}

async function placeOrder(conv, env) {
    if (!env.user) return startSignIn({ ...conv, deferred: "place my order" }, env, { includeGuest: false, reason: "checkout" });
    const billing = await env.billing({ wait: false });
    if (!billing) return startCheckout(conv, env);
    return nextDeliveryStep({ ...conv, workflow: "checkout" }, billing, env);
}
