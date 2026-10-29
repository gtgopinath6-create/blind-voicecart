// Speech preferences shared by Zoro's listening (speechInput) and speaking (announcer), remembered on
// this device only. Nothing here is sent anywhere.

function read(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

function write(key, value) {
    try {
        if (value === null || value === undefined || value === "") localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
    } catch (e) {
        // not saved (private mode); the setting still applies until the page is closed
    }
}

/**
 * English variants offered for speech recognition and for choosing a voice. Indian English is the
 * default. Which of these a browser actually supports is only known when recognition starts: an
 * unsupported one is reported, and the shopper can pick another.
 */
export const SPEECH_LANGUAGES = [
    { code: "en-IN", label: "English (India)" },
    { code: "en-US", label: "English (United States)" },
    { code: "en-GB", label: "English (United Kingdom)" },
    { code: "en-AU", label: "English (Australia)" },
    { code: "en-CA", label: "English (Canada)" },
    { code: "en-IE", label: "English (Ireland)" },
    { code: "en-NZ", label: "English (New Zealand)" },
    { code: "en-ZA", label: "English (South Africa)" },
];
export const DEFAULT_LANGUAGE = "en-IN";

const LANG_KEY = "vc-speech-lang";
let language = (() => {
    const saved = read(LANG_KEY);
    return SPEECH_LANGUAGES.some((l) => l.code === saved) ? saved : DEFAULT_LANGUAGE;
})();

export function getSpeechLanguage() {
    return language;
}

export function setSpeechLanguage(code) {
    language = SPEECH_LANGUAGES.some((l) => l.code === code) ? code : DEFAULT_LANGUAGE;
    write(LANG_KEY, language === DEFAULT_LANGUAGE ? null : language);
    return language;
}

/**
 * How long Zoro waits after the shopper stops talking before it treats the sentence as finished.
 * Longer suits people who pause between words; shorter answers faster.
 */
export const PAUSE_OPTIONS = [
    { value: "short", label: "Short", ms: 500 },
    { value: "normal", label: "Normal", ms: 900 },
    { value: "long", label: "Long", ms: 1800 },
];
const PAUSE_KEY = "vc-listen-pause";
let pause = (() => {
    const saved = read(PAUSE_KEY);
    return PAUSE_OPTIONS.some((p) => p.value === saved) ? saved : "normal";
})();

export function getListeningPause() {
    return pause;
}

export function setListeningPause(value) {
    pause = PAUSE_OPTIONS.some((p) => p.value === value) ? value : "normal";
    write(PAUSE_KEY, pause === "normal" ? null : pause);
    return pause;
}

export const pauseMs = (value = pause) => (PAUSE_OPTIONS.find((p) => p.value === value) || PAUSE_OPTIONS[1]).ms;

/**
 * Which speech-to-text engine transcribes a spoken command (not the "Hey Zoro" wake word, which
 * always needs the browser's own continuous recognition and has no Whisper equivalent):
 *   "automatic": the browser's own recognition (Web Speech API) when this browser has it, else Whisper.
 *   "webspeech": always the browser's own recognition; command mode falls back to typing where unsupported.
 *   "whisper":   always upload the recording to the server's Whisper endpoint, even where Web Speech API exists.
 * REACT_APP_VOICE_STT_MODE overrides this app-wide (for rollout testing), taking the same three values.
 */
export const STT_ENGINES = [
    { value: "automatic", label: "Automatic (recommended)" },
    { value: "webspeech", label: "This browser's speech recognition" },
    { value: "whisper", label: "Server transcription (Whisper)" },
];
const STT_KEY = "vc-stt-engine";
const sttOverride = (process.env.REACT_APP_VOICE_STT_MODE || "").trim().toLowerCase();
/** True when REACT_APP_VOICE_STT_MODE forces one engine app-wide, so the per-device choice is moot. */
export const sttEngineOverridden = STT_ENGINES.some((e) => e.value === sttOverride);
let sttEngine = (() => {
    if (STT_ENGINES.some((e) => e.value === sttOverride)) return sttOverride;
    const saved = read(STT_KEY);
    return STT_ENGINES.some((e) => e.value === saved) ? saved : "automatic";
})();

export function getSttEngine() {
    return sttEngine;
}

export function setSttEngine(value) {
    // An app-wide override always wins, so a stored per-device choice can't fight a rollout setting.
    if (STT_ENGINES.some((e) => e.value === sttOverride)) return sttOverride;
    sttEngine = STT_ENGINES.some((e) => e.value === value) ? value : "automatic";
    write(STT_KEY, sttEngine === "automatic" ? null : sttEngine);
    return sttEngine;
}

/** Zoro's spoken replies muted (they are still shown, and read by a native screen reader). */
const MUTE_KEY = "vc-zoro-muted";
let muted = read(MUTE_KEY) === "true";

export function isZoroMuted() {
    return muted;
}

export function setZoroMuted(value) {
    muted = Boolean(value);
    write(MUTE_KEY, muted ? "true" : null);
    return muted;
}

/** Test helper: back to the defaults, without touching storage. */
export function resetSpeechSettingsForTests() {
    language = DEFAULT_LANGUAGE;
    pause = "normal";
    muted = false;
    sttEngine = STT_ENGINES.some((e) => e.value === sttOverride) ? sttOverride : "automatic";
}
