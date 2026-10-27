// Small shared state the voice assistant reads:
//  - the product the user is on ("tell me about this product"), set when a product card gets focus;
//  - the billing page's checkout controls, registered while that page is open, so
//    "place my order" goes through the exact same validated checkout as the Pay button;
//  - the sign-in page's form controls, so Zoro can fill in an email address and move focus to the
//    password field (passwords are always typed, never spoken).

let currentProduct = null;
let billing = null;
let signIn = null;

/** Sign-in results ({ ok, message }) from the sign-in page, for Zoro to continue the conversation. */
export const AUTH_RESULT_EVENT = "VOICECART_AUTH_RESULT";

export function reportAuthResult(ok, message = "") {
    window.dispatchEvent(new CustomEvent(AUTH_RESULT_EVENT, { detail: { ok, message } }));
}

export function setCurrentProduct(product) {
    currentProduct = product || null;
}

export function getCurrentProduct() {
    return currentProduct;
}

/**
 * handlers: { getSummary(): { ready, problems, total, itemCount }, placeOrder(): Promise<{ ok, message }>,
 *             getShipping(): {...}, setShippingField(field, value) }
 */
export function registerBilling(handlers) {
    billing = handlers;
    return () => {
        if (billing === handlers) billing = null;
    };
}

export function getBilling() {
    return billing;
}

/**
 * handlers: { setMode("login" | "signup"), setLoginEmail(email), focusLoginPassword(), focusGoogle(),
 *             setSignupField(name, value), focusSignupPassword() }
 */
export function registerSignIn(handlers) {
    signIn = handlers;
    return () => {
        if (signIn === handlers) signIn = null;
    };
}

export function getSignIn() {
    return signIn;
}

/** Waits (briefly) for a page to register its handlers after navigation. */
export function waitForHandlers(get, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
            const found = get();
            if (found || Date.now() - started >= timeoutMs) resolve(found || null);
            else setTimeout(check, 50);
        };
        check();
    });
}
