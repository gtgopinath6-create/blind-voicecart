/**
 * Zoro's listening state machine (pure reducer, no browser APIs).
 *
 *   DISABLED   speech recognition unsupported, or the microphone is blocked; only an explicit
 *              user action (mic button, Alt+V) tries again.
 *   IDLE       off. The microphone is not used.
 *   WAKE_WORD_LISTENING   only "Hey Zoro" is acted on (explicitly enabled by the shopper).
 *   COMMAND_LISTENING     a conversation is active and waiting for a request.
 *   PROCESSING            working on what was said (recognition off).
 *   AWAITING_CONFIRMATION a question was asked; the next utterance answers it.
 *   SPEAKING              Zoro is talking (recognition off, so it never hears itself).
 *   PAUSED     the conversation is kept but the microphone is released: after two minutes
 *              without activity, or while the shopper types a password.
 *   ERROR      a recoverable recognition problem; after saying so, Zoro listens again where it was.
 *
 * Typed text (the "Type to Zoro" box) and on-screen answers are handled exactly like speech.
 * REPLAY repeats or resumes Zoro's last reply, then returns to the same question.
 *
 *   IDLE/PAUSED/DISABLED ──ENABLE──▶ SPEAKING (greeting) ──▶ COMMAND_LISTENING ──TRANSCRIPT──▶ PROCESSING
 *        ▲                                ▲                       │ PAUSE (2 min)        │ OUTCOME
 *        │                                └──── done/ask ◀────────┼──────────────────────┘
 *        └──────────── DISABLE / stop outcome ────────────────────┘
 *
 * Speech is only acted on in COMMAND_LISTENING / AWAITING_CONFIRMATION, i.e. after an explicit
 * activation or the wake phrase.
 */

export const S = {
    DISABLED: "DISABLED",
    IDLE: "IDLE",
    WAKE_WORD_LISTENING: "WAKE_WORD_LISTENING",
    COMMAND_LISTENING: "COMMAND_LISTENING",
    PROCESSING: "PROCESSING",
    AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
    SPEAKING: "SPEAKING",
    PAUSED: "PAUSED",
    ERROR: "ERROR",
};

export const LISTENING_STATES = [S.WAKE_WORD_LISTENING, S.COMMAND_LISTENING, S.AWAITING_CONFIRMATION];
/** States in which a conversation is under way (the two-minute inactivity rule applies). */
export const SESSION_STATES = [S.COMMAND_LISTENING, S.PROCESSING, S.AWAITING_CONFIRMATION, S.SPEAKING];

export const WAKE_PHRASE = "Hey Zoro";
// What speech recognition commonly writes for "Hey Zoro".
export const WAKE_WORDS = ["hey zoro", "hey zorro", "hey soro", "hey zoru", "hey jorro", "hi zoro", "hi zorro", "hello zoro", "hello zorro", "ok zoro", "okay zoro"];

export const initialVoiceState = {
    status: S.IDLE,
    wakeWordMode: false,
    pending: null,
    afterSpeech: S.IDLE,
    pausedReason: null,
    message: 'Press the microphone button or Alt+V to talk to Zoro.',
    transcript: "",
    heard: null,        // { source: "voice" | "typed" | "button", confidence, alternatives } of the transcript
    commandId: 0,
    speakId: 0,         // changes with every reply, so a repeated reply is spoken and announced again
    speakChunks: null,  // resume: the part of a stopped reply still to say
    replay: false,
    resumeAfterError: null,
};

/** Returns the text after the wake phrase, or null if it is not present. */
export function stripWakeWord(text) {
    const lower = (text || "").toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ");
    for (const w of WAKE_WORDS) {
        const i = lower.indexOf(w);
        if (i !== -1 && (i === 0 || lower[i - 1] === " ")) return lower.slice(i + w.length).replace(/^[\s,.!?]+/, "").trim();
    }
    return null;
}

const restingState = (state) => (state.wakeWordMode ? S.WAKE_WORD_LISTENING : S.IDLE);
const speak = (state, message, afterSpeech, extra = {}) => ({
    ...state, status: S.SPEAKING, message, afterSpeech, transcript: "", speakId: state.speakId + 1, speakChunks: null, replay: false, ...extra,
});
const ANSWERING = [S.COMMAND_LISTENING, S.AWAITING_CONFIRMATION];

