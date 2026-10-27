import React from "react";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import GlobalAIVoiceAssistant, { INACTIVITY_MS, TAB_HIDDEN_MESSAGE, TYPE_HINT } from "../GlobalAIVoiceAssistant";
import { cancelSpeech, setSpeechRate, resetSpeechForTests, NORMAL_RATE } from "../../services/announcer";
import { resetSpeechSettingsForTests } from "../../services/speechSettings";
import { TTSContext, ThemeContext, SearchContext, UserContext } from "../../App";
import { zoroTurn, createConversation } from "../../services/zoroDialogue";
import { reportAuthResult } from "../../services/voiceContext";

// The conversation itself is tested in zoroDialogue.test.js; here only the listening lifecycle.
jest.mock("../../services/zoroDialogue", () => ({ ...jest.requireActual("../../services/zoroDialogue"), zoroTurn: jest.fn() }));
jest.mock("../../services/voiceActions", () => ({ executeAction: jest.fn(), resolvePending: jest.fn() }));
jest.mock("../../services/catalogService", () => ({ loadCatalog: jest.fn(async () => []), loadCategory: jest.fn(async () => []) }));

// --- Fake Web Speech API -------------------------------------------------
// Results arrive as in Chrome's continuous mode: one growing list per session, where an interim
// result is replaced by its final version at the same index.
let sessions = [];
class FakeRecognition {
    constructor() {
        this.aborted = false;
        this.finals = [];
        sessions.push(this);
    }
    start() { this.started = true; }
    abort() { this.aborted = true; }
    stop() { this.aborted = true; }
}
const live = () => sessions.filter((s) => s.started && !s.aborted);
/** Speech recognition hearing `text`. A final result is followed by the shopper's pause, after which Zoro acts. */
function hear(text, { isFinal = true, session = live()[live().length - 1], confidence, alternatives = [], pause = true } = {}) {
    const result = [{ transcript: text, confidence }, ...alternatives.map((a) => ({ transcript: a }))];
    result.isFinal = isFinal;
    const index = session.finals.length;
    if (isFinal) session.finals.push(result);
    act(() => {
        session.onresult && session.onresult({ resultIndex: index, results: isFinal ? [...session.finals] : [...session.finals, result] });
    });
    if (isFinal && pause) act(() => { jest.advanceTimersByTime(PAUSE_MS); });
}
const say = (text, options) => hear(text, options);
const PAUSE_MS = 900; // the default "Wait after I stop talking" setting

let speaking = [];
beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    resetSpeechSettingsForTests();
    resetSpeechForTests();
    setSpeechRate(NORMAL_RATE);
    sessions = [];
    speaking = [];
    window.SpeechRecognition = FakeRecognition;
    window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
    window.speechSynthesis = { speaking: false, speak: (u) => { speaking.push(u); if (u.onstart) u.onstart(); }, cancel: jest.fn(), getVoices: () => [] };
    zoroTurn.mockReset();
    zoroTurn.mockImplementation(async (text, conv) => ({ conv, reply: { message: "Opening shoes.", expect: "command", choices: [] } }));
});
afterEach(() => {
    cancelSpeech(); // nothing carries over into the next test
    jest.useRealTimers();
});

const spoken = () => speaking.map((u) => u.text);
// Lets pending promises (the conversation turn) settle inside act().
const settle = () => act(() => Promise.resolve());
const endCurrentParts = async () => {
    const now = speaking;
    speaking = [];
    now.forEach((u) => u.onend && u.onend());
};
/** Zoro finishes the reply it is saying (a long reply is spoken in several parts, one after another). */
const finishSpeaking = async () => {
    const reply = screen.queryAllByRole("status").map((el) => el.textContent).join(" ");
    for (let i = 0; i < 10 && speaking.length; i++) {
        await act(endCurrentParts);
        if (!speaking.every((u) => reply.includes(u.text))) break; // the next reply has started
    }
};

