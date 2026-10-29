import {
    startRecognitionSession, mergeSegment, recognitionProblem, INTERIM_SETTLE_MS, MAX_UTTERANCE_MS, MAX_ALTERNATIVES,
    startWhisperSession, whisperCaptureSupported, transcriptionProblem, WHISPER_CONFIDENCE,
} from "../speechInput";
import { uploadAudio } from "../apiClient";

jest.mock("../apiClient", () => ({ uploadAudio: jest.fn() }));

// A stand-in for the browser's recognition object. Results arrive as in Chrome's continuous mode:
// one growing list per session, where an interim result is replaced by its final version at the same index.
class FakeRecognition {
    constructor() {
        this.finals = [];
        this.stopped = false;
        this.aborted = false;
    }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    emit(text, { isFinal = true, confidence, alternatives = [], index } = {}) {
        const result = [{ transcript: text, confidence }, ...alternatives.map((a) => ({ transcript: a, confidence: 0 }))];
        result.isFinal = isFinal;
        const at = index ?? this.finals.length;
        if (isFinal) this.finals[at] = result;
        this.onresult({ resultIndex: at, results: isFinal ? [...this.finals] : [...this.finals, result] });
    }
}

let rec;
function start(options = {}) {
    const heard = [];
    const errors = [];
    const ends = [];
    let created;
    const Recognition = function Recognition() { created = new FakeRecognition(); return created; };
    const session = startRecognitionSession(Recognition, {
        lang: "en-IN",
        pauseMs: 900,
        onUtterance: (u) => { heard.push(u); return options.accept ? options.accept(u) : true; },
        onError: (code) => errors.push(code),
        onEnd: (info) => ends.push(info),
        ...options,
    });
    rec = created;
    rec.start();
    return { session, heard, errors, ends };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("recognition listens continuously in the chosen English, with interim results and alternatives", () => {
    start({ lang: "en-IN" });
    expect(rec.lang).toBe("en-IN");
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.maxAlternatives).toBe(MAX_ALTERNATIVES);
});

test("a natural pause between words does not cut the sentence: it is acted on once, after the shopper stops", () => {
    const { heard } = start();
    rec.emit("I'm looking for");
    jest.advanceTimersByTime(600); // pausing to think
    expect(heard).toHaveLength(0);
    rec.emit("black shoes in size nine");
    jest.advanceTimersByTime(899);
    expect(heard).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(heard.map((u) => u.text)).toEqual(["I'm looking for black shoes in size nine"]);
});

test("the listening pause setting changes how long Zoro waits", () => {
    const { heard } = start({ pauseMs: 1800 });
    rec.emit("yes");
    jest.advanceTimersByTime(1000);
    expect(heard).toHaveLength(0);
    jest.advanceTimersByTime(800);
    expect(heard).toHaveLength(1);
});

test("interim words are shown but never acted on; Zoro asks the browser to finish them instead", () => {
    const interim = [];
    const { heard } = start({ onInterim: (t) => interim.push(t) });
    rec.emit("add the iph", { isFinal: false });
    expect(interim).toEqual(["add the iph"]);
    jest.advanceTimersByTime(INTERIM_SETTLE_MS);
    expect(heard).toHaveLength(0);
    expect(rec.stopped).toBe(true); // stop() makes the browser return its final result
    rec.emit("add the iPhone 13 Pro");
    rec.onend();
    expect(heard.map((u) => u.text)).toEqual(["add the iPhone 13 Pro"]);
});

test("a session that ends with only interim words delivers nothing", () => {
    const { heard, ends } = start();
    rec.emit("place my or", { isFinal: false });
    rec.onend();
    expect(heard).toHaveLength(0);
    expect(ends).toHaveLength(1);
});

test("final words heard before the browser ends the session still count", () => {
    const { heard } = start();
    rec.emit("open shoes");
    rec.onend();
    expect(heard.map((u) => u.text)).toEqual(["open shoes"]);
});

