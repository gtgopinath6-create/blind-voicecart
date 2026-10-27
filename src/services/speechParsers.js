/**
 * Deterministic parsers for spoken answers to Zoro's questions.
 *
 * They run in the browser only: answers such as an email address, a mobile number, an address
 * or a body measurement are never sent to the AI service. Every parser returns null when it is
 * not sure, so the caller asks again instead of guessing.
 */

const UNITS = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000 };

/** Lower case, spoken punctuation removed, single spaces. Keeps digits, "@", "." and "'". */
export function normalizeSpeech(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/½/g, " and a half")
        .replace(/(^|\s|\d)1\/2\b/g, "$1 and a half")
        .replace(/(\d),(?=\d)/g, "$1")
        .replace(/[₹,]/g, " ")
        .replace(/[^a-z0-9@.'\s-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const isNumberWord = (w) => (w in UNITS && w !== "o" && w !== "oh") || w in TENS;
const halfFollows = (words, j) => ["and a half", "and half"].some((h) => words.slice(j, j + h.split(" ").length).join(" ") === h) || words[j] === "half";

/** "point two five" after a whole number -> 0.25 (and the index after it), or null. */
function decimalAfter(words, j) {
    if (words[j] !== "point") return null;
    let digits = "";
    let k = j + 1;
    for (; k < words.length; k++) {
        const w = words[k];
        if (/^\d+$/.test(w)) digits += w;
        else if (w in UNITS && UNITS[w] < 10 && w !== "o" && w !== "oh") digits += String(UNITS[w]);
        else break;
    }
    return digits ? Number(`0.${digits}`) : null;
}

/**
 * The first number in the text, written or spoken: "186", "one hundred eighty six",
 * "nine and a half", "nine point five", "5 thousand", "3k", "9.5". Decimals are kept as said
 * ("nine point two" is 9.2, never rounded). Returns null if there is none.
 */
export function extractNumber(text) {
    const words = normalizeSpeech(text).replace(/-/g, " ").replace(/(\d)([a-z])/g, "$1 $2").split(" ").map((w) => w.replace(/\.$/, ""));
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (/^\d+(\.\d+)?$/.test(w)) {
            let n = Number(w);
            let j = i + 1;
            if (words[j] in SCALES) { n *= SCALES[words[j]]; j++; } else if (words[j] === "k") { n *= 1000; j++; }
            const decimal = Number.isInteger(n) ? decimalAfter(words, j) : null;
            if (decimal !== null) return n + decimal;
            return halfFollows(words, j) ? n + 0.5 : n;
        }
        if (!isNumberWord(w)) continue;
        let total = 0;
        let current = 0;
        let j = i;
        for (; j < words.length; j++) {
            const x = words[j];
            if (x in UNITS && x !== "o" && x !== "oh") current += UNITS[x];
            else if (x in TENS) current += TENS[x];
            else if (x in SCALES) {
                current = (current || 1) * SCALES[x];
                if (SCALES[x] >= 1000) { total += current; current = 0; }
            } else if (x === "and" && j + 1 < words.length && isNumberWord(words[j + 1])) continue;
            else break;
        }
        const n = total + current;
        const decimal = decimalAfter(words, j);
        if (decimal !== null) return n + decimal;
        return halfFollows(words, j) ? n + 0.5 : n;
    }
    return null;
}

// Words speech recognition writes for a number said on its own ("size for" is size 4). Used only
// where a number is the expected answer, and the value is always read back for confirmation.
const NUMBER_SOUNDALIKES = { for: "four", fore: "four", to: "two", too: "two", won: "one", ate: "eight", tree: "three" };

/** A short answer with sound-alike number words replaced ("size for" -> "size four"), or the text unchanged. */
export function numberSoundalikes(text) {
    const t = normalizeSpeech(text);
    if (t.split(" ").length > 4) return t;
    return t.split(" ").map((w) => NUMBER_SOUNDALIKES[w] || w).join(" ");
}

// ---------------------------------------------------------------- yes / no

const YES_PHRASES = [
    "yes", "yeah", "yep", "yup", "ya", "yah", "yea", "yes please", "sure", "correct", "that's correct", "that is correct",
    "haan", "haan ji", "ji haan", "add it", "go for it", "sure why not",
    "thats correct", "that's right", "that is right", "thats right", "right", "exactly", "absolutely",
    "ok", "okay", "confirm", "confirmed", "go ahead", "do it", "please do", "sounds good", "perfect",
    "affirmative", "of course", "it is", "yes it is", "yes that's right", "yes correct", "yes place order",
    "yes place the order", "yes place my order", "place order", "place the order", "place my order",
];
const NO_PHRASES = [
    "no", "nope", "nah", "not quite", "not really", "wrong", "incorrect", "that's wrong", "that is wrong",
    "thats wrong", "no change it", "change it", "cancel", "cancel it", "cancel that", "never mind",
    "don't", "do not", "negative", "not that", "no thanks", "no thank you", "stop", "that's not right",
    "that is not right", "not correct", "nahi", "nahin", "na", "no way", "not now", "not interested", "skip it",
];
// Speech recognition often writes a lone "no" as "know". Only the whole answer is read this way.
const NO_SOUNDALIKES = ["know"];
// "I don't want it", "please don't add it": a refusal anywhere in a short answer.
const REFUSAL = /\b(don'?t|do not|didn'?t) (want|need|add|buy|order|place|like)\b/;
// Fillers people say before answering; they never change the answer.
const FILLERS = /\b(um+|uh+|hmm+|er+m?|well|zoro|please|hey)\b/g;
const sortedYes = [...YES_PHRASES].sort((a, b) => b.length - a.length);
const sortedNo = [...NO_PHRASES].sort((a, b) => b.length - a.length);

/**
 * Classifies an answer to a yes/no question. Returns { answer: "yes" | "no" | "unclear", rest },
 * where `rest` is whatever followed the leading yes/no ("no, size 10" -> rest "size 10").
 * Anything that is not clearly yes or no is "unclear" and must never be treated as yes.
 */
export function classifyAnswer(text) {
    const t = normalizeSpeech(text).replace(FILLERS, " ").replace(/\s+/g, " ").replace(/[.]/g, "").trim();
    if (!t) return { answer: "unclear", rest: "" };
    if (NO_SOUNDALIKES.includes(t)) return { answer: "no", rest: "" };
    const startsWith = (phrase) => t === phrase || t.startsWith(`${phrase} `);
    const yes = sortedYes.find(startsWith);
    const no = sortedNo.find(startsWith);
    if (yes && no) return { answer: "unclear", rest: t };
    if (no) return { answer: "no", rest: t.slice(no.length).trim().replace(/^(it'?s|it is|to|i want|i'd like|make it|i said|i meant|i mean|i asked for|i wanted)\s+/, "").trim() };
    if (yes) {
        const rest = t.slice(yes.length).trim();
        // "yes ... no" or "right, but no" are contradictory ("yes, why not" is a yes); "add it to my
        // wishlist" is not a yes to the cart.
        if (/\b(no|not|don't|wrong|wishlist|wish list)\b/.test(rest.replace(/\bwhy not\b/, ""))) return { answer: "unclear", rest: t };
        return { answer: "yes", rest };
    }
    if (REFUSAL.test(t) && t.split(" ").length <= 8) return { answer: "no", rest: "" };
    return { answer: "unclear", rest: t };
}

// ---------------------------------------------------------------- choices

const ORDINAL_WORDS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };

/** "the second one", "option 2", "number three", "2" -> zero-based index within `count`, or null. */
export function parseOptionIndex(text, count) {
    const t = normalizeSpeech(text);
    const ordinal = t.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/);
    let n = ordinal ? ORDINAL_WORDS[ordinal[1]] : null;
    if (n === null) {
        const numbered = t.match(/^(?:the )?(?:option|number|choice|item)?\s*(\d|one|two|three|four|five)(?: one)?$/) ||
            t.match(/\b(?:option|number|choice|item)\s+(\d|one|two|three|four|five)\b/);
        if (numbered) n = /^\d$/.test(numbered[1]) ? Number(numbered[1]) : UNITS[numbered[1]];
    }
    if (n === -1) n = count;
    if (!n || n < 1 || n > count) return null;
    return n - 1;
}

// ---------------------------------------------------------------- shoe sizes

const SIZE_SYSTEMS = [
    { system: "UK", words: ["uk", "u k", "british"] },
    { system: "US", words: ["us", "u s", "american"] },
    { system: "EU", words: ["eu", "e u", "european", "euro"] },
    { system: "INDIA", words: ["india", "indian", "ind"] },
];

/** The sizing system mentioned in the text ("UK 9", "European 43"), or null. */
export function parseSizeSystem(text) {
    const t = ` ${normalizeSpeech(text).replace(/\./g, " ")} `;
    const found = SIZE_SYSTEMS.find((s) => s.words.some((w) => t.includes(` ${w} `)));
    return found ? found.system : null;
}

/** "size 9", "UK nine and a half", "I wear a 10" -> { size: "9.5", system: "UK" | null }, or null. */
export function parseShoeSize(text) {
    const n = extractNumber(text);
    if (n === null || n < 1 || n > 50 || Math.round(n * 2) !== n * 2) return null;
    return { size: String(n), system: parseSizeSystem(text) };
}

/**
 * A spoken answer to "which size?": { size, system } as parseShoeSize, or { notShoeSize: "9.2" } when
 * a number was heard that is not a whole or half size (it is never rounded to one), or null.
 * Sound-alike number words are understood in short answers ("size for" -> 4).
 */
export function parseSizeAnswer(text) {
    const direct = parseShoeSize(text);
    if (direct) return direct;
    const n = extractNumber(text);
    if (n !== null && n >= 1 && n <= 50) return { notShoeSize: String(n) };
    const alike = numberSoundalikes(text);
    return alike !== normalizeSpeech(text) ? parseShoeSize(alike) : null;
}

// ---------------------------------------------------------------- measurements

/** Height in cm from "186 centimetres", "1.86 metres", "6 feet 1 inch", "five foot eleven". */
export function parseHeight(text) {
    const t = normalizeSpeech(text).replace(/(\d)'(\d)/, "$1 feet $2").replace(/(\d)'/, "$1 feet");
    const feet = t.match(/(.+?)\s*(?:feet|foot|ft)\b(?:\s*(?:and\s*)?(.*?)\s*(?:inches|inch|in)?\b)?$/);
    if (feet) {
        const ft = extractNumber(feet[1]);
        const inches = feet[2] ? extractNumber(feet[2]) : 0;
        if (ft !== null && ft >= 3 && ft <= 8 && (inches === null || (inches >= 0 && inches < 12))) {
            return { cm: Math.round((ft * 12 + (inches || 0)) * 2.54) };
        }
        return null;
    }
    const n = extractNumber(t);
    if (n === null) return null;
    let cm = null;
    if (/\b(metre|meter|metres|meters|m)\b/.test(t) && n < 3) cm = Math.round(n * 100);
    else if (/\b(centimetre|centimeter|centimetres|centimeters|cm|cms)\b/.test(t) || n >= 50) cm = Math.round(n);
    return cm !== null && cm >= 50 && cm <= 250 ? { cm } : null;
}

/** Weight in kg from "70 kilograms", "70 kilos", "154 pounds". */
export function parseWeight(text) {
    const t = normalizeSpeech(text);
    const n = extractNumber(t);
    if (n === null) return null;
    const kg = /\b(pound|pounds|lb|lbs)\b/.test(t) ? Math.round(n * 0.45359237) : Math.round(n);
    return kg >= 20 && kg <= 300 ? { kg } : null;
}

/** Foot length in cm from "27 centimetres", "265 millimetres", "10.5 inches". */
export function parseFootLength(text) {
    const t = normalizeSpeech(text);
    const n = extractNumber(t);
    if (n === null) return null;
    let cm = n;
    if (/\b(millimetre|millimeter|millimetres|millimeters|mm)\b/.test(t)) cm = n / 10;
    else if (/\b(inch|inches|in)\b/.test(t)) cm = n * 2.54;
    cm = Math.round(cm * 10) / 10;
    return cm >= 12 && cm <= 36 ? { cm } : null;
}

// ---------------------------------------------------------------- budget and quantity

/** "under 5000", "less than five thousand rupees", "above 1000" -> { max } / { min }, or null. */
export function parseBudget(text) {
    const t = normalizeSpeech(text);
    const max = t.match(/\b(?:under|below|less than|within|up to|upto|maximum|max|no more than|cheaper than)\b(.*)$/);
    const min = t.match(/\b(?:above|over|more than|at least|minimum)\b(.*)$/);
    const pick = (m) => {
        const n = m ? extractNumber(m[1]) : null;
        return n !== null && n > 0 && n <= 10000000 ? n : null;
    };
    const result = {};
    if (pick(max) !== null) result.max = pick(max);
    if (pick(min) !== null) result.min = pick(min);
    return Object.keys(result).length ? result : null;
}

/** "two pairs", "quantity 3", "3 of them" -> 2 / 3, or null (1 to 20 only). */
export function parseQuantity(text) {
    const t = normalizeSpeech(text);
    const m = t.match(/\b(?:quantity|qty)\s+(\w+)/) || t.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:pairs?|pieces?|items?|units?|of them|packs?)\b/);
    if (!m) return null;
    const n = extractNumber(m[1]);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