function renderAssistant({ screenReader = true } = {}) {
    return render(
        <MemoryRouter>
            <UserContext.Provider value={{ user: null }}>
                <TTSContext.Provider value={{ screenReader, changeScreenReader: jest.fn() }}>
                    <ThemeContext.Provider value={{ theme: "noir", chooseTheme: jest.fn() }}>
                        <SearchContext.Provider value={{ valueToBeSearched: "", setValueToBeSearched: jest.fn() }}>
                            <GlobalAIVoiceAssistant />
                        </SearchContext.Provider>
                    </ThemeContext.Provider>
                </TTSContext.Provider>
            </UserContext.Provider>
        </MemoryRouter>
    );
}

const micButton = () => screen.getByRole("button", { name: /(talk to|turn off) zoro voice assistant \(alt\+v\)/i });

/** Turns Zoro on and lets the greeting finish, so it is listening. */
async function activate() {
    fireEvent.click(micButton());
    await finishSpeaking();
}

test("the microphone is not used until the shopper turns Zoro on", () => {
    renderAssistant();
    fireEvent.click(document.body);
    fireEvent.keyDown(window, { key: "a" });
    expect(sessions).toHaveLength(0);
    expect(zoroTurn).not.toHaveBeenCalled();
});

test("Zoro greets first with the microphone off, then listens", async () => {
    renderAssistant();
    fireEvent.click(micButton());
    expect(spoken()).toEqual(["Hello! I'm Zoro, your VoiceCart shopping assistant. How can I help you today?"]);
    expect(live()).toHaveLength(0);
    await finishSpeaking();
    expect(live()).toHaveLength(1);
});

test("one utterance runs exactly once, even with duplicate recognition events", async () => {
    renderAssistant();
    await activate();
    const session = live()[0];
    say("open shoes", { session });
    say("open shoes", { session });
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(1);
    expect(zoroTurn.mock.calls[0][0]).toBe("open shoes");
    expect(session.aborted).toBe(true); // recognition is off while thinking and speaking
});

test("Zoro does not hear itself, keeps the conversation going, and ignores an echo of its reply", async () => {
    zoroTurn.mockImplementation(async (text, conv) => ({ conv, reply: { message: "I have opened the shoes page for you.", expect: "command", choices: [] } }));
    renderAssistant();
    await activate();
    say("open shoes");
    await settle();
    expect(spoken()).toEqual(["I have opened the shoes page for you."]);
    expect(live()).toHaveLength(0);
    await finishSpeaking();
    expect(live()).toHaveLength(1); // listening again for the next request
    say("opened the shoes page for you"); // the speakers' sound picked up by the microphone
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(1);
});

test("a short answer that repeats an option Zoro offered is a real answer, not an echo", async () => {
    zoroTurn.mockImplementation(async (text, conv) => ({ conv, reply: { message: 'Say "yes, place order" to place the order, or "no".', expect: "answer", choices: [] } }));
    renderAssistant();
    await activate();
    say("place my order");
    await settle();
    await finishSpeaking();
    say("yes, place order");
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(2);
    expect(zoroTurn.mock.calls[1][0]).toBe("yes, place order");
});

test('"Hey Zoro" is required in wake mode, then the command runs once', async () => {
    jest.useFakeTimers();
    renderAssistant();
    await activate();
    fireEvent.click(screen.getByLabelText(/listen for "hey zoro"/i));
    // Two minutes pass without a request: Zoro goes back to waiting for the wake phrase.
    act(() => { jest.advanceTimersByTime(INACTIVITY_MS + 10); });
    await finishSpeaking();
    const wakeSession = live()[live().length - 1];
    expect(live()).toHaveLength(1);
    expect(wakeSession.continuous).toBe(true);
    say("buy the iphone for me", { session: wakeSession });
    say("add everything to my cart", { session: wakeSession });
    await settle();
    expect(zoroTurn).not.toHaveBeenCalled();
    say("hey zoro open shoes", { session: wakeSession });
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(1);
    expect(zoroTurn.mock.calls[0][0]).toBe("open shoes");
});

