// One way to tell the user something, used across the app:
//  - custom screen reader ON  -> spoken with the browser's speech synthesis;
//  - custom screen reader OFF -> written to a polite aria-live region, so native screen
//    readers (NVDA, JAWS, VoiceOver) read it instead and nothing is spoken twice.
//
// All speech in the app goes through speakText(), so it uses one voice, one rate and one queue:
//  - one speaker at a time: a new message replaces the previous one, never talks over it;
//  - Zoro's replies ("assistant") are never cut off by page speech, and hovering with the mouse
//    never cuts off anything except other hover speech;
//  - text is made speakable first (prices, sizes, symbols) and long replies are spoken in chunks
//    of whole sentences, which avoids Chrome stopping long utterances part-way.
import { getSpeechLanguage } from "./speechSettings";

let customSpeechEnabled = true;

// While Zoro is thinking or speaking, other page speech (focus and hover reading, page
// announcements) waits, so it never cuts Zoro off mid-sentence. Zoro's reply already says what
// changed (for example "I've moved to the password field").
let assistantBusy = false;
export function setAssistantBusy(busy) {
    assistantBusy = Boolean(busy);
}
export function isAssistantBusy() {
    return assistantBusy;
}

// ---------------------------------------------------------------- rate

// Speech rate for Zoro and the built-in reader ("speak more slowly"), remembered on this device.
// Normal is slightly below the browser default (1), a starting point for clear speech that
// still needs tuning by ear on real devices.
const RATE_KEY = "vc-speech-rate";
export const NORMAL_RATE = 0.95;
const MIN_RATE = 0.6;
const MAX_RATE = 1.6;
const RATE_STEP = 0.15;
let speechRate = (() => {
    try {
        const saved = Number(localStorage.getItem(RATE_KEY));
        return saved >= MIN_RATE && saved <= MAX_RATE ? saved : NORMAL_RATE;
    } catch (e) {
        return NORMAL_RATE;
    }
})();

export function getSpeechRate() {
    return speechRate;
}

/** Sets the rate (0.6 to 1.6) and remembers it. Returns the rate used. */
export function setSpeechRate(rate) {
    speechRate = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, Number(rate) || NORMAL_RATE)) * 100) / 100;
    try { localStorage.setItem(RATE_KEY, String(speechRate)); } catch (e) { /* not saved */ }
    return speechRate;
}

/** change: "slower" | "faster" | "normal". Returns the new rate. */
export function changeSpeechRate(change) {
    return setSpeechRate(change === "normal" ? NORMAL_RATE : speechRate + (change === "slower" ? -RATE_STEP : RATE_STEP));
}

// ---------------------------------------------------------------- voices

const VOICE_KEY = "vc-speech-voice";
let chosenVoiceURI = (() => {
    try {
        return localStorage.getItem(VOICE_KEY) || "";
    } catch (e) {
        return "";
    }
})();
let voices = [];
let currentVoice = null;      // resolved once and kept, so a conversation keeps one voice
let watching = false;
const voiceListeners = new Set();

// Novelty and sound-effect voices installed on macOS (they appear as en-US voices); never chosen automatically.
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|kathy|organ|pipe organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred)$/i;
// Compact older-style voices (macOS "Eloquence"); usable, but chosen only when nothing else fits.
const COMPACT = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
const QUALITY = /\b(natural|neural|enhanced|premium)\b/i;
// The closest accents to try when no voice exists for the chosen English.
const NEAREST = {
    "en-in": ["en-gb", "en-us"],
    "en-us": ["en-ca", "en-gb"],
    "en-gb": ["en-ie", "en-au", "en-us"],
    "en-au": ["en-nz", "en-gb"],
    "en-nz": ["en-au", "en-gb"],
    "en-ca": ["en-us", "en-gb"],
    "en-ie": ["en-gb"],
    "en-za": ["en-gb"],
};

const langOf = (v) => String((v && v.lang) || "").toLowerCase().replace("_", "-");

/** How well a voice suits the language; null when it does not speak English or is a novelty voice. */
export function voiceScore(voice, language = getSpeechLanguage()) {
    const lang = langOf(voice);
    const want = language.toLowerCase();
    if (!lang.startsWith("en") || NOVELTY.test(String(voice.name || "").trim())) return null;
    let score;
    if (lang === want) score = 100;
    else {
        const near = (NEAREST[want] || ["en-gb", "en-us"]).indexOf(lang);
        score = near === -1 ? 30 : 60 - near * 10;
    }
    if (QUALITY.test(voice.name || "")) score += 8;   // e.g. Edge's "Online (Natural)" voices
    if (voice.localService) score += 5;               // works offline, and Chrome never cuts it off
    if (COMPACT.test(voice.name || "")) score -= 25;
    if (voice.default) score += 2;
    return score;
}

