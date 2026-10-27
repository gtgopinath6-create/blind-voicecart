// Wallet credits. A wallet may only be credited after a verified payment.
// No payment provider is integrated yet, so:
//   - production: refills are refused (501) - no free credit is ever granted;
//   - development: an explicit opt-in mock (ALLOW_DEV_WALLET_CREDIT=true) credits the
//     balance, clearly recorded as `provider: "dev-mock"`.
// A real provider must credit the wallet from its verified webhook/callback via
// creditWallet(), never from a browser "payment succeeded" message.

const { HttpError } = require('./http');
const { getUserRef } = require('./store');
const { validateRefillAmount, isValidIdempotencyKey, roundMoney } = require('./validation');

/**
 * Atomically credits `amount` to `uid` once per `paymentId`.
 * paymentId must be a provider-verified payment reference (or the dev-mock request id).
 */
async function creditWallet(db, { uid, amount, paymentId, provider, now = () => new Date() }) {
  const amountError = validateRefillAmount(amount);
  if (amountError) throw new HttpError(400, 'invalid_amount', amountError);
  if (!isValidIdempotencyKey(paymentId)) throw new HttpError(400, 'invalid_input', 'Invalid payment reference.');

  const txRef = db.collection('walletTransactions').doc(`${provider}_${paymentId}`);
  return db.runTransaction(async (t) => {
    const existing = await t.get(txRef);
    if (existing.exists) {
      const data = existing.data();
      if (data.uid !== uid) throw new HttpError(409, 'conflict', 'This payment reference belongs to another account.');
      return { ...data, duplicate: true };
    }
    const { ref: userRef, snap } = await getUserRef(db, t, uid);
    const balanceBefore = Number(snap.data().wallet) || 0;
    const balanceAfter = roundMoney(balanceBefore + amount);
    const record = {
      uid,
      type: 'credit',
      amount,
      provider,
      paymentId,
      balanceBefore,
      balanceAfter,
      createdAt: now().toISOString(),
    };
    t.set(txRef, record);
    t.update(userRef, { wallet: balanceAfter });
    return { ...record, duplicate: false };
  });
}

/** Handles POST /api/wallet/refill from the browser. */
async function requestRefill(db, { uid, amount, idempotencyKey, config }) {
  if (!config.allowDevWalletCredit) {
    throw new HttpError(
      501,
      'payments_unavailable',
      'Wallet refill is not available yet because no payment provider is connected.'
    );
  }
  return creditWallet(db, { uid, amount, paymentId: idempotencyKey, provider: 'dev-mock' });
}

module.exports = { creditWallet, requestRefill };