test("Stop listening turns everything off, including wake-phrase listening", async () => {
    renderAssistant();
    await activate();
    fireEvent.click(screen.getByLabelText(/listen for "hey zoro"/i));
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    await finishSpeaking();
    expect(live()).toHaveLength(0);
    expect(micButton()).toHaveAttribute("aria-pressed", "false");
});

test('"stop listening" is handled locally and never reaches the conversation or the AI', async () => {
    renderAssistant();
    await activate();
    say("stop listening");
    await settle();
    await finishSpeaking();
    expect(zoroTurn).not.toHaveBeenCalled();
    expect(live()).toHaveLength(0);
});

test("after two minutes without activity Zoro pauses, says why, and releases the microphone", async () => {
    jest.useFakeTimers();
    renderAssistant();
    await activate();
    expect(live()).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(INACTIVITY_MS - 1000); });
    expect(spoken()).toEqual([]); // not yet
    act(() => { jest.advanceTimersByTime(1500); });
    expect(spoken()).toEqual(["I've paused listening because there has been no activity. Say 'Hey Zoro' or activate the microphone when you need me."]);
    expect(live()).toHaveLength(0);
    await finishSpeaking();
    expect(live()).toHaveLength(0);
    expect(screen.getByText(/Zoro paused after 2 minutes without activity/)).toBeInTheDocument();
});

test("speaking resets the two minutes; silence restarts recognition instead of ending the session", async () => {
    jest.useFakeTimers();
    renderAssistant();
    await activate();
    const first = live()[0];
    act(() => { first.aborted = true; first.onend(); }); // the browser ended the session after silence
    act(() => { jest.advanceTimersByTime(300); });
    expect(live()).toHaveLength(1);
    expect(live()[0]).not.toBe(first);
    act(() => { jest.advanceTimersByTime(90 * 1000); });
    say("open shoes");
    await settle();
    await finishSpeaking();
    act(() => { jest.advanceTimersByTime(90 * 1000); });
    expect(spoken()).toEqual([]); // the clock started again after the last request
});

test("on-screen answers send the same words as speaking, once, even when clicked twice", async () => {
    zoroTurn.mockImplementationOnce(async (text, conv) => ({ conv, reply: { message: "Which colour?", expect: "answer", choices: [{ label: "Black", say: "black" }, { label: "Any colour", say: "any colour", quiet: true }] } }));
    renderAssistant();
    await activate();
    say("find shoes");
    await settle();
    await finishSpeaking();
    const answers = within(screen.getByRole("group", { name: "Answer Zoro" })).getAllByRole("button");
    expect(answers.map((b) => b.textContent)).toEqual(["Black", "Any colour"]);
    fireEvent.click(answers[0]);
    fireEvent.click(answers[0]);
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(2);
    expect(zoroTurn.mock.calls[1][0]).toBe("black");
});