test("the same final result delivered twice is used once", () => {
    const { heard } = start();
    rec.emit("open shoes", { index: 0 });
    rec.emit("open shoes", { index: 0 });
    jest.advanceTimersByTime(900);
    expect(heard.map((u) => u.text)).toEqual(["open shoes"]);
});

test("browsers that repeat the whole sentence in each final result do not double it", () => {
    expect(mergeSegment("open", "open shoes")).toBe("open shoes");
    expect(mergeSegment("open shoes", "shoes")).toBe("open shoes");
    expect(mergeSegment("I'm looking for", "black shoes")).toBe("I'm looking for black shoes");
    const { heard } = start();
    rec.emit("open");
    rec.emit("open shoes");
    jest.advanceTimersByTime(900);
    expect(heard.map((u) => u.text)).toEqual(["open shoes"]);
});

test("a single-phrase answer carries the browser's alternatives and its lowest confidence", () => {
    const { heard } = start();
    rec.emit("blew", { confidence: 0.42, alternatives: ["Blew", "blue"] });
    jest.advanceTimersByTime(900);
    // At most the three hearings asked for, without repeats.
    expect(heard[0]).toEqual({ text: "blew", alternatives: ["blew", "blue"], confidence: 0.42 });
});

test("confidence is null when the browser reports none, and a longer sentence has no alternatives", () => {
    const { heard } = start();
    rec.emit("black shoes", { confidence: 0 });
    rec.emit("in size nine", { confidence: 0.9 });
    jest.advanceTimersByTime(900);
    expect(heard[0]).toEqual({ text: "black shoes in size nine", alternatives: ["black shoes in size nine"], confidence: 0.9 });
});

test("an utterance the listener rejects (Zoro's own voice) leaves the session listening for the shopper", () => {
    const { heard } = start({ accept: (u) => u.text !== "I have opened the shoes page for you" });
    rec.emit("I have opened the shoes page for you");
    jest.advanceTimersByTime(900);
    rec.emit("show me Nike");
    jest.advanceTimersByTime(900);
    expect(heard.map((u) => u.text)).toEqual(["I have opened the shoes page for you", "show me Nike"]);
});

test("after a command is accepted, later words in the same session are ignored", () => {
    const { heard } = start();
    rec.emit("open shoes");
    jest.advanceTimersByTime(900);
    rec.emit("add everything to my cart");
    jest.advanceTimersByTime(900);
    expect(heard.map((u) => u.text)).toEqual(["open shoes"]);
});

test("wake-phrase mode delivers every utterance and keeps listening", () => {
    const { heard } = start({ mode: "wake" });
    rec.emit("buy the iphone for me");
    jest.advanceTimersByTime(900);
    rec.emit("hey zoro open shoes");
    jest.advanceTimersByTime(900);
    expect(heard.map((u) => u.text)).toEqual(["buy the iphone for me", "hey zoro open shoes"]);
});

test("a very long utterance is finished after the limit", () => {
    start();
    rec.emit("and another thing", { isFinal: false });
    for (let t = 0; t < MAX_UTTERANCE_MS; t += 2000) {
        rec.emit(`still talking ${t}`, { isFinal: false });
        jest.advanceTimersByTime(2000);
    }
    expect(rec.stopped).toBe(true);
});

test("aborting stops delivery and releases the browser's session", () => {
    const { session, heard } = start();
    rec.emit("open shoes");
    session.abort();
    jest.advanceTimersByTime(2000);
    expect(heard).toHaveLength(0);
    expect(rec.aborted).toBe(true);
    expect(rec.onresult).toBeNull();
    expect(rec.onend).toBeNull();
});

test("errors are passed on with their code", () => {
    const { errors } = start();
    rec.onerror({ error: "network" });
    expect(errors).toEqual(["network"]);
});

