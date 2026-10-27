// Speech output: voice choice, speakable text, chunks, one speaker at a time, and failures.
// Each test loads a fresh copy of the module, because it keeps the voice and queue in memory.

// Voices as Chrome lists them on a Mac (names and languages from a real Chrome voice list; the
// first call to getVoices() returns none, and "voiceschanged" fires when they have loaded).
const MAC_VOICES = [
    { name: "Rishi", lang: "en-IN", localService: true, default: true, voiceURI: "Rishi" },
    { name: "Albert", lang: "en-US", localService: true, voiceURI: "Albert" },
    { name: "Bad News", lang: "en-US", localService: true, voiceURI: "Bad News" },
    { name: "Daniel", lang: "en-GB", localService: true, voiceURI: "Daniel" },
    { name: "Eddy (English (United States))", lang: "en-US", localService: true, voiceURI: "Eddy-US" },
    { name: "Samantha", lang: "en-US", localService: true, voiceURI: "Samantha" },
    { name: "Zarvox", lang: "en-US", localService: true, voiceURI: "Zarvox" },
    { name: "Google US English", lang: "en-US", localService: false, voiceURI: "Google US English" },
    { name: "Google UK English Female", lang: "en-GB", localService: false, voiceURI: "Google UK English Female" },
    { name: "Google हिन्दी", lang: "hi-IN", localService: false, voiceURI: "Google hi" },
];

let synth;
let spoken;
let listeners;
function installSynth({ voices = MAC_VOICES, loaded = true } = {}) {
    spoken = [];
    listeners = {};
    let available = loaded ? voices : [];
    synth = {
        speaking: false,
        pending: false,
        paused: false,
        speak: jest.fn((u) => { spoken.push(u); synth.speaking = true; if (!synth.dropNext) { if (u.onstart) u.onstart(); } else synth.dropNext -= 1; }),
        cancel: jest.fn(() => { synth.speaking = false; }),
        resume: jest.fn(),
        getVoices: () => available,
        addEventListener: (name, fn) => { listeners[name] = fn; },
        load(next) { available = next; listeners.voiceschanged && listeners.voiceschanged(); },
    };
    window.speechSynthesis = synth;
    window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
}
const texts = () => spoken.map((u) => u.text);
const end = (u = spoken[spoken.length - 1]) => { synth.speaking = false; u.onend(); };

let A;
let settings;
beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    installSynth();
    jest.isolateModules(() => {
        A = require("../announcer");
        settings = require("../speechSettings");
    });
    A.watchVoices();
});
afterEach(() => jest.useRealTimers());