// ---------------------------------------------------------------- digits, email

/** Spoken digits: "nine eight seven six", "double nine", "98765 43210" -> "98765..." (digits only). */
export function parseDigits(text) {
    const words = normalizeSpeech(text).replace(/-/g, " ").split(" ");
    let out = "";
    let repeat = 1;
    for (const w of words) {
        if (w === "double") { repeat = 2; continue; }
        if (w === "triple") { repeat = 3; continue; }
        let digits = null;
        if (/^\d+$/.test(w)) digits = w;
        else if (w in UNITS && UNITS[w] < 10) digits = String(UNITS[w]);
        if (digits === null) { repeat = 1; continue; }
        out += digits.length === 1 ? digits.repeat(repeat) : digits;
        repeat = 1;
    }
    return out || null;
}

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const EMAIL_WORDS = [
    [/\bat the rate( of)?\b/g, " @ "], [/\bat sign\b/g, " @ "], [/\bat\b/g, " @ "],
    [/\b(dot|period|point)\b/g, " . "], [/\bunderscore\b/g, " _ "], [/\b(dash|hyphen|minus)\b/g, " - "],
    [/\bplus\b/g, " + "],
];

/**
 * An email address from speech: "gopi nath at example dot com" -> "gopinath@example.com".
 * Digits may be spoken as words. Returns null unless the result is a well-formed address.
 */
