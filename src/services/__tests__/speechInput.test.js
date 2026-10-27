import { startRecognitionSession, mergeSegment, recognitionProblem, INTERIM_SETTLE_MS, MAX_UTTERANCE_MS, MAX_ALTERNATIVES } from "../speechInput";

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
