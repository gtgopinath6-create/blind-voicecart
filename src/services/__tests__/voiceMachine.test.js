import { voiceReducer, initialVoiceState, S, stripWakeWord } from "../voiceMachine";

const run = (events, state = initialVoiceState) => events.reduce(voiceReducer, state);
// Turning Zoro on: it greets (speaking, microphone off), then listens.
const ACTIVATE = [{ type: "ENABLE", message: "Hello! I'm Zoro." }, { type: "SPEECH_DONE" }];

test("speech is ignored until the user activates Zoro", () => {
    const state = run([{ type: "TRANSCRIPT", text: "buy iphone 13 pro" }]);
    expect(state.status).toBe(S.IDLE);
    expect(state.commandId).toBe(0);
});

test("activation greets first, and the greeting is never heard as a command", () => {
    let state = run([{ type: "ENABLE", message: "Hello! I'm Zoro." }]);
    expect(state.status).toBe(S.SPEAKING);
    expect(state.message).toBe("Hello! I'm Zoro.");
    state = run([{ type: "TRANSCRIPT", text: "hello i'm zoro" }], state);
    expect(state.commandId).toBe(0);
    state = run([{ type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.COMMAND_LISTENING);
});

test('in wake-phrase mode, plain speech does nothing and "Hey Zoro" activates', () => {
    let state = run([{ type: "SET_WAKE_WORD_MODE", enabled: true }]);
    expect(state.status).toBe(S.WAKE_WORD_LISTENING);
    state = run([{ type: "TRANSCRIPT", text: "add shoes to cart" }], state);
    expect(state.status).toBe(S.WAKE_WORD_LISTENING);
    expect(state.commandId).toBe(0);
    state = run([{ type: "WAKE" }], state);
    expect(state.status).toBe(S.SPEAKING);
    state = run([{ type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.COMMAND_LISTENING);
});

test("the wake phrase must be present to strip it", () => {
    expect(stripWakeWord("Hey Zoro, open shoes")).toBe("open shoes");
    expect(stripWakeWord("hey zorro")).toBe("");
    expect(stripWakeWord("Hi Zoro find me shoes")).toBe("find me shoes");
    expect(stripWakeWord("open shoes")).toBeNull();
    expect(stripWakeWord("hey google open shoes")).toBeNull();
    expect(stripWakeWord("they zoro")).toBeNull();
});

test("a command runs once: stale or duplicate outcomes are dropped", () => {
    let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "open shoes" }]);
    expect(state.status).toBe(S.PROCESSING);
    const id = state.commandId;
    state = run([{ type: "TRANSCRIPT", text: "open shoes" }], state);
    expect(state.commandId).toBe(id);
    state = run([{ type: "OUTCOME", commandId: id - 1, outcome: { type: "done", message: "old" } }], state);
    expect(state.status).toBe(S.PROCESSING);
    state = run([{ type: "OUTCOME", commandId: id, outcome: { type: "done", message: "Opening shoes." } }], state);
    expect(state.status).toBe(S.SPEAKING);
    state = run([{ type: "OUTCOME", commandId: id, outcome: { type: "done", message: "again" } }], state);
    expect(state.message).toBe("Opening shoes.");
});

test("the conversation continues after a reply, and Zoro's own speech is not processed", () => {
    let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "open shoes" }]);
    state = run([{ type: "OUTCOME", commandId: state.commandId, outcome: { type: "done", message: "Opening shoes" } }], state);
    const before = state.commandId;
    state = run([{ type: "TRANSCRIPT", text: "opening shoes" }], state);
    expect(state.commandId).toBe(before);
    state = run([{ type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.COMMAND_LISTENING);
});

test("questions wait for an answer; inactivity pauses and drops the pending question", () => {
    let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "place my order" }]);
    state = run([{ type: "OUTCOME", commandId: state.commandId, outcome: { type: "ask", message: "Confirm?", pending: { kind: "confirmOrder" } } }, { type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.AWAITING_CONFIRMATION);
    expect(state.pending).toEqual({ kind: "confirmOrder" });
    state = run([{ type: "PAUSE", message: "I've paused listening." }], state);
    expect(state.pending).toBeNull();
    expect(state.status).toBe(S.SPEAKING);
    state = run([{ type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.PAUSED);
    expect(state.pausedReason).toBe("inactivity");
    // A paused conversation ignores speech until it is activated again.
    expect(run([{ type: "TRANSCRIPT", text: "yes" }], state).status).toBe(S.PAUSED);
    expect(run([{ type: "ENABLE", message: "Welcome back." }, { type: "SPEECH_DONE" }], state).status).toBe(S.COMMAND_LISTENING);
});

test("with wake-phrase mode on, inactivity returns to waiting for Hey Zoro", () => {
    let state = run([{ type: "SET_WAKE_WORD_MODE", enabled: true }, { type: "WAKE" }, { type: "SPEECH_DONE" }]);
    state = run([{ type: "PAUSE", message: "Paused." }, { type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.WAKE_WORD_LISTENING);
});

test("typing a password pauses listening instead of continuing", () => {
    let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "yes" }]);
    state = run([{ type: "OUTCOME", commandId: state.commandId, outcome: { type: "keyboard", message: "Type your password." } }, { type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.PAUSED);
    expect(state.pausedReason).toBe("keyboard");
});

test("stopping prevents any further command execution", () => {
    let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "buy iphone" }]);
    const id = state.commandId;
    state = run([{ type: "DISABLE" }], state);
    expect(state.status).toBe(S.IDLE);
    state = run([{ type: "OUTCOME", commandId: id, outcome: { type: "done", message: "Added" } }], state);
    expect(state.status).toBe(S.IDLE);
    state = run([{ type: "TRANSCRIPT", text: "buy iphone" }], state);
    expect(state.status).toBe(S.IDLE);
});

