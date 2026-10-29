// Groq-backed intent recognition for the Zoro assistant. The model only classifies speech into
// a fixed set of intents and extracts shopping details (entities); the browser then resolves
// them against the real catalog and runs deterministic code. Model output is never executed,
// queried or trusted for products, prices, stock, sign-in or payments.

const { HttpError } = require('./http');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_TEXT_LENGTH = 300;
const MAX_PRODUCTS = 150;
const MAX_NAME_LENGTH = 150;

const INTENTS = [
  'NAVIGATE', 'SEARCH', 'ADD_TO_CART', 'ONE_SHOT_PURCHASE', 'SET_QUANTITY', 'DESCRIBE_PRODUCT',
  'CART_TOTAL', 'CHECKOUT', 'PLACE_ORDER', 'GO_BACK', 'STOP_LISTENING',
  'TOGGLE_CONTRAST', 'TOGGLE_SCREEN_READER', 'FIND_PRODUCT', 'SIGN_IN', 'REGISTER', 'HELP', 'UNKNOWN',
];

const CATEGORIES = ['Shoes', 'Electronics', 'Clothes', 'Food'];
const SIZE_SYSTEMS = ['UK', 'US', 'EU', 'INDIA'];

const PAGES = [
  '/', '/categories/Shoes', '/categories/Electronics', '/categories/Food', '/categories/Clothes',
  '/cart', '/wishlist', '/account', '/billing',
];

// Spoken synonyms for the prompt only (NAVIGATE's target is still validated against PAGES exactly
// in normalizeAction below); helps the model match phrasing like "add to cart page" or "wish list".
const PAGE_HINTS = {
  '/cart': 'shopping cart, add to cart page',
  '/wishlist': 'wish list',
  '/account': 'profile',
  '/billing': 'checkout',
};
const pagesForPrompt = () => PAGES.map((p) => (PAGE_HINTS[p] ? `${p} (${PAGE_HINTS[p]})` : p)).join(', ');

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Validates the request body; returns { text, products } or throws a 400. */
function parseVoiceRequest(body) {
  const text = cleanString(body && body.text, MAX_TEXT_LENGTH + 1);
  if (!text) throw new HttpError(400, 'invalid_input', 'No command text was received.');
  if (text.length > MAX_TEXT_LENGTH) throw new HttpError(400, 'invalid_input', 'The command is too long.');

  const rawProducts = Array.isArray(body.products) ? body.products.slice(0, MAX_PRODUCTS) : [];
  const products = rawProducts
    .map((p) => ({
      name: cleanString(p && p.name, MAX_NAME_LENGTH),
      category: cleanString(p && p.category, 40),
      brand: cleanString(p && p.brand, 40),
    }))
    .filter((p) => p.name);
  return { text, products };
}

function buildSystemPrompt(products) {
  const lines = products.map((p) => `- "${p.name}" | category: ${p.category || '-'} | brand: ${p.brand || '-'}`).join('\n');
  return `
You classify voice commands for an accessible e-commerce site used by blind people.
You never decide prices, totals or payments. You only pick an intent.
The text is a speech-recognition transcript, often of Indian English: words may be misheard, and
numbers may be written as words ("size nine", "two thousand rupees"). Do not guess a meaning that
was not said: when the request is unclear, use UNKNOWN or set needsClarification.
"speechResponse" is read aloud: one short spoken-style sentence, no markdown, no emojis, no prices.

PRODUCT NAMES (the only products that exist):
${lines || '- (catalog unavailable)'}

PAGES: ${pagesForPrompt()}

INTENTS:
- NAVIGATE: open a page or category. target = one of PAGES exactly.
- SEARCH: find products by brand/type/words. target = short search text found in product names.
- ADD_TO_CART: "add X to cart". target = product name as spoken or the closest catalog name.
- ONE_SHOT_PURCHASE: "buy/order/purchase X". target = product name. (The app adds it to the cart and opens checkout; it never pays.)
- SET_QUANTITY: "increase/decrease/set quantity of X to N". target = product name or null for "this product", quantity = the final number N.
- DESCRIBE_PRODUCT: "tell me about X / this product". target = product name or null for "this product".
- CART_TOTAL: "what is in my cart", "cart total".
- CHECKOUT: "proceed to checkout", "go to billing".
- PLACE_ORDER: "place my order", "pay now", "confirm payment".
- GO_BACK: "go back", "previous page".
- STOP_LISTENING: "stop listening", "go to sleep", "cancel listening".
- TOGGLE_CONTRAST: high contrast / dark mode / colours.
- TOGGLE_SCREEN_READER: screen reader on/off, stop/start reading.
- FIND_PRODUCT: a general shopping request that is not one exact product name, e.g. "I'm looking for shoes",
  "I need black gym shoes in size 9", "something comfortable for my daily walks", "phones under 20000".
- SIGN_IN: "sign me in", "log in". REGISTER: "create an account", "sign up". HELP: "what can you do", "help".
- UNKNOWN: anything else.

ENTITIES (only what the user actually said; null otherwise; never invent values):
- productQuery: the product words as said, category: one of ${CATEGORIES.join(', ')} or null,
- productType: the kind of product in the user's words (e.g. "gym", "running", "walking", "casual", "phone", "hoodie"),
- brand, color: as said, size: the number or value as said (e.g. "9", "9.5", "128 GB"), sizeSystem: UK, US, EU, INDIA or null,
- budgetMax: a maximum price in rupees as a number, quantity: a whole number,
- confirmation: "yes" or "no" if the utterance is mainly an answer, correction: true if the user changes an earlier choice,
- needsClarification: true if the request is too vague to act on.

Respond ONLY with JSON: {"intent": string, "target": string | null, "quantity": number | null, "speechResponse": string,
 "entities": {"productQuery", "category", "productType", "brand", "color", "size", "sizeSystem", "budgetMax", "quantity", "confirmation", "correction", "needsClarification"}}
`;
}

