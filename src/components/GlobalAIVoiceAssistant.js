import React, { useEffect, useReducer, useRef, useContext, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TTSContext, ThemeContext, SearchContext, UserContext } from '../App';
import { executeAction, resolvePending } from '../services/voiceActions';
import { loadCatalog, loadCategory } from '../services/catalogService';
import { interpretCommand } from '../services/groqVoiceService';
import { voiceReducer, initialVoiceState, S, LISTENING_STATES, SESSION_STATES, WAKE_PHRASE, stripWakeWord } from '../services/voiceMachine';
import { zoroTurn, createConversation, pauseConversation, resumeMessage, zoroAuthEvent, legacyChoices, stripPolite, INACTIVITY_MESSAGE } from '../services/zoroDialogue';
import {
    speakText, cancelSpeech, announce, changeSpeechRate, getSpeechRate, setSpeechRate, setAssistantBusy, NORMAL_RATE,
    watchVoices, subscribeVoices, englishVoices, getChosenVoice, setChosenVoice, resetVoice,
} from '../services/announcer';
import { getRecognitionClass, startRecognitionSession, recognitionProblem } from '../services/speechInput';
import {
    SPEECH_LANGUAGES, getSpeechLanguage, setSpeechLanguage, PAUSE_OPTIONS, getListeningPause, setListeningPause, pauseMs,
    isZoroMuted, setZoroMuted,
} from '../services/speechSettings';
import { addToCart } from '../services/cartStore';
import { apiRequest } from '../services/apiClient';
import { getBilling, getSignIn, getCurrentProduct, waitForHandlers, AUTH_RESULT_EVENT } from '../services/voiceContext';
import { normalizeSpeech } from '../services/speechParsers';
import Icon from './Icon';
import './GlobalAIVoiceAssistant.css';

// Other components (e.g. the header Voice button) open the assistant with this event.
export const VOICE_ACTIVATE_EVENT = 'VOICE_ASSISTANT_ACTIVATE';
export const VOICE_STATE_EVENT = 'VOICE_ASSISTANT_STATE';

/** Two minutes without meaningful activity pause the conversation and release the microphone. */
export const INACTIVITY_MS = 2 * 60 * 1000;
export const TAB_HIDDEN_MESSAGE = "I've paused listening because you left this tab. Press the microphone button or Alt+V when you need me.";
export const TYPE_HINT = 'If I keep mishearing you, type your answer in the "Type to Zoro" box instead.';
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_QUICK_ENDS = 5;      // sessions that end at once, in a row, before giving up on the microphone
const QUICK_END_MS = 1000;
const RESTART_DELAY_MS = 250;
const ECHO_WINDOW_MS = 3000;

// Handled locally so these always work, even without the AI service.
const STOP_LISTENING = /^(stop listening|go to sleep|cancel listening|turn off|turn yourself off|stop zoro|zoro stop|goodbye( zoro)?|bye( zoro)?)$/;
const BARE_STOP = /^(stop|be quiet)$/;
const RESUME = /^(resume|continue (speaking|talking|reading)|keep going|carry on|go on)$/;

const STATUS_LABEL = {
    [S.DISABLED]: 'Unavailable',
    [S.IDLE]: 'Off',
    [S.WAKE_WORD_LISTENING]: `Waiting for "${WAKE_PHRASE}"`,
    [S.COMMAND_LISTENING]: 'Listening',
    [S.PROCESSING]: 'Thinking',
    [S.AWAITING_CONFIRMATION]: 'Waiting for your answer',
    [S.SPEAKING]: 'Speaking',
    [S.PAUSED]: 'Paused',
    [S.ERROR]: 'Problem',
};

// Visual treatment per state (a CSS modifier and an icon); the text label always accompanies it.
const STATUS_VIEW = {
    [S.DISABLED]: { tone: 'error', icon: 'micOff' },
    [S.IDLE]: { tone: 'idle', icon: 'mic' },
    [S.WAKE_WORD_LISTENING]: { tone: 'waiting', icon: 'mic' },
    [S.COMMAND_LISTENING]: { tone: 'listening', icon: 'mic' },
    [S.PROCESSING]: { tone: 'processing', icon: 'wave' },
    [S.AWAITING_CONFIRMATION]: { tone: 'confirm', icon: 'question' },
    [S.SPEAKING]: { tone: 'speaking', icon: 'volume' },
    [S.PAUSED]: { tone: 'idle', icon: 'mic' },
    [S.ERROR]: { tone: 'error', icon: 'alert' },
};

const SPEEDS = [{ value: 'slower', label: 'Slow', rate: 0.8 }, { value: 'normal', label: 'Normal', rate: NORMAL_RATE }, { value: 'faster', label: 'Fast', rate: 1.15 }];
const speedFor = (rate) => (rate < NORMAL_RATE - 0.05 ? 'slower' : rate > NORMAL_RATE + 0.1 ? 'faster' : 'normal');
const languageLabel = (code) => (SPEECH_LANGUAGES.find((l) => l.code === code) || SPEECH_LANGUAGES[0]).label;
const SOURCE_LABEL = { voice: 'You said', typed: 'You typed', button: 'You chose' };