describe("voice choice", () => {
    test("Indian English is chosen when installed; novelty voices are never chosen", () => {
        expect(A.activeVoice().name).toBe("Rishi");
        expect(A.pickVoice(MAC_VOICES, "en-US").name).toBe("Samantha");
        expect(A.pickVoice(MAC_VOICES.filter((v) => v.name !== "Samantha"), "en-US").name).toBe("Google US English");
        expect(A.pickVoice([MAC_VOICES[1], MAC_VOICES[2], MAC_VOICES[6]], "en-US")).toBeNull();
        expect(A.englishVoices("en-IN").map((v) => v.label)).not.toContain("Zarvox (en-US)");
    });

    test("without an Indian English voice, British English comes next, then American", () => {
        const noIndian = MAC_VOICES.filter((v) => v.lang !== "en-IN");
        expect(A.pickVoice(noIndian, "en-IN").name).toBe("Daniel");
        expect(A.pickVoice(noIndian.filter((v) => v.lang !== "en-GB"), "en-IN").name).toBe("Samantha");
    });

    test("higher-quality natural voices win over older ones in the same language (Edge on Windows)", () => {
        const windows = [
            { name: "Microsoft Heera - English (India)", lang: "en-IN", localService: true, voiceURI: "Heera" },
            { name: "Microsoft Neerja Online (Natural) - English (India)", lang: "en-IN", localService: false, voiceURI: "Neerja" },
        ];
        expect(A.pickVoice(windows, "en-IN").name).toMatch(/Neerja/);
    });

    test("a chosen voice is used; a chosen voice that is not installed falls back to the best match", () => {
        A.setChosenVoice("Daniel");
        expect(A.activeVoice().name).toBe("Daniel");
        A.setChosenVoice("Some Voice From Another Computer");
        expect(A.activeVoice().name).toBe("Rishi");
    });

    test("voices that load late are picked up, and the voice then stays the same for the conversation", () => {
        installSynth({ loaded: false });
        jest.isolateModules(() => { A = require("../announcer"); });
        A.watchVoices();
        A.speakText("Hello.", { fromAssistant: true });
        expect(spoken[0].voice).toBeUndefined(); // nothing installed yet: the browser default
        expect(spoken[0].lang).toBe("en-IN");
        end();
        synth.load(MAC_VOICES); // "voiceschanged"
        A.speakText("Which colour would you like?", { fromAssistant: true });
        expect(spoken[1].voice.name).toBe("Rishi");
        end();
        // A better-ranked voice appearing later does not switch voices mid-conversation.
        synth.load([{ name: "Neerja (Natural)", lang: "en-IN", localService: true, voiceURI: "Neerja" }, ...MAC_VOICES]);
        A.speakText("You selected size 9.", { fromAssistant: true });
        expect(spoken[2].voice.name).toBe("Rishi");
    });

    test("the voice follows the chosen language", () => {
        settings.setSpeechLanguage("en-US");
        A.resetVoice();
        expect(A.activeVoice().name).toBe("Samantha");
    });
});

describe("speakable text", () => {
    test("prices, sizes and symbols are written so every voice reads them the same way", () => {
        expect(A.speakable("Option 1: Nike Air Max, ₹4,999.")).toBe("Option 1: Nike Air Max, 4999 rupees.");
        expect(A.speakable("The total is ₹1,49,999 and ₹49.50 tax.")).toBe("The total is 149999 rupees and 49 rupees 50 paise tax.");
        expect(A.speakable("₹1")).toBe("1 rupee");
        expect(A.speakable("iPhone 13 Pro, 128 GB")).toBe("iPhone 13 Pro, 128 gigabytes");
        expect(A.speakable("You usually wear UK 9.5.")).toBe("You usually wear U K 9.5.");
        expect(A.speakable('Say "yes, place order" (or "no").')).toBe("Say yes, place order, or no.");
        expect(A.speakable("H & M, e.g. a hoodie")).toBe("H and M, for example a hoodie");
        expect(A.speakable("See https://example.com/x?token=abc for details.")).toBe("See for details.");
    });

    test("short replies are one piece; long ones are split into whole sentences, never inside a number", () => {
        expect(A.speechChunks("Opening shoes.")).toEqual(["Opening shoes."]);
        const list = "I found 3 matching options. Option 1: Nike Air Force 1, black, size 9.5, 9000 rupees. Option 2: Vans Old Skool, black, size 9.5, 5000 rupees. Option 3: Puma Lex, grey, size 9.5, 5099 rupees. Which option would you like?";
        const chunks = A.speechChunks(list);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((c) => c.length <= A.MAX_CHUNK)).toBe(true);
        expect(chunks.join(" ")).toBe(list);
        expect(chunks.some((c) => /size 9\.$/.test(c))).toBe(false);
        const long = Array.from({ length: 30 }, (_, i) => `item ${i}`).join(", ");
        expect(A.speechChunks(long).every((c) => c.length <= A.MAX_CHUNK)).toBe(true);
    });
});

