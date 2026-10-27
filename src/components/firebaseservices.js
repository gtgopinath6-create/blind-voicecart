import { collection, getDocs, doc, getDoc, query, where, updateDoc, setDoc, deleteDoc, addDoc } from "firebase/firestore";
import { database } from "./firebase";

// Profiles live in the "users" collection. New ones use the Auth uid as document id;
// older ones have a random id and a `uid` field, so lookups check both.
// Wallet, purchase history and orders are written only by the server (see firestore.rules).

const withId = (snap) => ({ id: snap.id, ...snap.data() });

/** Returns { ref, data } for the signed-in user's profile, or null if none exists. */
export async function getUserProfileDoc(user) {
    if (!user || !user.uid) return null;
    const direct = await getDoc(doc(database, "users", user.uid));
    if (direct.exists()) return { ref: direct.ref, data: direct.data() };
    const legacy = await getDocs(query(collection(database, "users"), where("uid", "==", user.uid)));
    if (!legacy.empty) return { ref: legacy.docs[0].ref, data: legacy.docs[0].data() };
    return null;
}

/**
 * Creates the profile for a newly signed-in user (email/password or Google) if it is missing.
 * Existing profiles are never overwritten. Returns the profile data.
 */
export async function ensureUserProfile(user, name) {
    const existing = await getUserProfileDoc(user);
    if (existing) return existing.data;
    const profile = {
        uid: user.uid,
        email: user.email || "",
        name: (name || user.displayName || (user.email || "").split("@")[0] || "Customer").slice(0, 80),
        cart: [],
        wishlist: [],
        // Starts at zero: balances change only through the server after verified payment.
        wallet: 0,
        purchaseHistory: [],
    };
    await setDoc(doc(database, "users", user.uid), profile);
    return profile;
}

/** Updates the display name stored in the profile (allowed by the rules). */
export async function setProfileName(user, name) {
    const found = await getUserProfileDoc(user);
    if (found && name && found.data.name !== name) await updateDoc(found.ref, { name: name.slice(0, 80) });
}

// Products are read only through src/services/catalogService.js (paged, cached, quota-aware).
export async function readData(collectionDB, category, currentUser){
    if(collectionDB === "users"){
        const found = await getUserProfileDoc(currentUser);
        return found ? found.data : null;
    }
    throw new Error(`readData does not read "${collectionDB}"; use the catalog service for products.`);
}

async function requireProfileRef(user) {
    const found = await getUserProfileDoc(user);
    if (!found) throw new Error("Your profile could not be found. Please sign out and sign in again.");
    return found;
}

const VARIANTS = ["size", "color"];
const chosen = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : null);

/** Cart lines are identified by product id (or name for older lines) plus the chosen size and colour. */
export function sameCartLine(a, b) {
    const sameProduct = a.id && b.id ? a.id === b.id : a.name === b.name;
    return sameProduct && VARIANTS.every((f) => chosen(a[f]) === chosen(b[f]));
}

export function toCartLine(product, quantity = 1) {
    const line = {
        id: product.id || null,
        name: product.name,
        price: product.price,
        image: Array.isArray(product.image) ? product.image : [product.image].filter(Boolean),
        category: product.category || [],
        quantity,
    };
    // A chosen option is a single value; the catalog's option lists (arrays) are not copied.
    for (const field of VARIANTS) {
        if (chosen(product[field]) !== null) line[field] = chosen(product[field]);
    }
    return line;
}

/** Adds `quantity` of a product to the user's cart (merging with an existing line). */
export async function updateCart(product, user, quantity = 1){
    const { ref, data } = await requireProfileRef(user);
    const currentCart = Array.isArray(data.cart) ? data.cart.map((x) => ({ ...x })) : [];
    const line = toCartLine(product, quantity);
    const existing = currentCart.find((item) => sameCartLine(item, line));
    if (existing) {
        existing.quantity = (Number(existing.quantity) || 0) + quantity;
        if (!existing.id && line.id) existing.id = line.id;
    } else {
        currentCart.push(line);
    }
    await updateDoc(ref, { cart: currentCart });
    return currentCart;
}

export async function updateWishlist(product, user){
    const { ref, data } = await requireProfileRef(user);
    const wishlist = Array.isArray(data.wishlist) ? data.wishlist : [];
    if (wishlist.some((item) => sameCartLine(item, product))) return wishlist;
    const next = [...wishlist, { ...toCartLine(product), description: product.description || "", rating: product.rating ?? null }];
    await updateDoc(ref, { wishlist: next });
    return next;
}

export async function setCartBeforeBilling(currentCart, user){
    const { ref } = await requireProfileRef(user);
    await updateDoc(ref, { cart: currentCart });
}

export async function setWishlist(currentWishlist, user){
    const { ref } = await requireProfileRef(user);
    await updateDoc(ref, { wishlist: currentWishlist });
}

/** Admin only (enforced by firestore.rules). */
export async function getAllUsers(){
    const querySnapshot = await getDocs(query(collection(database, "users")));
    return querySnapshot.docs.map(withId);
}

/** Admin only (enforced by firestore.rules). */
export async function removeProduct(productId){
    await deleteDoc(doc(database, "products", productId));
}

/** Admin only (enforced by firestore.rules). Returns the new product with its id. */
export async function addNewProduct(product){
    const data = {
        name: product.name,
        description: product.description,
        price: product.price,
        image: product.image,
        category: product.category,
        rating: product.rating,
    };
    const ref = await addDoc(collection(database, "products"), data);
    return { id: ref.id, ...data };
}
