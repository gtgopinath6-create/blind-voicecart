/**
 * Executes voice commands with deterministic app code.
 *
 * runVoiceCommand() returns an outcome the assistant speaks:
 *   { type: "done", message }
 *   { type: "ask", message, pending }   -> the next utterance goes to resolvePending()
 *   { type: "stop", message }           -> the assistant stops listening
 * A pending step is either a choice between products/sizes or a yes/no confirmation.
 * Nothing that spends money happens without an explicit "yes" from the user, and an
 * unknown or unclear product is never replaced by a different one.
 */
import { loadCatalog, invalidateCatalog } from "./catalogService";
import { interpretCommand } from "./groqVoiceService";
import { resolveProduct, pickFromList, normalizeText, searchProducts, variantOptions } from "./productMatching";
import { addToCart, getCart, setLineQuantity, estimateTotal } from "./cartStore";
import { getCurrentProduct, setCurrentProduct, getBilling } from "./voiceContext";
import { apiRequest } from "./apiClient";
import { classifyAnswer } from "./speechParsers";
import { categoryFromExactWords, extractEntities } from "./shoppingCatalog";

// Adding something at or above this price is read back for confirmation first.
export const CONFIRM_PRICE_THRESHOLD = 10000;

export const clearProductCache = invalidateCatalog;

/** Every real product, from the shared catalog cache (see catalogService). Throws if it cannot be loaded. */
export function loadProducts() {
    return loadCatalog();
}

const rupees = (n) => `₹${Math.round(Number(n) * 100) / 100}`;

function describeOption(p, i) {
    return `${i + 1}: ${p.name}, ${rupees(p.price)}`;
}

const VARIANT_NAMES = { size: "size", color: "colour" };

/** The next option (size, colour) the user still has to choose, or null. */
function nextVariant(product) {
    const options = variantOptions(product);
    const chosen = product.selected || {};
    const field = Object.keys(options).find((f) => !chosen[f]);
    return field ? { field, options: options[field] } : null;
}

function describeChoice(product) {
    const chosen = product.selected || {};
    return Object.keys(chosen).map((f) => `${VARIANT_NAMES[f]} ${chosen[f]}`).join(", ");
}

/** "yes" | "no" | "unclear". Natural variations are understood; anything unclear is never a yes. */
export function classifyConfirmation(text) {
    return classifyAnswer(text).answer;
}

const UNCLEAR = "Sorry, I didn't understand. Please say yes or no.";

function done(message) {
    return { type: "done", message };
}

function ask(message, pending, { unclear = false } = {}) {
    return unclear ? { type: "ask", message, pending, unclear } : { type: "ask", message, pending };
}

/** Step after the product is known: choose size/colour if needed, confirm if costly or fuzzy, then add. */
function planAdd(product, { quantity = 1, checkout = false, needsConfirm = false }) {
    const variant = nextVariant(product);
    if (variant) {
        return ask(`${product.name} comes in ${VARIANT_NAMES[variant.field]} ${variant.options.join(", ")}. Which ${VARIANT_NAMES[variant.field]} would you like?`, {
            kind: "chooseVariant", product, field: variant.field, options: variant.options, quantity, checkout, needsConfirm,
        });
    }
    if (needsConfirm || Number(product.price) * quantity >= CONFIRM_PRICE_THRESHOLD) {
        const option = describeChoice(product) ? `, ${describeChoice(product)}` : "";
        return ask(
            `Add ${quantity} ${product.name}${option}, at ${rupees(product.price)} each, to your cart? Say yes or no.`,
            { kind: "confirmAdd", product, quantity, checkout }
        );
    }
    return { type: "run", run: (ctx) => addAndReport(product, quantity, checkout, ctx) };
}