export function voiceReducer(state, event) {
    switch (event.type) {
        case "ENABLE":
            // Explicit user action (mic button, Alt+V): greet or acknowledge, then listen.
            if (SESSION_STATES.includes(state.status)) return state;
            return speak(state, event.message || "I'm listening. How can I help you?", S.COMMAND_LISTENING, { pending: null, pausedReason: null });

        case "DISABLE":
            return { ...state, status: S.IDLE, pending: null, transcript: "", wakeWordMode: false, pausedReason: null, message: event.message || "Zoro is off." };

        case "MIC_BLOCKED":
        case "UNSUPPORTED":
            return { ...state, status: S.DISABLED, pending: null, transcript: "", wakeWordMode: false, pausedReason: null, message: event.message || "Voice input is not available." };

        case "SET_WAKE_WORD_MODE": {
            const next = { ...state, wakeWordMode: event.enabled };
            if (event.enabled && (state.status === S.IDLE || state.status === S.PAUSED)) {
                return { ...next, status: S.WAKE_WORD_LISTENING, pausedReason: null, message: `Listening for "${WAKE_PHRASE}".` };
            }
            if (!event.enabled && state.status === S.WAKE_WORD_LISTENING) {
                return { ...next, status: S.IDLE, message: "Wake phrase listening is off." };
            }
            return next;
        }

        case "INTERIM":
            if (!LISTENING_STATES.includes(state.status)) return state;
            return { ...state, transcript: event.text };

        case "WAKE":
            if (state.status !== S.WAKE_WORD_LISTENING) return state;
            return speak(state, event.message || "I'm listening. How can I help you?", S.COMMAND_LISTENING, { pending: null });

        case "WAKE_WITH_COMMAND":
            if (state.status !== S.WAKE_WORD_LISTENING) return state;
            return { ...state, status: S.PROCESSING, transcript: event.text, heard: event.heard || { source: "voice" }, commandId: state.commandId + 1, message: "Working on it..." };

        case "TRANSCRIPT":
            // Ignored unless the shopper activated Zoro (mic button, Alt+V or the wake phrase).
            if (!ANSWERING.includes(state.status)) return state;
            if (!event.text || !event.text.trim()) return state;
            return { ...state, status: S.PROCESSING, transcript: event.text, heard: event.heard || { source: "voice" }, commandId: state.commandId + 1, message: "Working on it..." };

        case "TYPED":
            // Typed text answers like speech; typing while Zoro talks interrupts the reply.
            if (!event.text || !event.text.trim()) return state;
            if (!ANSWERING.includes(state.status) && !(state.status === S.SPEAKING && ANSWERING.includes(state.afterSpeech))) return state;
            return { ...state, status: S.PROCESSING, transcript: event.text.trim(), heard: { source: "typed" }, commandId: state.commandId + 1, message: "Working on it..." };

        case "REPLAY":
            // Repeat (or resume) the last reply, then wait for the same answer as before.
            if (!ANSWERING.includes(state.status) || !event.message) return state;
            return speak(state, event.message, state.status, { pending: state.pending, speakChunks: event.chunks || null, replay: true });

        case "OUTCOME": {
            // Results of a cancelled or superseded command are dropped.
            if (state.status !== S.PROCESSING || event.commandId !== state.commandId) return state;
            const { outcome } = event;
            if (outcome.type === "resume") return speak(state, outcome.message, outcome.after, { pending: outcome.after === S.AWAITING_CONFIRMATION ? state.pending : null, speakChunks: outcome.chunks, replay: true });
            if (outcome.type === "stop") return speak(state, outcome.message, S.IDLE, { pending: null, wakeWordMode: false });
            if (outcome.type === "ask") return speak(state, outcome.message, S.AWAITING_CONFIRMATION, { pending: outcome.pending || null });
            if (outcome.type === "keyboard") return speak(state, outcome.message, S.PAUSED, { pending: null, pausedReason: "keyboard" });
            // The conversation continues: listen for the next request.
            return speak(state, outcome.message, S.COMMAND_LISTENING, { pending: null });
        }

        case "SAY":
            // Something to tell the shopper outside a command (sign-in result, resume).
            return speak(state, event.message, event.after || S.COMMAND_LISTENING, { pending: event.pending || null, pausedReason: null });

        case "PAUSE":
            // Two minutes without activity, or the tab was left: release the microphone but keep the conversation.
            if (!SESSION_STATES.includes(state.status)) return state;
            return speak(state, event.message, state.wakeWordMode ? S.WAKE_WORD_LISTENING : S.PAUSED, { pending: null, pausedReason: event.reason || "inactivity" });

        case "SPEECH_DONE":
            if (state.status !== S.SPEAKING) return state;
            return { ...state, status: state.afterSpeech, transcript: "" };

        case "ERROR": {
            // A problem while listening: say it, then listen again for the same answer.
            const resume = ANSWERING.includes(state.status) ? state.status : null;
            return { ...state, status: S.ERROR, pending: resume ? state.pending : null, message: event.message, resumeAfterError: resume, speakId: state.speakId + 1 };
        }

        case "RECOVER":
            if (state.status !== S.ERROR) return state;
            return { ...state, status: state.resumeAfterError || restingState(state), resumeAfterError: null };

        default:
            return state;
    }
}