test("recognition problems are explained in plain words, never as raw error codes", () => {
    expect(recognitionProblem("no-speech")).toBeNull();
    expect(recognitionProblem("aborted")).toBeNull();
    expect(recognitionProblem("not-allowed")).toMatchObject({ kind: "blocked", fatal: true });
    expect(recognitionProblem("service-not-allowed")).toMatchObject({ kind: "service", fatal: true });
    expect(recognitionProblem("language-not-supported", "English (India)").message).toBe(
        "This browser can't recognise English (India). Choose another English in Zoro's listening settings, or type to Zoro.");
    expect(recognitionProblem("network")).toMatchObject({ kind: "network", counts: true });
    expect(recognitionProblem("audio-capture")).toMatchObject({ kind: "microphone", counts: true });
    for (const code of ["network", "audio-capture", "bad-grammar", "something-new", "not-allowed"]) {
        expect(recognitionProblem(code).message).not.toMatch(code);
    }
});

describe("startWhisperSession (command-mode capture via the server's Whisper endpoint)", () => {
    const level = { value: 0 }; // simulated microphone input level, read by the fake analyser

    class FakeAnalyser {
        constructor() { this.frequencyBinCount = 32; }
        getByteTimeDomainData(arr) { arr.fill(128 + level.value); }
    }
    class FakeAudioContext {
        createMediaStreamSource() { return { connect: () => {} }; }
        createAnalyser() { return new FakeAnalyser(); }
        close() { this.closed = true; }
    }

    let recorders;
    class FakeMediaRecorder {
        constructor(stream, options) {
            this.stream = stream;
            this.mimeType = (options && options.mimeType) || "";
            this.state = "inactive";
            this.ondataavailable = null;
            this.onstop = null;
            recorders.push(this);
        }
        start() { this.state = "recording"; }
        // Real recorders flush any buffered audio just before onstop; the fake does the same.
        stop() {
            this.state = "inactive";
            if (this.ondataavailable) this.ondataavailable({ data: new Blob(["x"], { type: "audio/webm" }) });
            if (this.onstop) this.onstop();
        }
    }
    FakeMediaRecorder.isTypeSupported = (type) => type === "audio/webm;codecs=opus";

    let fakeTrack;
    let getUserMedia;

    beforeEach(() => {
        level.value = 0;
        recorders = [];
        fakeTrack = { stop: jest.fn() };
        getUserMedia = jest.fn(async () => ({ getTracks: () => [fakeTrack] }));
        Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia }, configurable: true, writable: true });
        window.MediaRecorder = FakeMediaRecorder;
        window.AudioContext = FakeAudioContext;
        uploadAudio.mockReset();
    });

    // Lets pending microtasks (getUserMedia's await, the upload promise) settle between timer advances.
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    function startWhisper(options = {}) {
        const heard = [];
        const errors = [];
        const ends = [];
        const audio = [];
        const session = startWhisperSession({
            onUtterance: (u) => { heard.push(u); return options.accept ? options.accept(u) : true; },
            onAudio: (on) => audio.push(on),
            onError: (code) => errors.push(code),
            onEnd: (info) => ends.push(info),
            silenceMs: 50, noSpeechMs: 300, maxMs: 2000, pollMs: 10, voiceLevel: 12,
            ...options,
        });
        return { session, heard, errors, ends, audio };
    }

    test("records until silence follows speech, then uploads and delivers the transcript", async () => {
        uploadAudio.mockResolvedValue({ text: "open shoes" });
        const { heard, ends, audio } = startWhisper();
        await flush();
        expect(recorders[0].state).toBe("recording");
        expect(audio).toEqual([true]);

        level.value = 50; // speaking
        jest.advanceTimersByTime(20);
        level.value = 0; // silence
        jest.advanceTimersByTime(100);
        await flush();

        expect(uploadAudio).toHaveBeenCalledTimes(1);
        expect(heard).toEqual([{ text: "open shoes", alternatives: ["open shoes"], confidence: WHISPER_CONFIDENCE }]);
        expect(ends).toEqual([{ heardAudio: true }]);
        expect(fakeTrack.stop).toHaveBeenCalled(); // the microphone is released afterwards
    });

    test("nothing said at all ends quietly, like the Web Speech API's no-speech, without uploading", async () => {
        const { heard, errors, ends } = startWhisper({ noSpeechMs: 100 });
        await flush();
        jest.advanceTimersByTime(150);
        await flush();

        expect(uploadAudio).not.toHaveBeenCalled();
        expect(heard).toHaveLength(0);
        expect(errors).toHaveLength(0);
        expect(ends).toEqual([{ heardAudio: false }]);
    });

    test("a very long utterance is finished after the limit, even while still speaking", async () => {
        uploadAudio.mockResolvedValue({ text: "a very long request" });
        const { heard } = startWhisper({ maxMs: 200 });
        await flush();
        level.value = 50; // continuous speech keeps resetting the silence timer, never the max timer
        jest.advanceTimersByTime(250);
        await flush();

        expect(heard.map((u) => u.text)).toEqual(["a very long request"]);
    });

    test("an upload failure is reported with a mapped code, and the session still ends", async () => {
        uploadAudio.mockRejectedValue(Object.assign(new Error("down"), { code: "network" }));
        const { heard, errors, ends } = startWhisper();
        await flush();
        level.value = 50;
        jest.advanceTimersByTime(20);
        level.value = 0;
        jest.advanceTimersByTime(100);
        await flush();

        expect(heard).toHaveLength(0);
        expect(errors).toEqual(["network"]);
        expect(ends).toEqual([{ heardAudio: true }]);
    });

    test("microphone permission denied is reported before any recording starts", async () => {
        getUserMedia.mockRejectedValue(Object.assign(new Error("nope"), { name: "NotAllowedError" }));
        const { errors, ends } = startWhisper();
        await flush();

        expect(errors).toEqual(["not-allowed"]);
        expect(ends).toEqual([{ heardAudio: false }]);
        expect(recorders).toHaveLength(0);
    });

    test("aborting releases the microphone without delivering anything or reporting an end", async () => {
        const { session, heard, ends } = startWhisper();
        await flush();
        session.abort();

        expect(fakeTrack.stop).toHaveBeenCalled();
        expect(heard).toHaveLength(0);
        expect(ends).toHaveLength(0);
    });

    test("an empty transcript is not delivered as an utterance", async () => {
        uploadAudio.mockResolvedValue({ text: "   " });
        const { heard, ends } = startWhisper();
        await flush();
        level.value = 50;
        jest.advanceTimersByTime(20);
        level.value = 0;
        jest.advanceTimersByTime(100);
        await flush();

        expect(heard).toHaveLength(0);
        expect(ends).toEqual([{ heardAudio: true }]);
    });
});