async function addAndReport(product, quantity, checkout, ctx) {
    const item = { ...product, ...(product.selected || {}) };
    try {
        await addToCart(item, ctx.user, quantity);
    } catch (e) {
        console.error("Voice add to cart failed:", e);
        return done(`Sorry, I could not add ${product.name} to your cart. Nothing was added. Please try again.`);
    }
    setCurrentProduct(product);
    const option = describeChoice(product) ? `, ${describeChoice(product)},` : "";
    if (checkout) {
        ctx.navigate("/billing");
        return done(
            `Added ${quantity} ${product.name}${option} at ${rupees(product.price)} each to your cart. ` +
            `I have opened the billing page. Fill in your delivery details, then say "place my order". Nothing has been paid yet.`
        );
    }
    ctx.navigate("/cart");
    return done(`Added ${quantity} ${product.name}${option} at ${rupees(product.price)} each to your cart. I have opened your cart.`);
}

async function finish(outcome, ctx) {
    return outcome.type === "run" ? outcome.run(ctx) : outcome;
}

async function handleAdd(action, ctx, products) {
    const checkout = action.intent === "ONE_SHOT_PURCHASE";
    const match = resolveProduct(action.target, products);
    if (match.status === "none") {
        return done(`Sorry, I could not find a product called ${action.target}. Nothing was added. Please say the name again, or say "search" followed by a brand.`);
    }
    if (match.status === "ambiguous") {
        const options = match.matches;
        const intro = match.partial
            ? `I could not find ${action.target} exactly. Similar products are`
            : `I found ${options.length} products`;
        return ask(
            `${intro}: ${options.map(describeOption).join("; ")}. Which one do you mean? Say the number, or cancel. Nothing has been added yet.`,
            { kind: "chooseProduct", options, checkout }
        );
    }
    const exact = normalizeText(match.product.name) === normalizeText(action.target);
    return finish(planAdd(match.product, { checkout, needsConfirm: !exact }), ctx);
}

async function findCartLine(action, ctx) {
    const cart = await getCart(ctx.user);
    if (cart.length === 0) return { cart, error: "Your cart is empty." };
    if (!action.target) {
        // "this product": the product the user is on, if it is in the cart; otherwise the only cart item.
        const current = getCurrentProduct();
        const line = current && cart.find((l) => (l.id && current.id ? l.id === current.id : l.name === current.name));
        if (line) return { cart, line };
        if (cart.length === 1) return { cart, line: cart[0] };
        return { cart, error: `Which product? Your cart has ${cart.map((l) => l.name).join(", ")}.` };
    }
    const name = action.target;
    const match = resolveProduct(name, cart);
    if (match.status === "one") return { cart, line: match.product };
    if (match.status === "ambiguous") return { cart, error: `More than one cart item matches ${name}: ${match.matches.map((l) => l.name).join(", ")}. Please say the full name.` };
    return { cart, error: `${name} is not in your cart.` };
}

async function cartSummary(ctx) {
    if (ctx.user) {
        try {
            const quote = await apiRequest("/api/checkout/quote", { body: {} });
            if (!quote.items.length) return "Your cart is empty.";
            const lines = quote.items.map((l) => `${l.quantity} ${l.name}`).join(", ");
            const problems = quote.problems.length ? ` Note: ${quote.problems.join(" ")}` : "";
            return `Your cart has ${lines}. Subtotal ${rupees(quote.subtotal)}, tax ${rupees(quote.tax)}, total ${rupees(quote.total)}. Your wallet balance is ${rupees(quote.walletBalance)}.${problems}`;
        } catch (e) {
            console.warn("Server cart quote unavailable:", e.message);
        }
    }
    const cart = await getCart(ctx.user);
    if (!cart.length) return "Your cart is empty.";
    const subtotal = estimateTotal(cart);
    return `Your cart has ${cart.map((l) => `${l.quantity} ${l.name}`).join(", ")}. Estimated total before tax is ${rupees(subtotal)}. The final amount is confirmed on the billing page.`;
}

function describeProduct(product) {
    const description = (product.description || "").slice(0, 300);
    const rating = product.rating !== undefined && product.rating !== null ? ` Rated ${product.rating} out of 5.` : "";
    const options = variantOptions(product);
    const sizes = Object.keys(options).map((f) => ` ${VARIANT_NAMES[f][0].toUpperCase()}${VARIANT_NAMES[f].slice(1)}s: ${options[f].join(", ")}.`).join("");
    return `${product.name}, ${rupees(product.price)}.${rating}${sizes} ${description}`.trim();
}