export function parseEmail(text) {
    let t = String(text || "").toLowerCase().replace(/[,]/g, " ").replace(/\bunder score\b/g, "underscore");
    t = t.replace(/\b(my email is|email address is|my email address is|it's|it is|email)\b/g, " ");
    for (const [pattern, replacement] of EMAIL_WORDS) t = t.replace(pattern, replacement);
    const words = t.split(/\s+/).filter(Boolean).map((w) => (w in UNITS && UNITS[w] < 10 && w !== "o" ? String(UNITS[w]) : w));
    // "double o", "triple seven": common when spelling an address in Indian English.
    const spelled = [];
    for (let i = 0; i < words.length; i++) {
        const times = { double: 2, triple: 3 }[words[i]];
        if (times && words[i + 1] && words[i + 1].length === 1) { spelled.push(words[i + 1].repeat(times)); i++; } else spelled.push(words[i]);
    }
    const email = spelled.join("").replace(/\.+/g, ".");
    return EMAIL_PATTERN.test(email) ? email : null;
}

/** How an address is read back: "g o p i n a t h at example dot com". */
export function speakableEmail(email) {
    const [local, domain] = String(email).split("@");
    const spell = (s) => s.split("").map((c) => ({ ".": "dot", _: "underscore", "-": "dash", "+": "plus" }[c] || c)).join(" ");
    return `${spell(local)}, at ${domain.split(".").join(" dot ")}`;
}

/**
 * Digits read one by one, in short groups with a pause between them: a 10-digit mobile number as
 * "9 8 7 6 5, 4 3 2 1 0", a 6-digit pincode as "5 6 0, 0 0 1".
 */
export function speakableDigits(digits) {
    const d = String(digits);
    const size = d.length === 10 ? 5 : d.length <= 4 ? d.length : 3;
    const groups = [];
    for (let i = 0; i < d.length; i += size) groups.push(d.slice(i, i + size).split("").join(" "));
    return groups.join(", ");
}
