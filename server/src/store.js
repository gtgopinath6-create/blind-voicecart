// Firestore access helpers used inside transactions.

const { HttpError } = require('./http');

/**
 * Finds the profile document for a Firebase Auth uid.
 * New profiles use users/{uid}; older ones have a random id with a `uid` field, so both are checked.
 */
async function getUserRef(db, t, uid) {
  const direct = db.collection('users').doc(uid);
  const directSnap = await t.get(direct);
  if (directSnap.exists) return { ref: direct, snap: directSnap };

  const legacy = await t.get(db.collection('users').where('uid', '==', uid).limit(1));
  if (!legacy.empty) return { ref: legacy.docs[0].ref, snap: legacy.docs[0] };

  throw new HttpError(404, 'profile_missing', 'Your account profile was not found. Please sign out and sign in again.');
}

/**
 * Loads the trusted product record for a cart line. Prefers the product id; older cart
 * lines only carry a name, which must match exactly one product.
 */
async function getProductForCartItem(db, t, item) {
  if (item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)) {
    const ref = db.collection('products').doc(item.id);
    const snap = await t.get(ref);
    if (snap.exists) return { ref, snap };
  }
  if (item && typeof item.name === 'string' && item.name) {
    const byName = await t.get(db.collection('products').where('name', '==', item.name).limit(25));
    // The catalog contains exact duplicate documents; accept a name-only line only when every
    // product with that name has the same price, and use the smallest id for a stable choice.
    if (!byName.empty && new Set(byName.docs.map((d) => Number(d.data().price))).size === 1) {
      const doc = [...byName.docs].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      return { ref: doc.ref, snap: doc };
    }
  }
  throw new HttpError(409, 'product_unavailable', `"${(item && item.name) || 'An item'}" is no longer available. Please remove it from your cart.`);
}

module.exports = { getUserRef, getProductForCartItem };
