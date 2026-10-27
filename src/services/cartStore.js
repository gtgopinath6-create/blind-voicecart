// One cart API for signed-in users (Firestore profile) and guests (localStorage),
// shared by the product pages, the cart page, the wishlist and the voice assistant.
import { readData, updateCart, setCartBeforeBilling, setWishlist, sameCartLine, toCartLine } from "../components/firebaseservices";

const GUEST_CART_KEY = "guest_cart";
const GUEST_WISHLIST_KEY = "guest_wishlist";

function readLocal(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(value) ? value : [];
    } catch (e) {
        return [];
    }
}

function writeLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn("Could not save to local storage:", e);
    }
}

function notifyCartChanged(detail) {
    window.dispatchEvent(new CustomEvent("CART_UPDATED", { detail }));
}

export const readGuestCart = () => readLocal(GUEST_CART_KEY);
export const writeGuestCart = (cart) => writeLocal(GUEST_CART_KEY, cart);
export const readGuestWishlist = () => readLocal(GUEST_WISHLIST_KEY);
export const writeGuestWishlist = (list) => writeLocal(GUEST_WISHLIST_KEY, list);

export async function getCart(user) {
    if (!user) return readGuestCart();
    const profile = await readData("users", "", user);
    return (profile && Array.isArray(profile.cart)) ? profile.cart : [];
}

export async function saveCart(user, cart) {
    if (user) await setCartBeforeBilling(cart, user);
    else writeGuestCart(cart);
    notifyCartChanged({});
}

/** Adds `quantity` of a product, merging with an existing line of the same product and size. */
export async function addToCart(product, user, quantity = 1) {
    if (user) {
        await updateCart(product, user, quantity);
    } else {
        const cart = readGuestCart();
        const line = toCartLine(product, quantity);
        const existing = cart.find((item) => sameCartLine(item, line));
        if (existing) existing.quantity = (Number(existing.quantity) || 0) + quantity;
        else cart.push(line);
        writeGuestCart(cart);
    }
    notifyCartChanged({ productName: product.name });
}

/** Sets the quantity of one cart line; 0 removes it. Returns the updated cart. */
export async function setLineQuantity(user, line, quantity) {
    const cart = (await getCart(user)).map((x) => ({ ...x }));
    const next = quantity <= 0
        ? cart.filter((item) => !sameCartLine(item, line))
        : cart.map((item) => (sameCartLine(item, line) ? { ...item, quantity } : item));
    await saveCart(user, next);
    return next;
}

/**
 * Moves the guest cart into the signed-in user's cart after login, merging lines of the same
 * product instead of duplicating them. The guest cart is cleared only after the save succeeds.
 */
export async function mergeGuestCartInto(user) {
    const guest = readGuestCart();
    if (!user || guest.length === 0) return false;
    const cart = (await getCart(user)).map((x) => ({ ...x }));
    for (const line of guest) {
        const quantity = Math.max(1, Math.min(20, Number(line.quantity) || 1));
        const existing = cart.find((item) => sameCartLine(item, line));
        if (existing) existing.quantity = Math.min(20, (Number(existing.quantity) || 0) + quantity);
        else cart.push({ ...line, quantity });
    }
    await setCartBeforeBilling(cart, user);
    writeGuestCart([]);
    notifyCartChanged({});
    return true;
}

/** Local estimate only (prices stored in the cart). The billing page shows the server's figure. */
export function estimateTotal(cart) {
    return cart.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
}

export async function getWishlist(user) {
    if (!user) return readGuestWishlist();
    const profile = await readData("users", "", user);
    return (profile && Array.isArray(profile.wishlist)) ? profile.wishlist : [];
}

export async function saveWishlist(user, list) {
    if (user) await setWishlist(list, user);
    else writeGuestWishlist(list);
    window.dispatchEvent(new CustomEvent("WISHLIST_UPDATED"));
}

/** Adds a product to the wishlist once. Returns false if it was already there. */
export async function addToWishlist(product, user) {
    const list = await getWishlist(user);
    if (list.some((item) => sameCartLine(item, product))) return false;
    const entry = { ...toCartLine(product), description: product.description || "", rating: product.rating ?? null };
    await saveWishlist(user, [...list, entry]);
    return true;
}