describe("speaking", () => {
    test("rate, pitch and volume are set on every part; normal speed is 0.95", async () => {
        expect(A.changeSpeechRate("normal")).toBe(0.95);
        A.speakText("Hello.", { fromAssistant: true });
        expect(spoken[0]).toMatchObject({ rate: 0.95, pitch: 1, volume: 1, lang: "en-IN" });
        end();
        expect(A.changeSpeechRate("slower")).toBe(0.8);
        A.speakText("Hello again.", { fromAssistant: true });
        expect(spoken[1].rate).toBe(0.8);
    });

    test("a long reply is spoken one part after another, and resolves once at the end", async () => {
        const reply = "I found 3 matching options. Option 1: Nike Air Force 1, black, size 9, 9000 rupees. Option 2: Vans Old Skool, black, size 9, 5000 rupees. Option 3: Puma Lex, grey, size 9, 5099 rupees. Which option would you like?";
        const done = jest.fn();
        A.speakText(reply, { fromAssistant: true }).then(done);
        const parts = A.speechChunks(reply).length;
        for (let i = 0; i < parts; i++) {
            expect(spoken).toHaveLength(i + 1); // never two parts queued at once
            end();
        }
        await Promise.resolve();
        expect(done).toHaveBeenCalledWith({ status: "done", remaining: [] });
        expect(texts().join(" ")).toBe(reply);
    });

    test("stopping returns what was not said yet, so the reply can be resumed from there", async () => {
        const reply = "Here are options 1 to 3 of 9. Option 1: Nike Air Force 1, black, size 9, 9000 rupees. Option 2: Vans Old Skool, black, size 9, 5000 rupees. Say more options to hear more.";
        let result;
        A.speakText(reply, { fromAssistant: true }).then((r) => { result = r; });
        end();
        A.cancelSpeech();
        await Promise.resolve();
        expect(synth.cancel).toHaveBeenCalled();
        expect(result.status).toBe("stopped");
        expect(result.remaining.length).toBeGreaterThan(0);
        spoken = [];
        A.speakText(result.remaining.join(" "), { fromAssistant: true, chunks: result.remaining });
        jest.advanceTimersByTime(60); // the pause after a cancel
        expect(texts()[0]).toBe(result.remaining[0]);
    });

    test("a new message replaces the one being spoken; the two never overlap", async () => {
        let first;
        A.speakText("A long first message that is still being spoken.", { fromAssistant: true }).then((r) => { first = r; });
        A.speakText("Second message.", { fromAssistant: true });
        await Promise.resolve();
        expect(first.status).toBe("stopped");
        expect(synth.cancel).toHaveBeenCalledTimes(1);
        expect(texts()).toEqual(["A long first message that is still being spoken."]); // the second waits for cancel to settle
        jest.advanceTimersByTime(60);
        expect(texts()).toEqual(["A long first message that is still being spoken.", "Second message."]);
        // The cancelled first part ending late does not start anything else.
        spoken[0].onerror({ error: "interrupted" });
        expect(spoken).toHaveLength(2);
    });

    test("hovering never interrupts a message or Zoro, and moving away stops only hover reading", () => {
        A.speakText("Added to your cart.", { kind: "announce" });
        A.speakText("Nike Air Force 1", { kind: "hover" });
        expect(texts()).toEqual(["Added to your cart."]);
        A.stopHoverSpeech();
        expect(synth.cancel).not.toHaveBeenCalled();
        end();
        A.speakText("Vans Old Skool", { kind: "hover" });
        jest.advanceTimersByTime(0); // hover and focus reading start on the next tick
        expect(texts()).toEqual(["Added to your cart.", "Vans Old Skool"]);
        expect(A.speakingKind()).toBe("hover");
        A.stopHoverSpeech();
        expect(synth.cancel).toHaveBeenCalledTimes(1);
        expect(A.speakingKind()).toBeNull();
    });

    test("focus reading cancelled in the same moment never reaches the browser (Chrome would get stuck)", () => {
        A.speakText("Talk to Zoro voice assistant, Alt+V", { kind: "focus" });
        A.cancelSpeech();
        A.speakText("Hello! I'm Zoro.", { fromAssistant: true });
        jest.advanceTimersByTime(100);
        expect(texts()).toEqual(["Hello! I'm Zoro."]);
        expect(synth.cancel).not.toHaveBeenCalled();
    });

    test("while Zoro is busy, page speech waits; Zoro itself still speaks", async () => {
        A.setAssistantBusy(true);
        expect(await A.speakText("Search box", { kind: "focus" })).toEqual({ status: "skipped", remaining: [] });
        A.speakText("Which colour would you like?", { fromAssistant: true });
        expect(texts()).toEqual(["Which colour would you like?"]);
        A.setAssistantBusy(false);
    });

    test("a voice that fails is retried once with the browser's default voice; a second failure is reported", async () => {
        let result;
        A.speakText("Hello.", { fromAssistant: true }).then((r) => { result = r; });
        expect(spoken[0].voice.name).toBe("Rishi");
        spoken[0].onerror({ error: "voice-unavailable" });
        expect(spoken).toHaveLength(2);
        expect(spoken[1].voice).toBeUndefined();
        spoken[1].onerror({ error: "synthesis-failed" });
        await Promise.resolve();
        expect(result).toEqual({ status: "failed", remaining: ["Hello."] });
    });

    test("when the browser never reports the end, speech moves on instead of waiting forever", async () => {
        const done = jest.fn();
        A.speakText("Okay.", { fromAssistant: true }).then(done);
        synth.speaking = false;
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
        expect(done).toHaveBeenCalledWith({ status: "done", remaining: [] });
        // Repeated replies each take their own time; nothing accumulates.
        const again = jest.fn();
        A.speakText("Okay.", { fromAssistant: true }).then(again);
        synth.speaking = false;
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
        expect(again).toHaveBeenCalled();
    });

    test("speech waits briefly after a cancel", () => {
        A.speakText("Added to your cart.", { kind: "announce" });
        A.cancelSpeech();
        A.speakText("Hello! I'm Zoro.", { fromAssistant: true });
        expect(texts()).toEqual(["Added to your cart."]);
        jest.advanceTimersByTime(60);
        expect(texts()).toEqual(["Added to your cart.", "Hello! I'm Zoro."]);
    });

    test("cancelling when nothing is speaking does not delay the next message", () => {
        synth.speaking = false;
        A.cancelSpeech();
        expect(synth.cancel).not.toHaveBeenCalled();
        A.speakText("Hello.", { fromAssistant: true });
        expect(texts()).toEqual(["Hello."]);
    });

    test("a part the browser never starts is nudged with pause and resume (this restarts a stuck Chrome)", () => {
        synth.pause = jest.fn();
        synth.dropNext = 1;
        A.speakText("Hello! I'm Zoro.", { fromAssistant: true });
        jest.advanceTimersByTime(2500);
        expect(synth.pause).toHaveBeenCalledTimes(1);
        expect(synth.resume).toHaveBeenCalledTimes(1);
        spoken[0].onstart(); // the nudge worked
        jest.advanceTimersByTime(5000);
        expect(synth.cancel).not.toHaveBeenCalled();
    });

    test("a part that still does not start is skipped, so speech never stalls", async () => {
        const done = jest.fn();
        synth.pause = jest.fn();
        synth.dropNext = 1;
        A.speakText("Hello! I'm Zoro.", { fromAssistant: true }).then(done);
        jest.advanceTimersByTime(2500 + 1500 + 60);
        await Promise.resolve();
        expect(synth.cancel).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith({ status: "done", remaining: [] });
        expect(spoken).toHaveLength(1);
    });

    test("without speech synthesis nothing is spoken and the caller is told", async () => {
        delete window.speechSynthesis;
        expect(await A.speakText("Hello.", { fromAssistant: true })).toEqual({ status: "unavailable", remaining: [] });
    });
});
