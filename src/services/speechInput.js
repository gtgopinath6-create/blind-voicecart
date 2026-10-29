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
import { uploadAudio } from "./apiClient";

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

/**
 * Zoro's microphone input via server-side transcription (Groq Whisper), used for command mode only
 * (mic button, Alt+V, or a spoken command right after "Hey Zoro"). "Hey Zoro" itself always needs
 * the browser's own continuous recognition (startRecognitionSession above) to listen passively, so
 * this is never used for mode "wake".
 *
 * One utterance: record from the microphone, detect when the shopper stops talking by audio level
 * (there is no server round trip until recording ends), then upload the clip and transcribe it.
 * The result is delivered through the same onUtterance({ text, alternatives, confidence }) shape as
 * startRecognitionSession, so nothing downstream (voiceMachine, zoroDialogue, voiceActions) needs to
 * know which engine produced the text.
 */

/** Whisper reports no per-word confidence; this fixed value is well above LOW_CONFIDENCE (0.5) in
 * zoroDialogue.js, so a correctly transcribed short answer is not needlessly asked again. It is a
 * guess, not a measurement: a genuinely low-confidence Whisper transcription still looks confident. */
export const WHISPER_CONFIDENCE = 0.9;

/** One recorded utterance never runs longer than this before it is sent for transcription. */
export const MAX_WHISPER_UTTERANCE_MS = 12000;
/** How long of silence, after speech was heard, ends the recording. */
const WHISPER_SILENCE_MS = 1200;
/** Nothing heard at all within this long: give up quietly, like the Web Speech API's "no-speech". */
const WHISPER_NO_SPEECH_MS = 6000;
/** 0-255 input level (MediaStreamTrack mic gain varies by device) above which audio counts as speech. */
const WHISPER_VOICE_LEVEL = 12;
/** How often the microphone's volume is sampled to detect speech and silence. */
const WHISPER_POLL_MS = 100;