/** The best installed voice for a language, or null (then the browser's default voice is used). */
export function pickVoice(list = voices, language = getSpeechLanguage()) {
    let best = null;
    let bestScore = -Infinity;
    for (const v of list || []) {
        const s = voiceScore(v, language);
        if (s !== null && s > bestScore) { best = v; bestScore = s; }
    }
    return best;
}

function refreshVoices() {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    voices = synth && typeof synth.getVoices === "function" ? synth.getVoices() || [] : [];
    // Keep the voice in use when it is still installed, so it never changes mid-conversation.
    if (currentVoice) currentVoice = voices.find((v) => v.voiceURI === currentVoice.voiceURI) || null;
    voiceListeners.forEach((fn) => fn());
}

/**
 * Starts tracking the installed voices. Browsers load them asynchronously (Chrome returns none on
 * the first call and fires "voiceschanged" when they arrive).
 */
export function watchVoices() {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!watching && synth && typeof synth.addEventListener === "function") {
        synth.addEventListener("voiceschanged", refreshVoices);
        watching = true;
    }
    refreshVoices();
}

/** Calls fn whenever the installed voices change; returns an unsubscribe function. */
export function subscribeVoices(fn) {
    voiceListeners.add(fn);
    return () => voiceListeners.delete(fn);
}