test("transcription problems are explained in plain words, matching recognitionProblem's shape", () => {
    expect(transcriptionProblem("not-allowed")).toMatchObject({ kind: "blocked", fatal: true });
    expect(transcriptionProblem("audio-capture")).toMatchObject({ kind: "microphone", counts: true });
    expect(transcriptionProblem("network")).toMatchObject({ kind: "network", counts: true });
    expect(transcriptionProblem("not-configured")).toMatchObject({ kind: "service", fatal: true });
    expect(transcriptionProblem("unavailable")).toMatchObject({ kind: "other", counts: true });
    for (const code of ["network", "audio-capture", "not-configured", "something-new"]) {
        expect(transcriptionProblem(code).message).not.toMatch(code);
    }
});

test("Whisper capture is only reported as available when this browser has both getUserMedia and MediaRecorder", () => {
    const media = window.navigator.mediaDevices;
    const recorder = window.MediaRecorder;
    try {
        Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia: () => {} }, configurable: true, writable: true });
        window.MediaRecorder = function () {};
        expect(whisperCaptureSupported()).toBe(true);

        Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true, writable: true });
        expect(whisperCaptureSupported()).toBe(false);

        Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia: () => {} }, configurable: true, writable: true });
        window.MediaRecorder = undefined;
        expect(whisperCaptureSupported()).toBe(false);
    } finally {
        Object.defineProperty(window.navigator, "mediaDevices", { value: media, configurable: true, writable: true });
        window.MediaRecorder = recorder;
    }
});