test("a password hand-off pauses the microphone, and sign-in success resumes with a welcome", async () => {
    zoroTurn.mockImplementationOnce(async (text, conv) => ({
        conv: { ...conv, workflow: "login", step: "awaitAuth" },
        reply: { message: "Type your password and press Enter.", expect: "keyboard", choices: [] },
    }));
    renderAssistant();
    await activate();
    say("yes");
    await settle();
    await finishSpeaking();
    expect(live()).toHaveLength(0);
    expect(screen.getByText(/Zoro is waiting while you type/)).toBeInTheDocument();
    act(() => { reportAuthResult(true); });
    expect(spoken()[0]).toMatch(/^You're signed in successfully\. Welcome to VoiceCart\./);
    await finishSpeaking();
    expect(live()).toHaveLength(1);
});

test("turning Zoro off stops listening and drops a pending result", async () => {
    let finish;
    zoroTurn.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderAssistant();
    await activate();
    say("add iphone");
    fireEvent.click(micButton()); // off while the request is still running
    await act(async () => finish({ conv: {}, reply: { message: "Added.", expect: "command" } }));
    expect(spoken()).not.toContain("Added.");
    expect(live()).toHaveLength(0);
});

test("a blocked microphone is reported, Zoro is disabled, and recognition is not restarted", async () => {
    renderAssistant();
    await activate();
    const session = live()[0];
    act(() => { session.onerror({ error: "not-allowed" }); });
    act(() => { if (session.onend) session.onend(); });
    expect(live()).toHaveLength(0);
    expect(screen.getByText(/Microphone blocked\. Allow the microphone/)).toBeInTheDocument();
});

test("without speech recognition the microphone is never used, it says so, and Zoro works by typing", async () => {
    delete window.SpeechRecognition;
    renderAssistant();
    expect(screen.getByRole("note")).toHaveTextContent(/Voice input isn't available in this browser/);
    fireEvent.click(micButton());
    expect(screen.getByRole("status")).toHaveTextContent(/Voice input isn't available in this browser, so type your request in the box below\.$/);
    expect(spoken()[0]).toMatch(/^Hello! I'm Zoro/);
    const box = screen.getByRole("textbox", { name: "Type to Zoro" });
    expect(box).toHaveFocus();
    await finishSpeaking();
    fireEvent.change(box, { target: { value: "open shoes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(zoroTurn).toHaveBeenCalledTimes(1);
    expect(zoroTurn.mock.calls[0][0]).toBe("open shoes");
    expect(zoroTurn.mock.calls[0][3]).toEqual({ source: "typed" });
    expect(sessions).toHaveLength(0);
});

test("with the custom screen reader off, replies go to a live region instead of speech", async () => {
    jest.useFakeTimers();
    renderAssistant({ screenReader: false });
    fireEvent.click(micButton());
    act(() => { jest.advanceTimersByTime(10000); });
    say("open shoes");
    await settle();
    expect(speaking).toHaveLength(0);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Opening shoes.");
    expect(status).toHaveAttribute("aria-live", "polite");
});

function setVisibility(value) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

test("leaving the tab releases the microphone and drops a pending order question", async () => {
    zoroTurn.mockImplementation(async (text, conv) => ({
        conv: { ...conv, legacyPending: { kind: "confirmOrder" } },
        reply: { message: 'Say "yes, place order" to confirm.', expect: "answer", choices: [] },
    }));
    renderAssistant();
    await activate();
    say("place my order");
    await settle();
    await finishSpeaking();
    expect(live()).toHaveLength(1);
    setVisibility("hidden");
    expect(spoken()).toEqual([TAB_HIDDEN_MESSAGE]);
    await finishSpeaking();
    expect(live()).toHaveLength(0);
    expect(screen.getByText(/Zoro paused because you left this tab/)).toBeInTheDocument();
    setVisibility("visible");
    // Back on the tab: the order question is gone; the next answer is a new request, not a "yes".
    fireEvent.click(micButton());
    await finishSpeaking();
    say("yes, place order");
    await settle();
    expect(zoroTurn.mock.calls[1][1].legacyPending).toBeNull();
});

test("a request already running when the tab is left finishes before Zoro pauses", async () => {
    let finish;
    zoroTurn.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderAssistant();
    await activate();
    say("place my order");
    setVisibility("hidden");
    expect(spoken()).toEqual([]);
    await act(async () => finish({ conv: createConversation(), reply: { message: "Order placed.", expect: "command" } }));
    expect(spoken()).toEqual(["Order placed."]);
    await finishSpeaking();
    expect(spoken()).toEqual([TAB_HIDDEN_MESSAGE]);
    await finishSpeaking();
    expect(live()).toHaveLength(0);
    setVisibility("visible");
});

// ---------------------------------------------------------------- listening

const LONG_REPLY = "I found 3 matching options. Option 1: Nike Air Force 1, black, size 9, 9000 rupees. Option 2: Vans Old Skool, black, size 9, 5000 rupees. Option 3: Puma Lex, grey, size 9, 5099 rupees. Which option would you like?";
const ask = (message, choices = []) => async (text, conv) => ({ conv, reply: { message, expect: "answer", choices } });

describe("listening", () => {
    test("Indian English by default, continuous, with interim results and alternatives; one session at a time", async () => {
        renderAssistant();
        await activate();
        expect(live()).toHaveLength(1);
        expect(live()[0]).toMatchObject({ lang: "en-IN", continuous: true, interimResults: true, maxAlternatives: 3 });
        say("open shoes");
        await settle();
        await finishSpeaking();
        expect(live()).toHaveLength(1);
    });

    test("the status says whether the microphone is really on", async () => {
        renderAssistant();
        await activate();
        expect(screen.getByText("Starting the microphone")).toBeInTheDocument();
        act(() => { live()[0].onstart(); });
        expect(screen.getByText("Listening")).toBeInTheDocument();
    });

    test("a pause in the middle of a sentence does not cut it off", async () => {
        renderAssistant();
        await activate();
        hear("I'm looking for", { pause: false });
        act(() => { jest.advanceTimersByTime(600); });
        hear("black shoes in size nine");
        await settle();
        expect(zoroTurn).toHaveBeenCalledTimes(1);
        expect(zoroTurn.mock.calls[0][0]).toBe("I'm looking for black shoes in size nine");
    });

    test("interim words are shown while the shopper speaks but never acted on", async () => {
        renderAssistant();
        await activate();
        hear("place my ord", { isFinal: false });
        expect(screen.getByText(/place my ord/)).toBeInTheDocument();
        act(() => { jest.advanceTimersByTime(1500); });
        await settle();
        expect(zoroTurn).not.toHaveBeenCalled();
    });

    test("the browser's confidence and other hearings reach the conversation with the words", async () => {
        renderAssistant();
        await activate();
        hear("blew", { confidence: 0.4, alternatives: ["blue"] });
        await settle();
        expect(zoroTurn.mock.calls[0][3]).toEqual({ source: "voice", confidence: 0.4, alternatives: ["blew", "blue"] });
    });

    test("choosing another English restarts listening in it, says so, and is remembered", async () => {
        renderAssistant();
        await activate();
        fireEvent.change(screen.getByLabelText(/^Language I listen for/), { target: { value: "en-US" } });
        expect(screen.getByRole("status")).toHaveTextContent(/^Okay, I'll listen for English \(United States\)\.$/);
        expect(spoken()).toEqual(["Okay, I'll listen for English, United States."]); // brackets are spoken as a pause
        expect(live()).toHaveLength(0); // never listening while speaking
        await finishSpeaking();
        expect(live()).toHaveLength(1);
        expect(live()[0].lang).toBe("en-US");
        expect(localStorage.getItem("vc-speech-lang")).toBe("en-US");
    });

    test("a new pause setting applies at once: listening restarts with it", async () => {
        renderAssistant();
        await activate();
        const first = live()[0];
        fireEvent.change(screen.getByLabelText(/^Wait after I stop talking/), { target: { value: "long" } });
        expect(first.aborted).toBe(true);
        expect(live()).toHaveLength(1);
        hear("yes", { pause: false });
        act(() => { jest.advanceTimersByTime(1000); });
        await settle();
        expect(zoroTurn).not.toHaveBeenCalled(); // still waiting: the long pause is 1.8 s
        act(() => { jest.advanceTimersByTime(800); });
        await settle();
        expect(zoroTurn).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem("vc-listen-pause")).toBe("long");
    });

    test("a network problem is said once, listening resumes, and repeated failures switch to typing", async () => {
        renderAssistant();
        await activate();
        let s = live()[0];
        act(() => { s.onerror({ error: "network" }); s.aborted = true; if (s.onend) s.onend(); });
        expect(spoken()[0]).toMatch(/^Speech recognition needs an internet connection/);
        await finishSpeaking();
        expect(live()).toHaveLength(1);
        s = live()[0];
        act(() => { s.onerror({ error: "network" }); s.aborted = true; s.onend(); });
        expect(spoken()).toEqual([]); // the second failure is retried quietly
        act(() => { jest.advanceTimersByTime(2000); });
        s = live()[0];
        act(() => { s.onerror({ error: "network" }); });
        expect(spoken().join(" ")).toMatch(/^Voice input keeps failing: speech recognition can't reach the internet\. I've switched to typing/);
        await finishSpeaking();
        expect(live()).toHaveLength(0);
        expect(screen.getByText("Ready for you to type")).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Type to Zoro" })).toBeInTheDocument();
    });

    test("a language the browser cannot recognise switches to typing and says how to fix it", async () => {
        renderAssistant();
        await activate();
        act(() => { live()[0].onerror({ error: "language-not-supported" }); });
        expect(screen.getByRole("status")).toHaveTextContent("This browser can't recognise English (India). Choose another English in Zoro's listening settings, or type to Zoro.");
        await finishSpeaking();
        expect(live()).toHaveLength(0);
    });

    test("a microphone that keeps stopping at once is not restarted forever", async () => {
        renderAssistant();
        await activate();
        for (let i = 0; i < 5; i++) {
            const s = live()[0];
            act(() => { s.aborted = true; s.onend(); }); // ends as soon as it starts
            // Wait only until the next attempt starts (each attempt waits a little longer).
            for (let waited = 0; waited < 3000 && !live().length; waited += 50) act(() => { jest.advanceTimersByTime(50); });
            if (!live().length) break;
        }
        expect(spoken().join(" ")).toMatch(/I couldn't keep the microphone on/);
        await finishSpeaking();
        expect(live()).toHaveLength(0);
        expect(sessions.length).toBeLessThanOrEqual(6);
    });

    test("misheard twice in a row: Zoro says typing is an option", async () => {
        zoroTurn.mockImplementation(async (text, conv) => ({ conv, reply: { message: "Sorry, I didn't catch that. Which colour?", expect: "answer", choices: [], unclear: true } }));
        renderAssistant();
        await activate();
        say("mumble");
        await settle();
        expect(spoken().join(" ")).not.toMatch(/Type to Zoro/);
        await finishSpeaking();
        say("mumble again");
        await settle();
        expect(screen.getByRole("status")).toHaveTextContent(TYPE_HINT);
    });
});

// ---------------------------------------------------------------- speaking

describe("speech controls", () => {
    test("Mute: replies are shown and handed to the live region instead of spoken; unmuting speaks again", async () => {
        renderAssistant();
        await activate();
        const mute = screen.getByRole("button", { name: "Mute voice" });
        fireEvent.click(mute);
        expect(mute).toHaveAttribute("aria-pressed", "true");
        say("open shoes");
        await settle();
        expect(speaking).toHaveLength(0);
        expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
        expect(screen.getByRole("status")).toHaveTextContent("Opening shoes.");
        act(() => { jest.advanceTimersByTime(15000); });
        fireEvent.click(mute);
        expect(mute).toHaveAttribute("aria-pressed", "false");
        expect(spoken()).toEqual(["Speech is on."]); // nothing is waiting for an answer, so only the note
    });

    test("Repeat says the last reply again and the same question stays open", async () => {
        zoroTurn.mockImplementationOnce(ask("Which colour?", [{ label: "Black", say: "black" }]));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        await finishSpeaking();
        fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
        expect(spoken()).toEqual(["Which colour?"]);
        await finishSpeaking();
        expect(within(screen.getByRole("group", { name: "Answer Zoro" })).getByRole("button", { name: "Black" })).toBeInTheDocument();
        say("black");
        await settle();
        expect(zoroTurn).toHaveBeenCalledTimes(2);
    });

    test("Stop speaking, then Resume reply, says only what was not said yet", async () => {
        zoroTurn.mockImplementationOnce(ask(LONG_REPLY));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        const first = spoken()[0];
        expect(first.length).toBeLessThan(LONG_REPLY.length);
        act(() => { speaking[0].onend(); }); // the first part finished; the second is playing
        const second = spoken()[1];
        fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
        await settle();
        speaking = [];
        fireEvent.click(screen.getByRole("button", { name: "Resume reply" }));
        act(() => { jest.advanceTimersByTime(60); }); // speech waits a moment after a cancel
        expect(spoken()[0]).toBe(second);
        expect(spoken()).not.toContain(first);
    });

    test('saying "resume" continues a stopped reply', async () => {
        zoroTurn.mockImplementationOnce(ask(LONG_REPLY));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
        await settle();
        speaking = [];
        say("resume please");
        await settle();
        expect(zoroTurn).toHaveBeenCalledTimes(1); // handled by the assistant, not the conversation
        expect(LONG_REPLY.startsWith(spoken()[0])).toBe(true);
    });

    test("Slower and Normal speed change the rate, say so, and the question stays open", async () => {
        zoroTurn.mockImplementationOnce(ask("Which colour?"));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        await finishSpeaking();
        fireEvent.click(screen.getByRole("button", { name: "Slower" }));
        expect(spoken()).toEqual(["Okay, slower. Which colour?"]);
        expect(speaking[0].rate).toBe(0.8);
        await finishSpeaking();
        fireEvent.click(screen.getByRole("button", { name: "Normal speed" }));
        expect(speaking[0].rate).toBe(0.95);
        expect(spoken()).toEqual(["Okay, normal speed. Which colour?"]);
    });

    test("Slower while Zoro talks slows the rest of the reply without interrupting it", async () => {
        zoroTurn.mockImplementationOnce(ask(LONG_REPLY));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        const cancels = window.speechSynthesis.cancel.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Slower" }));
        expect(window.speechSynthesis.cancel.mock.calls.length).toBe(cancels);
        act(() => { speaking[0].onend(); });
        expect(speaking[1].rate).toBe(0.8); // the next part of the same reply
    });

    test("typing while Zoro talks interrupts it and is handled like speech; typing alone never cuts Zoro off", async () => {
        zoroTurn.mockImplementationOnce(ask(LONG_REPLY));
        renderAssistant();
        await activate();
        say("find shoes");
        await settle();
        const box = screen.getByRole("textbox", { name: "Type to Zoro" });
        const cancels = window.speechSynthesis.cancel.mock.calls.length;
        fireEvent.change(box, { target: { value: "option 2" } });
        expect(window.speechSynthesis.cancel.mock.calls.length).toBe(cancels); // a re-render does not stop speech
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        expect(screen.getByText("You typed")).toBeInTheDocument();
        await settle();
        expect(window.speechSynthesis.cancel.mock.calls.length).toBe(cancels + 1);
        expect(zoroTurn).toHaveBeenCalledTimes(2);
        expect(zoroTurn.mock.calls[1][0]).toBe("option 2");
        expect(zoroTurn.mock.calls[1][3]).toEqual({ source: "typed" });
    });

    test("when the browser cannot play speech, Zoro says so on screen and keeps the conversation going", async () => {
        window.speechSynthesis.speak = (u) => { speaking.push(u); u.onerror({ error: "synthesis-failed" }); };
        renderAssistant();
        fireEvent.click(micButton());
        await settle();
        expect(screen.getByText(/This browser couldn't play Zoro's voice/)).toBeInTheDocument();
        expect(live()).toHaveLength(1); // listening anyway
    });
});
