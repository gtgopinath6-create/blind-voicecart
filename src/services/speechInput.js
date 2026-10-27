/**
 * Zoro's microphone input, on top of the browser's speech recognition (Web Speech API).
 *
 * Recognition runs in continuous mode and Zoro decides when the shopper has finished speaking: a
 * short pause (the "listening pause" setting) after the last recognised words. In single-utterance
 * mode browsers end the session at the first brief pause, so "I'm looking for ... black shoes" was
 * acted on as "I'm looking for" and the rest was lost.
 *
 * Only final results are acted on. Interim words are shown while the shopper speaks but are never
 * treated as a command; when the browser is slow to finalise them, Zoro asks it to (stop()), which
 * returns the final result, and does not use the interim text itself.
 *
 * Each finished utterance is { text, alternatives, confidence }:
 *   alternatives: other ways the browser heard a single-phrase answer (best first), used only to
 *                 understand an answer that is read back before anything happens;
 *   confidence:   the lowest confidence the browser reported (0 to 1), or null when it reported none.
 */

/** Browsers name it differently (Chrome and Safari use the webkit prefix). */
export function getRecognitionClass() {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export const MAX_ALTERNATIVES = 3;
/** After words that are still interim, how long to wait before asking the browser to finalise them. */
export const INTERIM_SETTLE_MS = 2500;
/** A single utterance never runs longer than this; then it is finalised. */
export const MAX_UTTERANCE_MS = 30000;

const comparable = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9@ ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Adds a newly final segment to what was heard. Some browsers (Chrome on Android) repeat the whole
 * utterance in every new final result; that repetition replaces the text instead of doubling it.
 */
export function mergeSegment(buffer, segment) {
    const a = comparable(buffer);
    const b = comparable(segment);
    if (!a) return String(segment || "").trim();
    if (!b) return String(buffer || "").trim();
    if (b.startsWith(a)) return String(segment).trim();
    if (a.endsWith(b)) return String(buffer).trim();
    return `${String(buffer).trim()} ${String(segment).trim()}`;
}

/**
 * Plain-language messages for recognition errors (never the raw error code).
 *   fatal: listening cannot continue until the shopper changes something;
 *   counts: a transient problem; several in a row turn voice input off (reason says why, briefly).
 * "no-speech" and "aborted" are normal (silence, or Zoro stopped listening) and return null.
 */
export function recognitionProblem(code, languageLabel = "this language") {
    switch (code) {
        case "no-speech":
        case "aborted":
            return null;
        case "not-allowed":
            return { kind: "blocked", fatal: true, message: "Microphone access is blocked. Allow the microphone for this site in your browser settings, then press the microphone button again. You can also type to Zoro." };
        case "service-not-allowed":
            return { kind: "service", fatal: true, message: "Speech recognition is turned off in this browser, so Zoro can't listen. You can type to Zoro instead." };
        case "language-not-supported":
            return { kind: "language", fatal: true, message: `This browser can't recognise ${languageLabel}. Choose another English in Zoro's listening settings, or type to Zoro.` };
        case "audio-capture":
            return { kind: "microphone", counts: true, reason: "I can't hear a microphone", message: "I can't hear a microphone. Check that one is connected and not being used by another app." };
        case "network":
            return { kind: "network", counts: true, reason: "speech recognition can't reach the internet", message: "Speech recognition needs an internet connection in this browser. Check your connection, or type to Zoro." };
        default:
            return { kind: "other", counts: true, reason: "the browser's speech recognition reported a problem", message: "Voice input had a problem. Please try again, or type to Zoro." };
    }
}

/**
 * Starts one recognition session and returns { rec, stop(), abort() }.
 *   mode "command": the first finished utterance is delivered, then the session ignores the rest
 *                   (the assistant stops it while it thinks and speaks).
 *   mode "wake":    every finished utterance is delivered and the session keeps running.
 * handlers: onUtterance({ text, alternatives, confidence }) -> false to ignore it and keep listening,
 *           onInterim(text), onAudio(on), onError(code), onEnd({ heardAudio })
 */
export function startRecognitionSession(Recognition, { lang, mode = "command", pauseMs = 900, onUtterance, onInterim, onAudio, onError, onEnd } = {}) {
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = MAX_ALTERNATIVES;
    rec.lang = lang;

    let segments = [];         // final segments: { text, alternatives, confidence }
    let interim = "";
    const finalIndexes = new Set();
    let settleTimer = null;
    let longTimer = null;
    let closed = false;        // nothing more is delivered
    let delivered = false;
    let heardAudio = false;

    const heard = () => segments.reduce((text, s) => mergeSegment(text, s.text), "");
    const clearTimers = () => {
        clearTimeout(settleTimer);
        clearTimeout(longTimer);
        settleTimer = null;
        longTimer = null;
    };

    function deliver() {
        clearTimers();
        const text = heard().trim();
        const single = segments.length === 1 ? segments[0] : null;
        const known = segments.map((s) => s.confidence).filter((c) => typeof c === "number" && c > 0);
        const utterance = {
            text,
            alternatives: single ? single.alternatives : [text],
            confidence: known.length ? Math.min(...known) : null,
        };
        segments = [];
        interim = "";
        if (!text) return;
        // The listener returns false for words it does not act on (Zoro's own voice, "Hey Zoro" alone):
        // the session then keeps listening for the shopper.
        const accepted = onUtterance ? onUtterance(utterance) !== false : true;
        if (mode !== "wake" && accepted) { closed = true; delivered = true; }
    }

    function flush() {
        // Ask the browser for the final result of what it is still processing; onresult/onend follow.
        clearTimers();
        try { rec.stop(); } catch (e) { deliver(); }
    }

    function schedule() {
        clearTimeout(settleTimer);
        if (interim) settleTimer = setTimeout(flush, Math.max(pauseMs, INTERIM_SETTLE_MS));
        else if (segments.length) settleTimer = setTimeout(deliver, pauseMs);
        if (!longTimer && (interim || segments.length)) longTimer = setTimeout(flush, MAX_UTTERANCE_MS);
    }

    rec.onresult = (event) => {
        if (closed) return;
        let pending = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (!result || !result[0]) continue;
            if (!result.isFinal) {
                pending += `${result[0].transcript} `;
                continue;
            }
            if (finalIndexes.has(i)) continue; // the same final result delivered twice
            finalIndexes.add(i);
            const alternatives = [];
            for (let k = 0; k < result.length && k < MAX_ALTERNATIVES; k++) {
                const t = String(result[k].transcript || "").trim();
                if (t && !alternatives.some((a) => comparable(a) === comparable(t))) alternatives.push(t);
            }
            if (alternatives.length) segments.push({ text: alternatives[0], alternatives, confidence: result[0].confidence });
        }
        interim = pending.trim();
        if (onInterim) onInterim(interim ? mergeSegment(heard(), interim) : heard());
        schedule();
    };

    rec.onerror = (event) => {
        if (closed && delivered) return;
        if (onError) onError(event && event.error);
    };
    rec.onstart = () => {
        if (onAudio) onAudio(true);
    };
    rec.onaudiostart = () => {
        heardAudio = true;
        if (onAudio) onAudio(true);
    };
    rec.onaudioend = () => {
        if (onAudio) onAudio(false);
    };
    rec.onend = () => {
        clearTimers();
        // Final words heard before the browser ended the session still count; interim words do not.
        if (!closed && segments.length) deliver();
        closed = true;
        if (onAudio) onAudio(false);
        if (onEnd) onEnd({ heardAudio });
    };

    return {
        rec,
        stop: flush,
        abort() {
            closed = true;
            clearTimers();
            rec.onresult = null;
            rec.onerror = null;
            rec.onend = null;
            rec.onstart = null;
            rec.onaudiostart = null;
            rec.onaudioend = null;
            try { rec.abort(); } catch (e) { /* already stopped */ }
        },
    };
}