/**
 * Recognition picking up Zoro's own sentence (speakers near the microphone): a long stretch of
 * what Zoro just said. Short answers that repeat an offered option ("email and password",
 * "yes, place order") are real answers and are kept.
 */
function isEcho(text, last) {
    if (!last || !last.text || Date.now() - last.at > ECHO_WINDOW_MS) return false;
    const heard = normalizeSpeech(text);
    const words = heard.split(' ').length;
    return words >= 4 && words >= normalizeSpeech(last.text).split(' ').length / 2 && normalizeSpeech(last.text).includes(heard);
}

const toOutcome = (reply) => {
    if (reply.expect === 'stop') return { type: 'stop', message: reply.message };
    if (reply.expect === 'keyboard') return { type: 'keyboard', message: reply.message };
    if (reply.expect === 'answer') return { type: 'ask', message: reply.message, pending: { kind: 'zoro', choices: reply.choices || [] } };
    return { type: 'done', message: reply.message };
};

export default function GlobalAIVoiceAssistant() {
    const navigate = useNavigate();
    const { user } = useContext(UserContext);
    const { screenReader, changeScreenReader } = useContext(TTSContext);
    const { theme, chooseTheme } = useContext(ThemeContext);
    const { setValueToBeSearched } = useContext(SearchContext);

    const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
    const stateRef = useRef(state);
    stateRef.current = state;

    const ctxRef = useRef({});
    ctxRef.current = { navigate, user, screenReader, changeScreenReader, theme, chooseTheme, setValueToBeSearched };

    // The conversation (memory only; reset when Zoro is turned off).
    const convRef = useRef(createConversation());
    const greetedRef = useRef(false);
    const lastActivityRef = useRef(Date.now());
    const lastSpokenRef = useRef(null);
    const baseMessageRef = useRef('');       // the last reply, without "repeat" or setting notes

    const recognitionRef = useRef(null);     // { controller, mode, lang, startedAt }
    const permissionDeniedRef = useRef(false);
    const [micBlocked, setMicBlocked] = useState(false);
    const [micLive, setMicLive] = useState(false);
    const supported = Boolean(getRecognitionClass());
    // Typing only: no recognition in this browser, or it cannot be used (language, service, repeated errors).
    const [typingOnly, setTypingOnlyState] = useState(!supported);
    const typingOnlyRef = useRef(!supported);
    const setTypingOnly = (value) => { typingOnlyRef.current = value; setTypingOnlyState(value); };
    const errorCountRef = useRef(0);
    const quickEndsRef = useRef(0);
    const unclearRef = useRef(0);
    const lastRunCommandRef = useRef(0);
    const abortRef = useRef(null);

    // Speech and listening settings (remembered on this device).
    const [speed, setSpeed] = useState(() => speedFor(getSpeechRate()));
    const [language, setLanguage] = useState(getSpeechLanguage);
    const [pause, setPause] = useState(getListeningPause);
    const [muted, setMutedState] = useState(isZoroMuted);
    const mutedRef = useRef(muted);
    const [voiceChoice, setVoiceChoice] = useState(getChosenVoice);
    const [voiceOptions, setVoiceOptions] = useState([]);
    const [resumable, setResumable] = useState(null);   // { message, chunks } of a reply stopped part-way
    const [speechFailed, setSpeechFailed] = useState(false);

    const [typed, setTyped] = useState('');
    const [typedNote, setTypedNote] = useState('');
    const typedInputRef = useRef(null);
    const focusTypingRef = useRef(false);

    const markActivity = () => { lastActivityRef.current = Date.now(); };
    const voiceOn = supported && !typingOnly;

    // Installed voices load asynchronously; keep the settings list current.
    useEffect(() => {
        watchVoices();
        const update = () => setVoiceOptions(englishVoices(getSpeechLanguage()));
        update();
        return subscribeVoices(update);
    }, []);
    useEffect(() => setVoiceOptions(englishVoices(language)), [language]);

    const stopRecognition = useCallback(() => {
        const current = recognitionRef.current;
        recognitionRef.current = null;
        if (current) current.controller.abort();
        setMicLive(false);
    }, []);

    const switchToTyping = useCallback((message) => {
        if (stateRef.current.status === S.WAKE_WORD_LISTENING) {
            // Waiting for "Hey Zoro" cannot work without the microphone: turn it off and say why.
            stopRecognition();
            dispatch({ type: 'DISABLE', message });
            return;
        }
        setTypingOnly(true);
        recognitionRef.current && recognitionRef.current.controller.abort();
        recognitionRef.current = null;
        setMicLive(false);
        const { status, pending } = stateRef.current;
        const after = status === S.AWAITING_CONFIRMATION ? S.AWAITING_CONFIRMATION : S.COMMAND_LISTENING;
        dispatch({ type: 'SAY', message, after, pending: after === S.AWAITING_CONFIRMATION ? pending : null });
    }, [stopRecognition]);

    const startRecognition = useCallback((mode) => {
        const Recognition = getRecognitionClass();
        if (!Recognition || permissionDeniedRef.current || typingOnlyRef.current) return;
        stopRecognition();

        const lang = getSpeechLanguage();
        const session = { mode, lang, pause: getListeningPause(), controller: null, startedAt: Date.now() };
        session.controller = startRecognitionSession(Recognition, {
            lang,
            mode: mode === 'wake' ? 'wake' : 'command',
            pauseMs: pauseMs(),
            onAudio: (on) => { if (recognitionRef.current === session) setMicLive(on); },
            onInterim: (text) => { if (recognitionRef.current === session && text) dispatch({ type: 'INTERIM', text }); },
            onUtterance: ({ text, alternatives, confidence }) => {
                if (recognitionRef.current !== session) return false;
                if (isEcho(text, lastSpokenRef.current)) return false; // Zoro hearing itself: keep listening
                errorCountRef.current = 0;
                quickEndsRef.current = 0;
                const heard = { source: 'voice', confidence, alternatives };
                if (mode === 'wake') {
                    const remainder = stripWakeWord(text);
                    if (remainder === null) return false; // not addressed to Zoro
                    markActivity();
                    if (remainder.length > 2) dispatch({ type: 'WAKE_WITH_COMMAND', text: remainder, heard: { ...heard, alternatives: [] } });
                    else dispatch({ type: 'WAKE', message: resumeMessage(convRef.current, false) });
                    return true;
                }
                const command = stripWakeWord(text) ?? text;
                if (!command.trim()) return false; // only "Hey Zoro": keep listening
                markActivity();
                dispatch({ type: 'TRANSCRIPT', text: command, heard: command === text ? heard : { ...heard, alternatives: [] } });
                return true;
            },
            onError: (code) => {
                if (recognitionRef.current !== session) return;
                const problem = recognitionProblem(code, languageLabel(lang));
                if (!problem) return; // silence: the session ends and listening restarts
                if (problem.kind === 'blocked') {
                    permissionDeniedRef.current = true;
                    setMicBlocked(true);
                    dispatch({ type: 'MIC_BLOCKED', message: problem.message });
                    return;
                }
                if (problem.fatal) {
                    switchToTyping(problem.message);
                    return;
                }
                errorCountRef.current += 1;
                if (errorCountRef.current >= MAX_CONSECUTIVE_ERRORS) {
                    switchToTyping(`Voice input keeps failing: ${problem.reason}. I've switched to typing, so type to me in the box below. To try the microphone again, turn me off and on.`);
                } else if (errorCountRef.current === 1) {
                    dispatch({ type: 'ERROR', message: problem.message }); // said once; later retries are silent
                }
            },
            onEnd: () => {
                if (recognitionRef.current !== session) return;
                recognitionRef.current = null;
                setMicLive(false);
                quickEndsRef.current = Date.now() - session.startedAt < QUICK_END_MS ? quickEndsRef.current + 1 : 0;
                if (quickEndsRef.current >= MAX_QUICK_ENDS) {
                    quickEndsRef.current = 0;
                    switchToTyping("I couldn't keep the microphone on. You can type to me in the box below, or turn me off and on to try again.");
                    return;
                }
                // Browsers end a recognition session after silence; keep listening while the
                // conversation is active (the two-minute inactivity rule ends it). Repeated failures wait longer.
                const backoff = Math.max(1, quickEndsRef.current, errorCountRef.current * 2);
                setTimeout(() => {
                    const status = stateRef.current.status;
                    if (recognitionRef.current || permissionDeniedRef.current || typingOnlyRef.current) return;
                    if (mode === 'wake' && status === S.WAKE_WORD_LISTENING) startRecognition('wake');
                    else if (mode !== 'wake' && (status === S.COMMAND_LISTENING || status === S.AWAITING_CONFIRMATION)) startRecognition('command');
                }, RESTART_DELAY_MS * backoff);
            },
        });
        recognitionRef.current = session;

        try {
            session.controller.rec.start();
        } catch (e) {
            recognitionRef.current = null;
            dispatch({ type: 'ERROR', message: 'Could not start the microphone.' });
        }
    }, [stopRecognition, switchToTyping]);

    // Recognition runs only while listening, in the mode, language and pause setting that match.
    useEffect(() => {
        const wanted = !voiceOn || !LISTENING_STATES.includes(state.status) ? null : state.status === S.WAKE_WORD_LISTENING ? 'wake' : 'command';
        const current = recognitionRef.current;
        if (!wanted) {
            if (current) stopRecognition();
        } else if (!current || current.mode !== wanted || current.lang !== language || current.pause !== pause) {
            startRecognition(wanted);
        }
    }, [state.status, startRecognition, stopRecognition, voiceOn, language, pause]);

    // Two minutes without activity: pause, release the microphone, keep the conversation.
    useEffect(() => {
        if (state.status !== S.COMMAND_LISTENING && state.status !== S.AWAITING_CONFIRMATION) return undefined;
        const remaining = Math.max(0, INACTIVITY_MS - (Date.now() - lastActivityRef.current));
        const timer = setTimeout(() => {
            convRef.current = pauseConversation(convRef.current);
            dispatch({ type: 'PAUSE', message: INACTIVITY_MESSAGE });
        }, remaining);
        return () => clearTimeout(timer);
    }, [state.status]);

    // Leaving the tab pauses the conversation as inactivity does: the microphone is released and a
    // pending add-to-cart or order question is dropped, so it must be asked and confirmed again.
    // A request already running (for example placing an order) finishes first; the pause follows.
    const [tabHidden, setTabHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    useEffect(() => {
        const onVisibility = () => setTabHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);
    useEffect(() => {
        if (!tabHidden || (state.status !== S.COMMAND_LISTENING && state.status !== S.AWAITING_CONFIRMATION)) return;
        convRef.current = pauseConversation(convRef.current);
        dispatch({ type: 'PAUSE', message: TAB_HIDDEN_MESSAGE, reason: 'hidden' });
    }, [tabHidden, state.status]);

    const applyMuted = useCallback((value) => {
        mutedRef.current = setZoroMuted(value);
        setMutedState(mutedRef.current);
        if (mutedRef.current && stateRef.current.status === S.SPEAKING) cancelSpeech();
    }, []);

    // Run each command exactly once.
    useEffect(() => {
        if (state.status !== S.PROCESSING || lastRunCommandRef.current === state.commandId) return undefined;
        const commandId = state.commandId;
        const text = state.transcript;
        const heard = state.heard || { source: 'voice' };
        lastRunCommandRef.current = commandId;
        const controller = new AbortController();
        abortRef.current = controller;

        const cleaned = stripPolite(normalizeSpeech(text).replace(/[^a-z ]/g, '').trim());
        const asking = convRef.current.confirm || convRef.current.step || convRef.current.legacyPending;
        if (STOP_LISTENING.test(cleaned) || (BARE_STOP.test(cleaned) && !asking)) {
            convRef.current = { ...createConversation(), guestChosen: convRef.current.guestChosen };
            dispatch({ type: 'OUTCOME', commandId, outcome: { type: 'stop', message: "Okay, I've stopped listening. Press the microphone or Alt+V when you need me." } });
            return undefined;
        }
        if (RESUME.test(cleaned)) {
            const after = convRef.current.lastExpect === 'answer' ? S.AWAITING_CONFIRMATION : S.COMMAND_LISTENING;
            const outcome = resumable
                ? { type: 'resume', message: resumable.message, chunks: resumable.chunks, after }
                : { type: 'resume', message: baseMessageRef.current || "I haven't said anything yet. How can I help you?", after };
            dispatch({ type: 'OUTCOME', commandId, outcome });
            return undefined;
        }

        const c = ctxRef.current;
        const legacyCtx = {
            user: c.user,
            signal: controller.signal,
            navigate: (path) => ctxRef.current.navigate(path),
            goBack: () => ctxRef.current.navigate(-1),
            setSearch: (value) => ctxRef.current.setValueToBeSearched(value),
            toggleContrast: () => ctxRef.current.chooseTheme(ctxRef.current.theme === 'noir' ? 'ivory' : 'noir'),
            toggleScreenReader: () => ctxRef.current.changeScreenReader(!ctxRef.current.screenReader),
        };
        const env = {
            user: c.user,
            // Shared and cached by the catalog service; a failed load reaches Zoro as an error, never as "no products".
            products: (scope) => (scope && scope.category ? loadCategory(scope.category) : loadCatalog()),
            interpret: (said, products, options = {}) => interpretCommand(said, products, { signal: controller.signal, ...options }),
            legacyRun: (action, products) => executeAction(action, legacyCtx, products),
            legacyResolve: (pending, said) => resolvePending(pending, said, legacyCtx),
            navigate: (path) => ctxRef.current.navigate(path),
            setSpeechRate: (change) => setSpeed(speedFor(changeSpeechRate(change))),
            setMuted: applyMuted,
            addToCart: (item, quantity) => addToCart(item, c.user, quantity),
            signIn: () => waitForHandlers(getSignIn),
            billing: ({ wait = true } = {}) => (wait ? waitForHandlers(getBilling) : Promise.resolve(getBilling())),
            quote: () => apiRequest('/api/checkout/quote', { body: {}, signal: controller.signal }),
            currentProduct: getCurrentProduct,
        };
        zoroTurn(text, convRef.current, env, heard)
            .then(({ conv, reply }) => {
                if (controller.signal.aborted) return;
                errorCountRef.current = 0;
                convRef.current = conv;
                const outcome = toOutcome(reply);
                // Misheard more than once in a row: say plainly that typing is an option.
                unclearRef.current = reply.unclear ? unclearRef.current + 1 : 0;
                if (unclearRef.current === 2 && heard.source === 'voice') outcome.message = `${outcome.message} ${TYPE_HINT}`;
                dispatch({ type: 'OUTCOME', commandId, outcome });
            })
            .catch((e) => {
                if (e.name === 'AbortError') return;
                console.error('Voice command error:', e);
                dispatch({ type: 'OUTCOME', commandId, outcome: { type: 'done', message: 'Sorry, something went wrong. Nothing was changed. Please try again.' } });
            });
        return undefined;
        // `resumable` is read when the command runs; it is not a reason to run a command again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.status, state.commandId, state.transcript, state.heard, applyMuted]);

    // Speak (or hand to the live region), then continue. The microphone is off meanwhile.
    useEffect(() => {
        if (state.status !== S.SPEAKING && state.status !== S.ERROR) return undefined;
        let cancelled = false;
        const message = state.message;
        if (!state.replay && state.status === S.SPEAKING) baseMessageRef.current = message;
        const done = () => {
            if (cancelled) return;
            lastSpokenRef.current = { text: message, at: Date.now() };
            markActivity(); // the shopper's two minutes start once Zoro has finished talking
            dispatch({ type: state.status === S.ERROR ? 'RECOVER' : 'SPEECH_DONE' });
        };
        if (ctxRef.current.screenReader && !mutedRef.current) {
            speakText(message, { fromAssistant: true, chunks: state.speakChunks || undefined }).then((result) => {
                if (cancelled) return;
                setResumable(result.status === 'stopped' && result.remaining.length ? { message, chunks: result.remaining } : null);
                setSpeechFailed(result.status === 'failed' || result.status === 'unavailable');
                done();
            });
        } else {
            // A native screen reader reads the live region; wait roughly as long before listening again.
            const t = setTimeout(done, Math.min(15000, 1200 + message.split(/\s+/).length * 450));
            return () => { cancelled = true; clearTimeout(t); };
        }
        return () => { cancelled = true; };
    }, [state.status, state.message, state.speakId, state.speakChunks, state.replay]);

    // Sign-in results continue a voice sign-in (welcome, or what went wrong).
    useEffect(() => {
        const onAuth = (event) => {
            const result = zoroAuthEvent(convRef.current, event.detail || {}, { navigate: (path) => ctxRef.current.navigate(path) });
            if (!result) return;
            convRef.current = result.conv;
            markActivity();
            const asking = result.reply.expect === 'answer';
            dispatch({ type: 'SAY', message: result.reply.message, after: asking ? S.AWAITING_CONFIRMATION : S.COMMAND_LISTENING, pending: asking ? { kind: 'zoro', choices: result.reply.choices } : null });
        };
        window.addEventListener(AUTH_RESULT_EVENT, onAuth);
        return () => window.removeEventListener(AUTH_RESULT_EVENT, onAuth);
    }, []);

    // When Zoro turns itself off (permission denied, errors), the panel closes, so announce why.
    const previousStatusRef = useRef(state.status);
    useEffect(() => {
        const previous = previousStatusRef.current;
        previousStatusRef.current = state.status;
        if ((state.status === S.IDLE || state.status === S.DISABLED) && previous !== state.status && previous !== S.SPEAKING) announce(state.message);
    }, [state.status, state.message]);

    // Stop everything on unmount.
    useEffect(() => () => {
        stopRecognition();
        if (abortRef.current) abortRef.current.abort();
        cancelSpeech();
    }, [stopRecognition]);

    const activate = useCallback(({ typing = false } = {}) => {
        const voice = supported && !typing;
        setTypingOnly(!voice);
        permissionDeniedRef.current = false;
        setMicBlocked(false);
        errorCountRef.current = 0;
        quickEndsRef.current = 0;
        unclearRef.current = 0;
        cancelSpeech();
        markActivity();
        let message = resumeMessage(convRef.current, !greetedRef.current);
        if (!voice) {
            message += supported
                ? ' Type your request in the box below.'
                : " Voice input isn't available in this browser, so type your request in the box below.";
            focusTypingRef.current = true;
        }
        greetedRef.current = true;
        dispatch({ type: 'ENABLE', message });
    }, [supported]);

    const turnOff = useCallback(() => {
        if (abortRef.current) abortRef.current.abort();
        cancelSpeech();
        convRef.current = { ...createConversation(), guestChosen: convRef.current.guestChosen };
        setResumable(null);
        dispatch({ type: 'DISABLE' });
    }, []);

    const sessionActive = SESSION_STATES.includes(state.status) || state.status === S.WAKE_WORD_LISTENING || state.status === S.ERROR;
    const toggle = useCallback(() => {
        const status = stateRef.current.status;
        if (SESSION_STATES.includes(status) || status === S.WAKE_WORD_LISTENING) turnOff();
        else activate();
    }, [activate, turnOff]);

    // Typing mode opened by a button press: move to the text box once the panel is shown.
    useEffect(() => {
        if (focusTypingRef.current && sessionActive && typedInputRef.current) {
            focusTypingRef.current = false;
            typedInputRef.current.focus();
        }
    }, [sessionActive, typingOnly]);

    // Header Voice button, Alt+V shortcut, and Escape to interrupt speech.
    useEffect(() => {
        const onActivate = () => {
            const status = stateRef.current.status;
            if (!SESSION_STATES.includes(status)) activate();
        };
        const onKey = (e) => {
            if (e.altKey && e.code === 'KeyV') {
                e.preventDefault();
                toggle();
            } else if (e.key === 'Escape' && window.speechSynthesis && window.speechSynthesis.speaking) {
                cancelSpeech();
            }
        };
        window.addEventListener(VOICE_ACTIVATE_EVENT, onActivate);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener(VOICE_ACTIVATE_EVENT, onActivate);
            window.removeEventListener('keydown', onKey);
        };
    }, [toggle, activate]);

    // Page speech waits while Zoro thinks or talks.
    useEffect(() => {
        setAssistantBusy(state.status === S.PROCESSING || state.status === S.SPEAKING);
    }, [state.status]);
    useEffect(() => () => setAssistantBusy(false), []);

    // Let the header Voice button reflect the state.
    useEffect(() => {
        window.dispatchEvent(new CustomEvent(VOICE_STATE_EVENT, { detail: { status: state.status, awake: SESSION_STATES.includes(state.status) } }));
    }, [state.status]);

    const speaksAloud = screenReader && !muted;
    const answering = state.status === S.COMMAND_LISTENING || state.status === S.AWAITING_CONFIRMATION;

    /**
     * Repeat: says the last reply again. With a note ("Okay, slower."), says the note, followed by the
     * open question if one is waiting for an answer (as the spoken "speak more slowly" does).
     */
    const sayAgain = (note = '') => {
        if (!answering) return;
        const last = baseMessageRef.current || state.message;
        const question = state.status === S.AWAITING_CONFIRMATION ? last : '';
        dispatch({ type: 'REPLAY', message: !note ? last : question ? `${note} ${question}` : note });
    };

    const stopSpeaking = () => {
        cancelSpeech();
        if (!speaksAloud) dispatch({ type: 'SPEECH_DONE' });
    };

    const resumeSpeaking = () => {
        if (!resumable || !answering) return;
        markActivity();
        dispatch({ type: 'REPLAY', message: resumable.message, chunks: resumable.chunks });
        setResumable(null);
    };

    const changeSpeed = (value) => {
        setSpeechRate(SPEEDS.find((s) => s.value === value).rate);
        setSpeed(value);
        markActivity();
    };

    const stepSpeed = (change) => {
        setSpeed(speedFor(changeSpeechRate(change)));
        markActivity();
        // While Zoro talks, the rest of the reply uses the new speed; otherwise it confirms aloud.
        if (state.status !== S.SPEAKING) sayAgain(change === 'slower' ? 'Okay, slower.' : 'Okay, normal speed.');
    };

    const toggleMute = () => {
        applyMuted(!mutedRef.current);
        markActivity();
        if (!mutedRef.current) sayAgain('Speech is on.');
    };

    const changeLanguage = (code) => {
        const next = setSpeechLanguage(code);
        setLanguage(next);
        resetVoice();
        markActivity();
        sayAgain(`Okay, I'll listen for ${languageLabel(next)}.`);
    };

    const changeVoice = (voiceURI) => {
        setChosenVoice(voiceURI);
        setVoiceChoice(voiceURI);
        markActivity();
        sayAgain('This is the voice I will use.');
    };

    const changePause = (value) => {
        setPause(setListeningPause(value));
        markActivity();
    };

    const submitTyped = (event) => {
        event.preventDefault();
        const text = typed.trim();
        if (!text) return;
        const { status, afterSpeech } = stateRef.current;
        const ready = status === S.COMMAND_LISTENING || status === S.AWAITING_CONFIRMATION ||
            (status === S.SPEAKING && (afterSpeech === S.COMMAND_LISTENING || afterSpeech === S.AWAITING_CONFIRMATION));
        if (!ready) {
            setTypedNote('Zoro is still working on your last request. Send this again in a moment.');
            return;
        }
        if (status === S.SPEAKING) cancelSpeech();
        markActivity();
        setTypedNote('');
        setTyped('');
        dispatch({ type: 'TYPED', text });
    };

    const panelOpen = sessionActive;
    const listening = voiceOn && LISTENING_STATES.includes(state.status);
    const view = STATUS_VIEW[state.status] || STATUS_VIEW[S.IDLE];
    let statusLabel = STATUS_LABEL[state.status];
    if (state.status === S.COMMAND_LISTENING) statusLabel = !voiceOn ? 'Ready for you to type' : micLive ? 'Listening' : 'Starting the microphone';
    const pending = state.status === S.AWAITING_CONFIRMATION ? state.pending : null;
    const choices = !pending ? [] : pending.kind === 'zoro' ? pending.choices : legacyChoices(pending);
    // A click on an answer is handled exactly like the same words spoken (same commandId guard).
    const answer = (words) => { markActivity(); dispatch({ type: 'TRANSCRIPT', text: words, heard: { source: 'button' } }); };
    const autoVoice = voiceOptions[0];

    return (
        <div className={`assistant assistant--${view.tone}${panelOpen ? ' is-active' : ''}`}>
            {panelOpen && (
                <section className="assistant__panel" aria-label="Zoro voice assistant">
                    <header className="assistant__header">
                        <div>
                            <p className="assistant__eyebrow">Zoro · VoiceCart assistant</p>
                            <p className="assistant__state">
                                <span className="assistant__indicator" aria-hidden="true">
                                    {listening && (micLive || state.status !== S.COMMAND_LISTENING) ? <span className="assistant__bars"><span /><span /><span /></span> : <Icon name={view.icon} size={16} />}
                                </span>
                                {statusLabel}
                            </p>
                        </div>
                        <button type="button" className="assistant__icon-btn" aria-label="Turn off Zoro" onClick={turnOff}>
                            <Icon name="close" size={20} />
                        </button>
                    </header>

                    {state.transcript ? (
                        <p className="assistant__transcript"><span className="assistant__label">{SOURCE_LABEL[(state.heard && state.heard.source) || 'voice']}</span>“{state.transcript}”</p>
                    ) : null}

                    {/* Live region only when Zoro is not speaking aloud, so nothing is announced twice. */}
                    <div className="assistant__message" aria-live={speaksAloud ? 'off' : 'polite'} role="status">
                        <span key={state.speakId}>{state.message}</span>
                    </div>
                    {speechFailed && speaksAloud ? (
                        <p className="assistant__note assistant__note--flush">This browser couldn't play Zoro's voice. Replies are shown here; turn off the built-in screen reader to have your own screen reader read them.</p>
                    ) : null}

                    {choices.length ? (
                        <div className="assistant__choices" role="group" aria-label="Answer Zoro">
                            {choices.map((c) => (
                                <button
                                    key={`${c.label}-${c.say}`}
                                    type="button"
                                    className={`assistant__choice${c.quiet ? ' assistant__choice--quiet' : ''}`}
                                    onClick={() => answer(c.say)}
                                >
                                    {c.label}
                                </button>
                            ))}
                        </div>
                    ) : null}

                    <div className="assistant__controls" role="group" aria-label="Zoro's voice">
                        {state.status === S.SPEAKING ? (
                            <button type="button" className="assistant__control assistant__stop--speech" onClick={stopSpeaking}>Stop speaking</button>
                        ) : resumable && answering ? (
                            <button type="button" className="assistant__control" onClick={resumeSpeaking}>Resume reply</button>
                        ) : null}
                        <button type="button" className="assistant__control" onClick={() => sayAgain()} disabled={!answering}>Repeat</button>
                        {screenReader ? (
                            <>
                                <button type="button" className="assistant__control" onClick={() => stepSpeed('slower')} disabled={!answering && state.status !== S.SPEAKING}>Slower</button>
                                <button type="button" className="assistant__control" onClick={() => stepSpeed('normal')} disabled={(!answering && state.status !== S.SPEAKING) || speed === 'normal'}>Normal speed</button>
                                <button type="button" className="assistant__control" aria-pressed={muted} onClick={toggleMute}>Mute voice</button>
                            </>
                        ) : null}
                    </div>

                    <form className="assistant__type" onSubmit={submitTyped}>
                        <label className="assistant__label" htmlFor="zoro-typed">Type to Zoro</label>
                        <div className="assistant__type-row">
                            <input
                                id="zoro-typed"
                                ref={typedInputRef}
                                type="text"
                                value={typed}
                                maxLength={300}
                                autoComplete="off"
                                onChange={(e) => { setTyped(e.target.value); markActivity(); }}
                                aria-describedby="zoro-typed-note"
                            />
                            <button type="submit" className="assistant__control assistant__control--send">Send</button>
                        </div>
                        <p id="zoro-typed-note" className="assistant__note assistant__note--flush">
                            {voiceOn ? 'Typed answers work like speech.' : 'Voice input is off; type your requests and answers here.'}
                            {/* Only this note is announced; Zoro itself says when typing takes over. */}
                            <span aria-live="polite">{typedNote ? ` ${typedNote}` : ''}</span>
                        </p>
                    </form>

                    <footer className="assistant__footer">
                        <p className="assistant__hint">Pauses after 2 minutes without activity. <kbd>Esc</kbd> stops speech.</p>
                        <button type="button" className="assistant__stop" onClick={turnOff}>Stop listening</button>
                    </footer>
                    <details className="assistant__settings">
                        <summary>Listening and speech settings{state.wakeWordMode ? ` (“${WAKE_PHRASE}” is on)` : ''}</summary>
                        <label className="assistant__option">
                            <input
                                type="checkbox"
                                checked={state.wakeWordMode}
                                disabled={!voiceOn}
                                onChange={(e) => dispatch({ type: 'SET_WAKE_WORD_MODE', enabled: e.target.checked })}
                                aria-describedby="zoro-wake-note"
                            />
                            <span>Listen for "{WAKE_PHRASE}" while this tab is open</span>
                        </label>
                        <p id="zoro-wake-note" className="assistant__note">
                            The microphone stays on until you turn this off.
                        </p>
                        <label className="assistant__speed">
                            <span>Language I listen for</span>
                            <select value={language} onChange={(e) => changeLanguage(e.target.value)} aria-describedby="zoro-privacy-note">
                                {SPEECH_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                            </select>
                        </label>
                        <label className="assistant__speed">
                            <span>Voice</span>
                            <select value={voiceChoice} onChange={(e) => changeVoice(e.target.value)}>
                                <option value="">{autoVoice ? `Automatic (${autoVoice.label})` : 'Automatic'}</option>
                                {voiceOptions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                            </select>
                        </label>
                        <label className="assistant__speed">
                            <span>Speech speed</span>
                            <select value={speed} onChange={(e) => changeSpeed(e.target.value)}>
                                {SPEEDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                        </label>
                        <label className="assistant__speed">
                            <span>Wait after I stop talking</span>
                            <select value={pause} onChange={(e) => changePause(e.target.value)}>
                                {PAUSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                            </select>
                        </label>
                        <p id="zoro-privacy-note" className="assistant__note assistant__note--flush">
                            Your browser turns speech into text: Chrome sends your voice to Google, Edge to Microsoft and Safari to Apple.
                            Zoro never records or keeps audio, and passwords are always typed, never spoken.
                        </p>
                    </details>
                </section>
            )}

            {state.status === S.PAUSED ? (
                <div className="assistant__notice assistant__notice--paused" role="status">
                    <Icon name="mic" size={18} />
                    <p>
                        {state.pausedReason === 'keyboard'
                            ? 'Zoro is waiting while you type. It continues when you are signed in.'
                            : state.pausedReason === 'hidden'
                                ? 'Zoro paused because you left this tab. Press the microphone button or Alt+V to continue.'
                                : 'Zoro paused after 2 minutes without activity. Press the microphone button or Alt+V to continue.'}
                    </p>
                    <button type="button" className="assistant__icon-btn" aria-label="Turn off Zoro" onClick={turnOff}>
                        <Icon name="close" size={16} />
                    </button>
                </div>
            ) : null}

            {micBlocked && !panelOpen ? (
                <div className="assistant__notice assistant__notice--error">
                    <Icon name="micOff" size={18} />
                    <div className="assistant__notice-body">
                        <p>Microphone blocked. Allow the microphone for this site in your browser settings, then press the voice button again.</p>
                        <button type="button" className="assistant__control" onClick={() => activate({ typing: true })}>Type to Zoro instead</button>
                    </div>
                    <button type="button" className="assistant__icon-btn" aria-label="Dismiss microphone message" onClick={() => setMicBlocked(false)}>
                        <Icon name="close" size={16} />
                    </button>
                </div>
            ) : null}

            {!supported && !panelOpen && (
                <p className="assistant__notice" role="note">Voice input isn't available in this browser (it works in Chrome and Edge). You can still type to Zoro: press the button below or Alt+V.</p>
            )}

            <button
                type="button"
                className="assistant__orb"
                onClick={toggle}
                aria-pressed={sessionActive}
                aria-label={sessionActive ? 'Turn off Zoro voice assistant (Alt+V)' : 'Talk to Zoro voice assistant (Alt+V)'}
            >
                <span className="assistant__orb-icon" aria-hidden="true"><Icon name={sessionActive ? view.icon : 'mic'} size={20} /></span>
                <span className="assistant__orb-label" aria-hidden="true">
                    {sessionActive ? 'Turn off Zoro' : 'Talk to Zoro'} <kbd className="assistant__orb-kbd">Alt V</kbd>
                </span>
            </button>
        </div>
    );
}
