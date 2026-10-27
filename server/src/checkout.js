// Server-side order placement. Prices, totals, stock and wallet balance are read from
// Firestore inside one transaction; nothing financial is taken from the browser.

const { HttpError } = require('./http');
const { getUserRef, getProductForCartItem } = require('./store');
const { validateShipping, isValidIdempotencyKey, roundMoney } = require('./validation');

const TAX_RATE = 0.18;
const MAX_QUANTITY_PER_ITEM = 20;
const MAX_CART_LINES = 50;
const VARIANT_FIELDS = ['size', 'color'];

/**
 * Places an order for `uid` from the cart stored in their profile.
 * The same idempotencyKey always returns the same order, so retries and double clicks
 * can never charge twice.
 */
async function placeOrder(db, { uid, idempotencyKey, shipping, FieldValue, now = () => new Date() }) {
  if (!isValidIdempotencyKey(idempotencyKey)) {
    throw new HttpError(400, 'invalid_input', 'Missing or invalid checkout request id. Please reload the page.');
  }
  const { value: shippingInfo, errors } = validateShipping(shipping);
  if (Object.keys(errors).length) {
    const err = new HttpError(400, 'invalid_shipping', 'Please correct the delivery details.');
    err.fields = errors;
    throw err;
  }

  const orderRef = db.collection('orders').doc(`${uid}_${idempotencyKey}`);

  return db.runTransaction(async (t) => {
    // All reads first (Firestore transaction rule), then writes.
    const existing = await t.get(orderRef);
    if (existing.exists) return { ...existing.data(), duplicate: true };

    const { ref: userRef, snap: userSnap } = await getUserRef(db, t, uid);
    const profile = userSnap.data() || {};
    const cart = Array.isArray(profile.cart) ? profile.cart : [];
    if (cart.length === 0) throw new HttpError(400, 'empty_cart', 'Your cart is empty.');
    if (cart.length > MAX_CART_LINES) throw new HttpError(400, 'invalid_cart', 'Your cart has too many items.');

    const lines = [];
    const stockByProduct = new Map();
    for (const item of cart) {
      const quantity = Number(item && item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
        throw new HttpError(400, 'invalid_cart', `Invalid quantity for "${(item && item.name) || 'an item'}".`);
      }
      const { ref: productRef, snap: productSnap } = await getProductForCartItem(db, t, item);
      const product = productSnap.data();
      const price = Number(product.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new HttpError(409, 'product_unavailable', `"${product.name}" cannot be purchased right now.`);
      }
      // Products with size/colour options need a valid choice for each.
      const variants = {};
      for (const field of VARIANT_FIELDS) {
        const options = Array.isArray(product[field]) ? product[field].map(String) : null;
        const chosen = item[field] === undefined || item[field] === null ? null : String(item[field]);
        if (options && options.length > 1 && !chosen) {
          throw new HttpError(409, 'variant_required', `Please choose a ${field === 'color' ? 'colour' : field} for "${product.name}" in your cart.`);
        }
        if (chosen !== null) {
          if (!options || !options.includes(chosen)) {
            throw new HttpError(409, 'invalid_variant', `The selected ${field === 'color' ? 'colour' : field} for "${product.name}" is not available.`);
          }
          variants[field] = chosen;
        }
      }
      // Stock is only enforced for products that track it (the current catalog has no stock field).
      if (typeof product.stock === 'number') {
        const entry = stockByProduct.get(productRef.path) || { ref: productRef, stock: product.stock, needed: 0, name: product.name };
        entry.needed += quantity;
        stockByProduct.set(productRef.path, entry);
      }
      lines.push({
        productId: productRef.id,
        name: product.name,
        size: variants.size || null,
        color: variants.color || null,
        unitPrice: price,
        quantity,
        lineTotal: roundMoney(price * quantity),
      });
    }

    for (const entry of stockByProduct.values()) {
      if (entry.needed > entry.stock) {
        throw new HttpError(409, 'out_of_stock', `Only ${entry.stock} of "${entry.name}" left in stock.`);
      }
    }

    const subtotal = roundMoney(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    const tax = roundMoney(subtotal * TAX_RATE);
    const total = roundMoney(subtotal + tax);
    const balance = Number(profile.wallet) || 0;
    if (balance < total) {
      throw new HttpError(402, 'insufficient_balance', `Insufficient wallet balance. The order total is ₹${total} and your balance is ₹${balance}.`);
    }
    const newBalance = roundMoney(balance - total);
    const createdAt = now();

    const order = {
      orderId: orderRef.id,
      uid,
      items: lines,
      subtotal,
      tax,
      total,
      currency: 'INR',
      paymentMethod: 'wallet',
      status: 'placed',
      shipping: shippingInfo,
      walletBalanceAfter: newBalance,
      createdAt: createdAt.toISOString(),
    };

    t.set(orderRef, order);
    for (const entry of stockByProduct.values()) {
      t.update(entry.ref, { stock: entry.stock - entry.needed });
    }
    const purchaseDate = [createdAt.getDate(), createdAt.getMonth() + 1, createdAt.getFullYear()];
    t.update(userRef, {
      wallet: newBalance,
      cart: [],
      // Kept for the existing purchaseHistory field; the order document is the source of truth.
      purchaseHistory: FieldValue.arrayUnion(
        ...lines.map((l) => ({ orderId: orderRef.id, name: l.name, price: l.unitPrice, quantity: l.quantity, purchaseDate }))
      ),
    });
    return { ...order, duplicate: false };
  });
}

/** Read-only quote so the billing page can show server-calculated totals before paying. */
async function quoteCart(db, { uid }) {
  return db.runTransaction(async (t) => {
    const { snap: userSnap } = await getUserRef(db, t, uid);
    const profile = userSnap.data() || {};
    const cart = Array.isArray(profile.cart) ? profile.cart : [];
    const lines = [];
    const problems = [];
    for (const item of cart) {
      try {
        const { ref, snap } = await getProductForCartItem(db, t, item);
        const product = snap.data();
        const quantity = Number(item.quantity);
        const price = Number(product.price);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
          problems.push(`Invalid quantity for "${product.name}".`);
          continue;
        }
        if (typeof product.stock === 'number' && product.stock < quantity) {
          problems.push(`Only ${product.stock} of "${product.name}" left in stock.`);
        }
        for (const field of VARIANT_FIELDS) {
          if (Array.isArray(product[field]) && product[field].length > 1 && (item[field] === undefined || item[field] === null)) {
            problems.push(`Please choose a ${field === 'color' ? 'colour' : field} for "${product.name}" in your cart.`);
          }
        }
        lines.push({ productId: ref.id, name: product.name, size: item.size ?? null, color: item.color ?? null, unitPrice: price, quantity, lineTotal: roundMoney(price * quantity) });
      } catch (e) {
        problems.push(e.message);
      }
    }
    const subtotal = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
    const tax = roundMoney(subtotal * TAX_RATE);
    return { items: lines, subtotal, tax, total: roundMoney(subtotal + tax), walletBalance: Number(profile.wallet) || 0, problems };
  });
}

module.exports = { placeOrder, quoteCart, TAX_RATE, MAX_QUANTITY_PER_ITEM };