/** Runs a new command (not an answer to a pending question). */
export async function runVoiceCommand(text, ctx) {
    let products = [];
    try {
        products = await loadProducts();
    } catch (e) {
        console.warn("Could not load the product catalog:", e);
    }
    const action = await interpretCommand(text, products, { signal: ctx.signal });
    return executeAction(action, ctx, products);
}

/** Runs an already interpreted, validated action against the real catalog. */
export async function executeAction(action, ctx, products = []) {
    if (!action) return done("Sorry, I could not understand that command.");

    const needsCatalog = ["ADD_TO_CART", "ONE_SHOT_PURCHASE", "DESCRIBE_PRODUCT", "SEARCH"].includes(action.intent);
    if (needsCatalog && products.length === 0) {
        return done("Sorry, the product catalog could not be loaded right now. Please try again in a moment.");
    }

    switch (action.intent) {
        case "NAVIGATE": {
            ctx.navigate(action.target);
            // A fresh category visit starts with no carried-over brand/colour/size filter; any
            // other page has no category filter to apply at all.
            const navCategory = action.target.startsWith("/categories/") ? action.target.slice("/categories/".length) : null;
            ctx.setVoiceFilter(navCategory ? { category: navCategory } : null);
            return done(action.target === "/" ? "Opening the home page." : `Opening ${action.target.split("/").pop()}.`);
        }

        case "SEARCH": {
            // A bare category word ("shoes", "footwear") opens the real category page, like NAVIGATE.
            const category = categoryFromExactWords(action.target);
            if (category) {
                ctx.navigate(`/categories/${category}`);
                ctx.setVoiceFilter({ category });
                return done(`Opening ${category}.`);
            }
            // A query naming a category plus brand/type/colour/etc ("nike shoes") opens that
            // category page filtered accordingly, instead of a generic cross-catalog text search.
            const entities = extractEntities(action.target, products);
            if (entities.category) {
                ctx.navigate(`/categories/${entities.category}`);
                ctx.setVoiceFilter({
                    category: entities.category, type: entities.type, brand: entities.brand,
                    color: entities.color, size: entities.size, budgetMax: entities.budgetMax, budgetMin: entities.budgetMin,
                });
                const brandLabel = entities.brand ? `${entities.brand[0].toUpperCase()}${entities.brand.slice(1)}` : "";
                return done(`Opening ${entities.category}${brandLabel ? `, filtered to ${brandLabel}` : ""}.`);
            }
            ctx.setVoiceFilter(null);
            ctx.setSearch(action.target);
            ctx.navigate("/categories/Search");
            const found = searchProducts(action.target, products);
            if (!found.length) return done(`No products found for ${action.target}.`);
            const names = found.slice(0, 3).map((p) => p.name).join(", ");
            return done(`Found ${found.length} result${found.length === 1 ? "" : "s"} for ${action.target}: ${names}${found.length > 3 ? ", and more" : ""}.`);
        }

        case "ADD_TO_CART":
        case "ONE_SHOT_PURCHASE":
            return handleAdd(action, ctx, products);

        case "DESCRIBE_PRODUCT": {
            if (!action.target) {
                const current = getCurrentProduct();
                return done(current ? describeProduct(current) : "Which product? Move to a product first, or say its name.");
            }
            const match = resolveProduct(action.target, products);
            if (match.status === "one") {
                setCurrentProduct(match.product);
                return done(describeProduct(match.product));
            }
            if (match.status === "ambiguous") return done(`Several products match: ${match.matches.map((p) => p.name).join(", ")}. Please say the full name.`);
            return done(`Sorry, I could not find ${action.target}.`);
        }

        case "SET_QUANTITY": {
            const { line, error } = await findCartLine(action, ctx);
            if (error) return done(error);
            if (action.quantity === 0) {
                return ask(`Remove ${line.name} from your cart? Say yes or no.`, { kind: "confirmQuantity", line, quantity: 0 });
            }
            await setLineQuantity(ctx.user, line, action.quantity);
            return done(`${line.name} quantity is now ${action.quantity}, ${rupees(Number(line.price) * action.quantity)} before tax.`);
        }

        case "CART_TOTAL":
            return done(await cartSummary(ctx));

        case "CHECKOUT":
            ctx.navigate("/billing");
            return done("Opening the billing page. Check your delivery details, then say \"place my order\" when you are ready.");

        case "PLACE_ORDER": {
            const billing = getBilling();
            if (!billing) {
                ctx.navigate("/billing");
                return done("I opened the billing page. Please check your delivery details first, then say \"place my order\" again.");
            }
            const summary = billing.getSummary();
            if (!summary.ready) return done(`The order cannot be placed yet. ${summary.problems.join(" ")}`);
            return ask(
                `You are about to pay ${rupees(summary.total)} from your wallet for ${summary.itemCount} item${summary.itemCount === 1 ? "" : "s"}. ` +
                `Say "yes, place order" to confirm, or "cancel".`,
                { kind: "confirmOrder" }
            );
        }

        case "GO_BACK":
            ctx.goBack();
            return done("Going back.");

        case "STOP_LISTENING":
            return { type: "stop", message: "Okay, I stopped listening." };

        case "TOGGLE_CONTRAST":
            ctx.toggleContrast();
            return done("Theme changed.");

        case "TOGGLE_SCREEN_READER":
            ctx.toggleScreenReader();
            return done("Screen reader toggled.");

        default:
            return done('Sorry, I did not understand. You can say things like "open shoes", "search Nike", "add Nike Air Force 1 to my cart", "what is my cart total", or "stop listening".');
    }
}

