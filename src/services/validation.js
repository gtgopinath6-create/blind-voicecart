// Same rules as server/src/validation.js, for immediate, accessible error messages.
// The server re-validates everything; these checks are only for the user's convenience.

export const SHIPPING_FIELDS = [
    { field: "customerMobile", inputId: "custMob", label: "Mobile number", autoComplete: "tel-national", inputMode: "numeric", hint: "10 digits, for example 9876543210", pattern: /^[6-9]\d{9}$/, message: "Enter a valid 10-digit mobile number." },
    { field: "customerAddress", inputId: "custAddress", label: "Address", autoComplete: "street-address", multiline: true, min: 5, max: 300, message: "Enter your delivery address." },
    { field: "customerCity", inputId: "custCity", label: "City", autoComplete: "address-level2", min: 2, max: 80, message: "Enter your city." },
    { field: "customerState", inputId: "custState", label: "State", autoComplete: "address-level1", min: 2, max: 80, message: "Enter your state." },
    { field: "customerPincode", inputId: "custPin", label: "Pincode", autoComplete: "postal-code", inputMode: "numeric", hint: "6 digits", pattern: /^\d{6}$/, message: "Enter a valid 6-digit pincode." },
];

export const inputIdFor = (field) => (SHIPPING_FIELDS.find((r) => r.field === field) || {}).inputId || field;

/** Returns { field: message } for every invalid shipping field. */
export function validateShipping(values) {
    const errors = {};
    for (const rule of SHIPPING_FIELDS) {
        const raw = String((values && values[rule.field]) || "").trim();
        const compact = raw.replace(/\s+/g, "");
        const bad = (rule.min !== undefined && raw.length < rule.min) ||
            (rule.max !== undefined && raw.length > rule.max) ||
            (rule.pattern && !rule.pattern.test(compact));
        if (bad) errors[rule.field] = rule.message;
    }
    return errors;
}

export const MAX_REFILL_AMOUNT = 100000;

/** Whole rupees, 1..MAX_REFILL_AMOUNT. Returns an error message or null. */
export function validateRefillAmount(text) {
    const value = String(text || "").trim();
    if (!value) return "Enter an amount.";
    if (!/^\d+$/.test(value)) return "Enter a whole number of rupees, digits only.";
    const amount = Number(value);
    if (amount <= 0) return "The amount must be more than zero.";
    if (amount > MAX_REFILL_AMOUNT) return `The maximum refill is ₹${MAX_REFILL_AMOUNT}.`;
    return null;
}