/** Entities are hints only: short strings, known categories and systems, bounded numbers. */
function normalizeEntities(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of ['productQuery', 'productType', 'brand', 'color', 'size']) {
    const value = cleanString(e[key], 40);
    if (value) out[key] = value;
  }
  const category = CATEGORIES.find((c) => c.toLowerCase() === String(e.category || '').toLowerCase());
  if (category) out.category = category;
  const system = SIZE_SYSTEMS.find((x) => x === String(e.sizeSystem || '').toUpperCase());
  if (system) out.sizeSystem = system;
  const budget = Number(e.budgetMax);
  if (Number.isFinite(budget) && budget > 0 && budget <= 10000000) out.budgetMax = Math.round(budget);
  const quantity = Number(e.quantity);
  if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 20) out.quantity = quantity;
  if (e.confirmation === 'yes' || e.confirmation === 'no') out.confirmation = e.confirmation;
  if (e.correction === true) out.correction = true;
  if (e.needsClarification === true) out.needsClarification = true;
  return out;
}

/** Keeps only well-formed actions; anything else becomes null so the caller can fall back. */
function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = String(raw.intent || '').toUpperCase();
  if (!INTENTS.includes(intent)) return null;

  let target = cleanString(raw.target, MAX_NAME_LENGTH);
  if (intent === 'NAVIGATE') {
    target = PAGES.find((p) => p.toLowerCase() === String(target || '').toLowerCase()) || null;
    if (!target) return null;
  }
  if (['SEARCH', 'ADD_TO_CART', 'ONE_SHOT_PURCHASE'].includes(intent) && !target) return null;

  let quantity = null;
  if (intent === 'SET_QUANTITY') {
    quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) return null;
  }

  return {
    intent,
    target,
    quantity,
    speechResponse: cleanString(raw.speechResponse, 300) || '',
    entities: normalizeEntities(raw.entities),
  };
}

/** Calls Groq. Returns a normalized action, or throws HttpError(502/503/504). */
async function classifyWithGroq({ text, products }, { apiKey, model, reasoningEffort, fetchImpl = fetch }) {
  if (!apiKey) throw new HttpError(503, 'ai_not_configured', 'The AI assistant is not configured on the server.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(GROQ_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(products) },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1024,
        // gpt-oss models think before answering; "low" saves tokens (rate limits are per token).
        ...(reasoningEffort && /^openai\/gpt-oss/.test(model) ? { reasoning_effort: reasoningEffort } : {}),
      }),
    });
  } catch (e) {
    throw new HttpError(e.name === 'AbortError' ? 504 : 502, 'ai_unavailable', 'The AI service did not respond.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Log the status only; provider bodies can echo request details.
    console.error(`Groq API error: HTTP ${response.status}`);
    if (response.status === 429) throw new HttpError(503, 'ai_rate_limited', 'The AI service is busy. Please try again shortly.');
    throw new HttpError(502, 'ai_unavailable', 'The AI service returned an error.');
  }

  let action = null;
  try {
    const data = await response.json();
    action = normalizeAction(JSON.parse(data.choices[0].message.content));
  } catch (e) {
    action = null;
  }
  if (!action) throw new HttpError(502, 'ai_invalid_output', 'The AI service returned an unusable answer.');
  return action;
}

module.exports = { parseVoiceRequest, classifyWithGroq, normalizeAction, normalizeEntities, buildSystemPrompt, INTENTS, PAGES, MAX_TEXT_LENGTH };