/** Handles the answer to a pending question. */
export async function resolvePending(pending, text, ctx) {
    if (pending.kind === "chooseProduct") {
        if (classifyConfirmation(text) === "no") return done("Okay, cancelled. Nothing was added.");
        const product = pickFromList(text, pending.options);
        if (!product) return ask("Sorry, I didn't catch which one. Please say the number or the full product name, or say cancel. Nothing has been added.", pending, { unclear: true });
        // The user picked from a read-out list, so the name is confirmed; price checks still apply.
        return finish(planAdd(product, { checkout: pending.checkout }), ctx);
    }

    if (pending.kind === "chooseVariant") {
        if (classifyConfirmation(text) === "no") return done("Okay, cancelled. Nothing was added.");
        const said = ` ${normalizeText(text)} `;
        // Whole-word match, so "size 1" never matches "10" and "red" never matches "redwood".
        const value = pending.options.find((o) => said.includes(` ${normalizeText(o)} `));
        if (!value) return ask(`Sorry, that is not one of the options. Please choose ${pending.options.join(", ")}, or say cancel. Nothing has been added.`, pending, { unclear: true });
        const product = { ...pending.product, selected: { ...(pending.product.selected || {}), [pending.field]: value } };
        return finish(planAdd(product, { quantity: pending.quantity, checkout: pending.checkout, needsConfirm: pending.needsConfirm }), ctx);
    }

    const answer = classifyConfirmation(text);
    if (answer === "no") return done("Okay, cancelled. Nothing was changed.");
    // Unclear is never taken as yes: ask again, and keep waiting for a clear answer.
    if (answer !== "yes") return ask(pending.kind === "confirmOrder" ? `${UNCLEAR} Say "yes, place order" to place the order, or "no".` : UNCLEAR, pending, { unclear: true });

    if (pending.kind === "confirmAdd") return addAndReport(pending.product, pending.quantity, pending.checkout, ctx);

    if (pending.kind === "confirmQuantity") {
        await setLineQuantity(ctx.user, pending.line, pending.quantity);
        return done(`Removed ${pending.line.name} from your cart.`);
    }

    if (pending.kind === "confirmOrder") {
        const billing = getBilling();
        if (!billing) return done("The billing page is no longer open, so the order was not placed.");
        const result = await billing.placeOrder();
        return done(result.message);
    }

    return done("Okay.");
}
