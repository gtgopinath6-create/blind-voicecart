// Input validation shared by the checkout and wallet endpoints.
// The browser runs the same checks for friendly messages, but these are the ones that count.

const SHIPPING_RULES = {
  customerMobile: { pattern: /^[6-9]\d{9}$/, message: 'Enter a valid 10-digit mobile number.' },
  customerAddress: { min: 5, max: 300, message: 'Enter your delivery address.' },
  customerCity: { min: 2, max: 80, message: 'Enter your city.' },
  customerState: { min: 2, max: 80, message: 'Enter your state.' },
  customerPincode: { pattern: /^\d{6}$/, message: 'Enter a valid 6-digit pincode.' },
};

/** Returns { value, errors } with trimmed shipping fields; errors maps field -> message. */
function validateShipping(input) {
  const value = {};
  const errors = {};
  const source = input && typeof input === 'object' ? input : {};
  for (const [field, rule] of Object.entries(SHIPPING_RULES)) {
    const raw = typeof source[field] === 'string' ? source[field].trim() : '';
    const tooShort = rule.min !== undefined && raw.length < rule.min;
    const tooLong = rule.max !== undefined && raw.length > rule.max;
    const badPattern = rule.pattern && !rule.pattern.test(raw.replace(/\s+/g, ''));
    if (tooShort || tooLong || badPattern) {
      errors[field] = rule.message;
    } else {
      value[field] = rule.pattern ? raw.replace(/\s+/g, '') : raw;
    }
  }
  return { value, errors };
}

/** Idempotency keys come from the browser; only allow a safe, bounded format. */
function isValidIdempotencyKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(key);
}

const MAX_REFILL_AMOUNT = 100000;

/** Whole rupees only, 1..MAX_REFILL_AMOUNT. Rejects strings, decimals, zero, negatives, NaN. */
function validateRefillAmount(amount) {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return 'Enter a whole number of rupees.';
  if (amount <= 0) return 'The refill amount must be more than zero.';
  if (amount > MAX_REFILL_AMOUNT) return `The maximum refill is ₹${MAX_REFILL_AMOUNT}.`;
  return null;
}

const roundMoney = (n) => Math.round(n * 100) / 100;

module.exports = { validateShipping, isValidIdempotencyKey, validateRefillAmount, roundMoney, MAX_REFILL_AMOUNT };