test("a blocked microphone or unsupported browser disables Zoro until an explicit retry", () => {
    let state = run([...ACTIVATE, { type: "MIC_BLOCKED", message: "Microphone blocked." }]);
    expect(state.status).toBe(S.DISABLED);
    expect(run([{ type: "TRANSCRIPT", text: "open shoes" }], state).status).toBe(S.DISABLED);
    state = run([{ type: "ENABLE" }], state);
    expect(state.status).toBe(S.SPEAKING);
    expect(run([{ type: "UNSUPPORTED" }]).status).toBe(S.DISABLED);
});

test("a stop outcome turns wake-phrase mode off", () => {
    let state = run([{ type: "SET_WAKE_WORD_MODE", enabled: true }, { type: "WAKE_WITH_COMMAND", text: "stop listening" }]);
    state = run([{ type: "OUTCOME", commandId: state.commandId, outcome: { type: "stop", message: "Stopped" } }, { type: "SPEECH_DONE" }], state);
    expect(state.status).toBe(S.IDLE);
    expect(state.wakeWordMode).toBe(false);
});

describe("typing, repeating and recovering", () => {
    test("typed text is handled like speech, and typing while Zoro talks interrupts the reply", () => {
        let state = run([...ACTIVATE, { type: "TYPED", text: "  open shoes " }]);
        expect(state).toMatchObject({ status: S.PROCESSING, transcript: "open shoes", heard: { source: "typed" }, commandId: 1 });
        state = run([{ type: "OUTCOME", commandId: 1, outcome: { type: "ask", message: "Which colour?", pending: { kind: "zoro", choices: [] } } }], state);
        expect(state.status).toBe(S.SPEAKING);
        state = run([{ type: "TYPED", text: "black" }], state);
        expect(state).toMatchObject({ status: S.PROCESSING, transcript: "black", commandId: 2 });
        expect(run([{ type: "TYPED", text: "hello" }]).status).toBe(S.IDLE); // not while Zoro is off
    });

    test("repeating a question speaks it again and then waits for the same answer", () => {
        let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "place my order" }]);
        state = run([{ type: "OUTCOME", commandId: 1, outcome: { type: "ask", message: "Place the order?", pending: { kind: "confirmOrder" } } }, { type: "SPEECH_DONE" }], state);
        const before = state.speakId;
        state = run([{ type: "REPLAY", message: "Place the order?" }], state);
        expect(state).toMatchObject({ status: S.SPEAKING, afterSpeech: S.AWAITING_CONFIRMATION, pending: { kind: "confirmOrder" }, replay: true });
        expect(state.speakId).toBe(before + 1);
        state = run([{ type: "SPEECH_DONE" }], state);
        expect(state).toMatchObject({ status: S.AWAITING_CONFIRMATION, pending: { kind: "confirmOrder" } });
        expect(run([{ type: "REPLAY", message: "x" }]).status).toBe(S.IDLE);
    });

    test("resuming a stopped reply speaks only the rest of it", () => {
        let state = run([...ACTIVATE, { type: "REPLAY", message: "One. Two. Three.", chunks: ["Three."] }]);
        expect(state).toMatchObject({ status: S.SPEAKING, message: "One. Two. Three.", speakChunks: ["Three."] });
        state = run([{ type: "SPEECH_DONE" }, { type: "TRANSCRIPT", text: "repeat" }], state);
        state = run([{ type: "OUTCOME", commandId: state.commandId, outcome: { type: "resume", message: "Which colour?", chunks: null, after: S.COMMAND_LISTENING } }], state);
        expect(state).toMatchObject({ status: S.SPEAKING, afterSpeech: S.COMMAND_LISTENING, replay: true });
    });

    test("a recognition problem is said, then Zoro listens for the same answer again", () => {
        let state = run([...ACTIVATE, { type: "TRANSCRIPT", text: "add it" }]);
        state = run([{ type: "OUTCOME", commandId: 1, outcome: { type: "ask", message: "Add it?", pending: { kind: "zoro", choices: [] } } }, { type: "SPEECH_DONE" }], state);
        state = run([{ type: "ERROR", message: "Speech recognition needs an internet connection." }], state);
        expect(state.status).toBe(S.ERROR);
        state = run([{ type: "RECOVER" }], state);
        expect(state).toMatchObject({ status: S.AWAITING_CONFIRMATION, pending: { kind: "zoro", choices: [] } });
    });
});