const WHISPER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pickWhisperMimeType() {
    const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported;
    if (!supported) return "";
    return WHISPER_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

/** True when this browser can record and upload audio for Whisper transcription. */
export function whisperCaptureSupported() {
    return Boolean(
        typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
        typeof MediaRecorder !== "undefined"
    );
}

/** getUserMedia/MediaRecorder failures, in the vocabulary transcriptionProblem() understands. */
function mediaErrorCode(e) {
    switch (e && e.name) {
        case "NotAllowedError":
        case "SecurityError":
            return "not-allowed";
        case "NotFoundError":
        case "NotReadableError":
            return "audio-capture";
        default:
            return "other";
    }
}

/** An uploaded-transcription failure (apiClient's ApiError codes), in the same vocabulary. */
function uploadErrorCode(e) {
    const code = e && e.code;
    if (code === "network" || code === "timeout") return "network";
    if (code === "ai_not_configured") return "not-configured";
    if (code === "ai_rate_limited" || code === "ai_unavailable") return "unavailable";
    return "other";
}

/**
 * Plain-language messages for Whisper capture/upload problems, in the same { kind, fatal, counts,
 * reason, message } shape as recognitionProblem() (see GlobalAIVoiceAssistant.js's onError, which
 * handles both the same way). "no speech at all" ends quietly without calling this, like the Web
 * Speech API's "no-speech".
 */
export function transcriptionProblem(code) {
    switch (code) {
        case "not-allowed":
            return { kind: "blocked", fatal: true, message: "Microphone access is blocked. Allow the microphone for this site in your browser settings, then press the microphone button again. You can also type to Zoro." };
        case "audio-capture":
            return { kind: "microphone", counts: true, reason: "I can't hear a microphone", message: "I can't hear a microphone. Check that one is connected and not being used by another app." };
        case "network":
            return { kind: "network", counts: true, reason: "the connection to the transcription service failed", message: "Could not reach the server to transcribe your voice. Check your connection, or type to Zoro." };
        case "not-configured":
            return { kind: "service", fatal: true, message: "Voice transcription isn't set up on this server, so Zoro can't listen here. You can type to Zoro instead." };
        case "unavailable":
            return { kind: "other", counts: true, reason: "the voice transcription service is unavailable", message: "The voice transcription service is busy or unavailable right now. Please try again, or type to Zoro." };
        default:
            return { kind: "other", counts: true, reason: "voice transcription reported a problem", message: "Voice input had a problem. Please try again, or type to Zoro." };
    }
}

/**
 * Starts one Whisper recording session and returns { rec: null, stop(), abort() }, matching the
 * shape startRecognitionSession returns so the caller does not need to branch on which engine ran.
 * mode is always "command": only one utterance is ever delivered, then the session ends.
 */
export function startWhisperSession({
    onUtterance, onInterim, onAudio, onError, onEnd,
    silenceMs = WHISPER_SILENCE_MS, noSpeechMs = WHISPER_NO_SPEECH_MS, maxMs = MAX_WHISPER_UTTERANCE_MS,
    voiceLevel = WHISPER_VOICE_LEVEL, pollMs = WHISPER_POLL_MS,
} = {}) {
    let closed = false;
    let stream = null;
    let audioCtx = null;
    let recorder = null;
    let chunks = [];
    let silenceTimer = null;
    let noSpeechTimer = null;
    let maxTimer = null;
    let pollTimer = null;
    let heardVoice = false;
    let endedReported = false;

    const clearTimers = () => {
        clearTimeout(silenceTimer);
        clearTimeout(noSpeechTimer);
        clearTimeout(maxTimer);
        clearInterval(pollTimer);
        silenceTimer = null;
        noSpeechTimer = null;
        maxTimer = null;
        pollTimer = null;
    };

    const teardownMedia = () => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        if (audioCtx) { try { audioCtx.close(); } catch (e) { /* already closed */ } }
        audioCtx = null;
    };

    const finish = ({ heardAudio }) => {
        if (endedReported) return;
        endedReported = true;
        clearTimers();
        teardownMedia();
        if (onAudio) onAudio(false);
        if (onEnd) onEnd({ heardAudio });
    };

    async function upload(blob) {
        if (closed) return;
        try {
            const { text } = await uploadAudio(blob);
            if (closed) return;
            const trimmed = (text || "").trim();
            if (trimmed && onUtterance) onUtterance({ text: trimmed, alternatives: [trimmed], confidence: WHISPER_CONFIDENCE });
        } catch (e) {
            if (!closed && onError) onError(uploadErrorCode(e));
        } finally {
            finish({ heardAudio: heardVoice });
        }
    }

    function stopRecording() {
        clearTimers();
        if (recorder && recorder.state !== "inactive") {
            try { recorder.stop(); } catch (e) { finish({ heardAudio: heardVoice }); }
        } else {
            finish({ heardAudio: heardVoice });
        }
    }

    (async () => {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            if (onError) onError(mediaErrorCode(e));
            finish({ heardAudio: false });
            return;
        }
        if (closed) { teardownMedia(); return; }

        const mimeType = pickWhisperMimeType();
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (e) {
            if (onError) onError("other");
            finish({ heardAudio: false });
            return;
        }
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
            chunks = [];
            if (!heardVoice || blob.size === 0) { finish({ heardAudio: heardVoice }); return; }
            upload(blob);
        };
        recorder.start();
        if (onAudio) onAudio(true);

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const analyser = (() => {
            try {
                audioCtx = new AudioCtx();
                const source = audioCtx.createMediaStreamSource(stream);
                const node = audioCtx.createAnalyser();
                node.fftSize = 512;
                source.connect(node);
                return node;
            } catch (e) {
                return null; // Volume detection unavailable; the max-duration cap still ends the recording.
            }
        })();

        noSpeechTimer = setTimeout(() => {
            if (!heardVoice) stopRecording(); // nothing said at all: end quietly, like "no-speech"
        }, noSpeechMs);
        maxTimer = setTimeout(stopRecording, maxMs);

        if (analyser) {
            const data = new Uint8Array(analyser.frequencyBinCount);
            pollTimer = setInterval(() => {
                if (closed || !audioCtx) return;
                analyser.getByteTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
                const level = sum / data.length;
                if (level >= voiceLevel) {
                    if (!heardVoice) {
                        heardVoice = true;
                        clearTimeout(noSpeechTimer);
                        noSpeechTimer = null;
                    }
                    clearTimeout(silenceTimer);
                    silenceTimer = setTimeout(stopRecording, silenceMs);
                }
            }, pollMs);
        }
    })();

    return {
        rec: null,
        stop: stopRecording,
        abort() {
            closed = true;
            clearTimers();
            if (recorder && recorder.state !== "inactive") {
                recorder.onstop = null;
                try { recorder.stop(); } catch (e) { /* already stopped */ }
            }
            teardownMedia();
        },
    };
}