/** English voices for the settings list: { id, label }, best suited first. */
export function englishVoices(language = getSpeechLanguage()) {
    return voices
        .map((v, i) => ({ v, i, s: voiceScore(v, language) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(({ v }) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` }));
}

export function getChosenVoice() {
    return chosenVoiceURI;
}

/** "" chooses automatically. A chosen voice that is not installed on this device is ignored. */
export function setChosenVoice(voiceURI) {
    chosenVoiceURI = voiceURI || "";
    currentVoice = null;
    try {
        if (chosenVoiceURI) localStorage.setItem(VOICE_KEY, chosenVoiceURI);
        else localStorage.removeItem(VOICE_KEY);
    } catch (e) { /* not saved */ }
    voiceListeners.forEach((fn) => fn());
}

/** Forget the voice in use, for example after the language changes. */
export function resetVoice() {
    currentVoice = null;
}

/** The voice speech will use now: the shopper's choice if installed, otherwise the best match. */
export function activeVoice() {
    if (!voices.length) refreshVoices();
    if (!currentVoice) {
        currentVoice = (chosenVoiceURI && voices.find((v) => v.voiceURI === chosenVoiceURI)) || pickVoice(voices);
    }
    return currentVoice;
}

// ---------------------------------------------------------------- speakable text

const ONE_RUPEE = (n) => (n === "1" ? "1 rupee" : `${n} rupees`);

/**
 * Text as it should be spoken. The meaning and every value stay the same; only the way they are
 * written changes, so all voices read them alike:
 *   "₹1,49,999" -> "149999 rupees" (Indian digit grouping confuses non-Indian voices),
 *   "₹49.50" -> "49 rupees 50 paise", "128 GB" -> "128 gigabytes", "UK 9" -> "U K 9",
 *   "&" -> "and", "e.g." -> "for example"; web addresses are left out, quotes and brackets become pauses.
 */
export function speakable(text) {
    return String(text || "")
        .replace(/\bhttps?:\/\/\S+/gi, "")
        .replace(/₹\s?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?/g, (m, whole, dec) => {
            const n = whole.replace(/,/g, "");
            const paise = dec ? Number(dec.padEnd(2, "0")) : 0;
            return paise ? `${ONE_RUPEE(n)} ${paise} paise` : ONE_RUPEE(n);
        })
        .replace(/\b\d{1,3}(?:,\d{2,3})+\b/g, (m) => m.replace(/,/g, ""))
        .replace(/(\d)\s?GB\b/g, "$1 gigabytes")
        .replace(/(\d)\s?TB\b/g, "$1 terabytes")
        .replace(/\b(UK|US|EU)(?=\s?\d)/g, (m) => m.split("").join(" "))
        .replace(/\be\.g\./gi, "for example")
        .replace(/\bi\.e\./gi, "that is")
        .replace(/\s&\s/g, " and ")
        .replace(/[“”"]/g, "")
        .replace(/\s*[()[\]]\s*/g, ", ")
        .replace(/\.{3,}|…/g, ".")
        .replace(/\s*,(\s*,)+/g, ",")
        .replace(/,\s*([.?!])/g, "$1")
        .replace(/\s+/g, " ")
        .replace(/^[\s,]+|[\s,]+$/g, "")
        .trim();
}

export const MAX_CHUNK = 160;

/**
 * Splits text into chunks of whole sentences of at most `max` characters (a longer sentence is split
 * at commas). Decimal points ("9.5") are not sentence ends.
 */
export function speechChunks(text, max = MAX_CHUNK) {
    const sentences = String(text || "").replace(/([.!?])\s+/g, "$1\u0001").split("\u0001").map((s) => s.trim()).filter(Boolean);
    const pieces = [];
    // Joins words or clauses into pieces of at most `max` characters.
    const pack = (items, joiner, mark) => {
        const out = [];
        let part = "";
        for (const item of items) {
            const next = part ? `${part}${joiner}${item}` : item;
            if (part && next.length > max) { out.push(`${part}${mark}`); part = item; } else part = next;
        }
        if (part) out.push(part);
        return out;
    };
    for (const sentence of sentences) {
        if (sentence.length <= max) { pieces.push(sentence); continue; }
        for (const clause of pack(sentence.split(/,\s+/), ", ", ",")) {
            if (clause.length <= max) pieces.push(clause);
            else pieces.push(...pack(clause.split(/\s+/), " ", ""));
        }
    }
    const chunks = [];
    for (const piece of pieces) {
        const last = chunks[chunks.length - 1];
        if (last && last.length + 1 + piece.length <= max) chunks[chunks.length - 1] = `${last} ${piece}`;
        else chunks.push(piece);
    }
    return chunks;
}

// ---------------------------------------------------------------- speaking

let token = 0;
let session = null;           // { token, kind, chunks, index, resolve, ... }
const inFlight = new Set();   // utterances are kept referenced: Chrome may drop events of collected ones
// Chrome on macOS can get stuck when an utterance is cancelled in the same moment it was queued: the
// next one never starts and speechSynthesis.speaking stays true (seen in this app when clicking the
// voice button cancelled the reading of the focused button). Three defences:
//  - focus and hover reading start on the next tick, so a click that turns Zoro on cancels them
//    before they ever reach the browser;
//  - speech waits a moment after any cancel;
//  - a part that has not started after START_TIMEOUT_MS is nudged with pause() and resume(), which
//    restarts the stuck engine; if it still has not started, it is skipped so speech never stalls.
const CANCEL_SETTLE_MS = 60;
const START_TIMEOUT_MS = 2500;
const NUDGE_WAIT_MS = 1500;
const DEFERRED_KINDS = ["focus", "hover"];
let lastCancelAt = -Infinity;
// A steady clock: changing the computer's time never stretches the wait.
const clock = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
const VOICE_ERRORS = ["voice-unavailable", "language-unavailable", "synthesis-unavailable", "synthesis-failed"];

function cancelSynth(synth) {
    lastCancelAt = clock();
    synth.cancel();
}

const chunkTimeout = (chunk) => Math.max(4000, (1500 + chunk.split(/\s+/).length * 700) / speechRate);

function settle(s, status) {
    if (s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    if (session === s) session = null;
    s.resolve({ status, remaining: status === "done" ? [] : s.chunks.slice(s.index) });
}

function speakChunk(s) {
    const synth = window.speechSynthesis;
    if (s.done || s.token !== token) return;
    if (s.index >= s.chunks.length) { settle(s, "done"); return; }
    const chunk = s.chunks[s.index];
    const utterance = new window.SpeechSynthesisUtterance(chunk);
    const voice = s.useVoice ? activeVoice() : null;
    utterance.lang = voice && voice.lang ? voice.lang : getSpeechLanguage();
    if (voice) utterance.voice = voice;
    utterance.rate = speechRate;
    utterance.pitch = 1;
    utterance.volume = 1;
    inFlight.add(utterance);
    s.issued = true;
    let extensions = 0;
    let finished = false;
    let started = false;
    const next = (outcome) => {
        if (finished) return;
        finished = true;
        inFlight.delete(utterance);
        clearTimeout(s.timer);
        if (s.done || s.token !== token) return; // replaced or stopped meanwhile
        if (outcome === "end" || outcome === "timeout") {
            s.index += 1;
            speakChunk(s);
        } else if (outcome === "interrupted" || outcome === "canceled") {
            settle(s, "stopped");
        } else if (VOICE_ERRORS.includes(outcome) && s.useVoice) {
            // The chosen voice failed: try this chunk once more with the browser's default voice.
            s.useVoice = false;
            speakChunk(s);
        } else {
            settle(s, "failed");
        }
    };
    const arm = () => {
        s.timer = setTimeout(() => {
            // Some browsers never fire "end". Still talking (slow rate)? Wait a little longer.
            if (synth.speaking && extensions < 2) { extensions += 1; arm(); } else next("timeout");
        }, chunkTimeout(chunk));
    };
    utterance.onstart = () => {
        started = true;
        clearTimeout(s.timer);
        arm();
    };
    utterance.onend = () => next("end");
    utterance.onerror = (event) => next((event && event.error) || "error");
    // Not started: nudge the engine once; if it still does not start, skip this part.
    let nudged = false;
    const watchStart = () => {
        if (started || finished || s.done || s.token !== token) return;
        if (!nudged && typeof synth.pause === "function" && typeof synth.resume === "function") {
            nudged = true;
            synth.pause();
            synth.resume();
            s.timer = setTimeout(watchStart, NUDGE_WAIT_MS);
            return;
        }
        finished = true;
        inFlight.delete(utterance);
        cancelSynth(synth);
        s.index += 1;
        setTimeout(() => speakChunk(s), CANCEL_SETTLE_MS);
    };
    s.timer = setTimeout(watchStart, START_TIMEOUT_MS);
    synth.speak(utterance);
}

/**
 * Speaks text and resolves when finished with { status, remaining }:
 *   status "done" | "stopped" (cancelled or replaced) | "failed" | "skipped" | "unavailable",
 *   remaining: the chunks not yet spoken (for "resume").
 * kind: "assistant" (Zoro), "announce" (status messages), "focus" (keyboard focus) or "hover".
 * `chunks` speaks prepared chunks as they are (used to resume).
 */
export function speakText(text, { fromAssistant = false, kind = fromAssistant ? "assistant" : "announce", chunks } = {}) {
    return new Promise((resolve) => {
        const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
        const parts = chunks || speechChunks(speakable(text));
        if (!parts.length || !synth || typeof window.SpeechSynthesisUtterance !== "function") return resolve({ status: "unavailable", remaining: [] });
        if (assistantBusy && kind !== "assistant") return resolve({ status: "skipped", remaining: [] });
        // Hovering never interrupts a message, Zoro, or the reading of a focused control.
        if (kind === "hover" && session && session.kind !== "hover") return resolve({ status: "skipped", remaining: [] });

        // Only speech the browser actually has needs cancelling.
        const busy = Boolean(session && session.issued) || synth.speaking || synth.pending;
        if (session) settle(session, "stopped");
        token += 1;
        const s = { token, kind, chunks: parts, index: 0, resolve, useVoice: true, done: false, timer: null };
        session = s;
        if (busy) cancelSynth(synth);
        if (synth.paused && typeof synth.resume === "function") synth.resume();
        const settling = Math.min(CANCEL_SETTLE_MS, lastCancelAt + CANCEL_SETTLE_MS - clock());
        if (settling > 0 || DEFERRED_KINDS.includes(kind)) setTimeout(() => speakChunk(s), Math.max(0, settling));
        else speakChunk(s);
    });
}

/** Stops all speech. */
export function cancelSpeech() {
    token += 1;
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    const active = Boolean(session && session.issued) || Boolean(synth && (synth.speaking || synth.pending));
    if (session) settle(session, "stopped");
    if (synth && active) cancelSynth(synth);
}

/** Stops speech only if it is hover reading (the mouse left the element). */
export function stopHoverSpeech() {
    if (session && session.kind === "hover") cancelSpeech();
}

/** Test helper: forget the queue, the last cancel and the voice in use. */
export function resetSpeechForTests() {
    token += 1;
    session = null;
    lastCancelAt = -Infinity;
    currentVoice = null;
    voices = [];
}

/** What is being spoken: null, or "assistant" | "announce" | "focus" | "hover". */
export function speakingKind() {
    return session ? session.kind : null;
}

export function setCustomSpeechEnabled(enabled) {
    customSpeechEnabled = Boolean(enabled);
    if (!customSpeechEnabled) cancelSpeech();
}

export function isCustomSpeechEnabled() {
    return customSpeechEnabled;
}

/** Announces a short status message (cart changes, errors, results). */
export function announce(text) {
    if (!text) return;
    if (customSpeechEnabled) speakText(text, { kind: "announce" });
    window.dispatchEvent(new CustomEvent("ANNOUNCE", { detail: { text, spoken: customSpeechEnabled } }));
}
