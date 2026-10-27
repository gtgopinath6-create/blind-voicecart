# Testing Zoro's listening and speech on real devices

The automated tests check how Zoro handles what the browser hears and how it speaks. They cannot tell
how well a real microphone, accent or room is understood. Those checks need people, and this plan is
for them. Record what actually happened. Nothing here should be summed up as "accuracy improved"
without the numbers.

## Before you start

- **Use the local test setup** (README, "Try sign-in, checkout and admin locally"). Its test account
  is `shopper@voicecart.test`. Do not use a real account, real addresses or real phone numbers. Use
  made-up ones such as `98765 43210` and `12 Review Lane`.
- **Consent.** Everyone who speaks in a test agrees to take part and to their words being written
  down. Zoro never records or stores audio. The browser's speech service processes the voice
  (Google for Chrome, Microsoft for Edge). Write down only the words shown on screen, never the audio.
- **Never say a password.** Zoro asks for passwords to be typed; check that it does.
- **One person per session.** Note the browser and its version, the operating system, the
  microphone (built-in, headset, Bluetooth), and speakers or headphones.
- **Settings.** Open Zoro's "Listening and speech settings". Note the language, voice, speech speed
  and "Wait after I stop talking". Start with the defaults: English (India), Automatic voice, Normal,
  Normal.

## How to record a test

For every phrase, fill in one row:

| # | Expected phrase | Shown as "You said" | Intent right? (Y/N) | Needed a correction? | Recognition latency (s) | Speech latency (s) | Zoro interrupted or repeated itself? | Notes |
|---|---|---|---|---|---|---|---|---|

- **Shown as "You said"**: copy exactly what the panel shows under "You said".
- **Intent right?**: Y if Zoro did what the phrase meant, even when the words were slightly different.
- **Recognition latency**: seconds from the moment you stop speaking until the status changes to
  "Thinking". A phone stopwatch is enough. Zoro waits on purpose after you stop (0.9 s by default),
  so expect about 1 to 2 s.
- **Speech latency**: seconds from "Thinking" until you hear the first word of the reply.
- **Interrupted or repeated?**: note any overlapping speech, a reply spoken twice, a reply cut off
  part-way, or Zoro answering its own voice.

Afterwards, count for each environment: phrases tried, phrases whose intent was right on the first
try, and phrases that needed a correction. Report those counts, not a percentage on its own.

## Environments

Repeat the core phrase list (below) in each of these, so you can compare them:

1. Quiet room, laptop's built-in microphone and speakers.
2. Normal background noise (fan, conversation in the next room, street noise).
3. Headset or headphones with a microphone.
4. Speaking slowly, with natural pauses mid-sentence ("I'm looking for … black shoes").
5. Speaking quickly.
6. Different English accents: Indian English, and at least one other. If you can, try more than one
   speaker per accent.
7. Language settings: English (India), then English (United States), with the same speaker and phrases.

## Core phrase list

Start Zoro with the microphone button or Alt+V. "Continue as a guest" is fine unless the test is
about sign-in or checkout.

**Product discovery**
1. "I want shoes."
2. "I'm looking for a pair of shoes."
3. "Show me sports shoes."
4. "I need shoes for the gym." (Zoro should say sports shoes are the closest match.)
5. "Do you have black shoes?"
6. "Show me Nike shoes." Also try "Adidas", "Puma", "OnePlus" and "H and M".
7. "I'm looking for Nike Air Force 1." (It should go straight to that product.)
8. "Can you find something cheaper?" (With no search going, Zoro should ask "Cheaper than what?")

**Colours, sizes, numbers**
9. When asked for a colour: "Black." Then "No, red." (Zoro should read back red and wait for a yes.)
10. "Make it size nine."
11. "No, I said size ten."
12. "Size nine and a half" and "nine point five". (Zoro should hear 9.5 and say this store has no
    9.5 if none is listed.)
13. "Nine point two". (Zoro should say "I heard 9.2" and explain whole and half sizes, never round it.)
14. "Under three thousand rupees", "under 3k", "two thousand rupees".
15. "Quantity two."

**Answers and control**
16. "Yes, add it." / "No, don't add it." / "Haan." / "Nahi."
17. "Go back." (During a conversation it should go back one step, not to the previous page.)
18. "Repeat that." / "Can you repeat that please?"
19. "Speak slowly." / "Slow down." / "Speak normally."
20. "Mute." then "Unmute."
21. "Stop listening."

**Sign-in and checkout (test account only)**
22. "Sign me in" → "Email and password" → spell the email address: "shopper at voicecart dot test".
    Then type the password; never say it.
23. Signed in: "Check out" → "Yes" → mobile number "nine eight seven six five four three two one
    zero" (Zoro should read it back as "9 8 7 6 5, 4 3 2 1 0"). Also try saying it in groups, or with
    "double nine".
24. At "Say yes, place order": say a quiet, unclear "yes". If Zoro answers "I think I heard yes, but
    I'm not sure", that is the intended behaviour; note it.

## Things to check on every device

- **Microphone permission.** The first time, the browser asks. Deny it once: Zoro should explain how
  to allow it and offer "Type to Zoro instead". Allow it, press the button again: listening works.
- **Status.** The status line matches reality. "Listening" only while the microphone is on, never
  while Zoro is speaking. "Waiting for your answer" after a question. "Paused" after 2 minutes
  without activity.
- **Two-minute pause.** Say nothing for 2 minutes. Zoro says it paused and the browser's microphone
  indicator goes off.
- **Typing.** Type an answer in "Type to Zoro" and press Enter. It is handled like speech. Typing
  while Zoro talks interrupts it.
- **Speech controls.** Try Repeat, Slower, Normal speed, Mute voice, Stop speaking, then Resume reply
  (during a long reply, such as "help"). Resume should continue from where it stopped.
- **Voice.** In the settings, note which voice "Automatic" chooses, and whether it sounds clear on
  laptop speakers and on headphones. Try one other voice from the list. Note whether prices ("9000
  rupees") and sizes sound natural.
- **Speed.** Note whether Normal speed is comfortable, too fast or too slow for each listener. This is
  the main input for tuning the default.

## Screen readers

Where available, repeat a short session (phrases 1, 9, 16, 18, 21) with:

- **NVDA on Windows** with Chrome or Edge.
- **VoiceOver on macOS** with Chrome (and Safari, if you also want to check voice input there).

For each one, test with the site's "Built-in screen reader" switch both off and on:

- Off: Zoro does not speak. Its replies should be read once by NVDA or VoiceOver.
- On: Zoro speaks. Check that the screen reader does not read the same reply again, and that the two
  voices do not talk over each other.

Also check:

- Every Zoro control can be reached with Tab and has a clear name: Repeat, Slower, Normal speed,
  Mute voice, Type to Zoro, Send, Stop listening, and the settings.
- Turning Zoro on with Alt+V and off again leaves focus somewhere sensible.

## Known limits to keep in mind

- **Recognition is done by the browser.** Its accuracy depends on the browser's speech service, the
  microphone, the accent and the room. Code changes cannot guarantee it. Chrome needs an internet
  connection for recognition.
- **Hearings and confidence.** Zoro asks for up to 3 hearings of each phrase and uses a browser
  confidence below 0.5 to double-check a "yes". Chrome does not always report alternatives or
  confidence, and Zoro then works without them. Note whether the panel ever shows a second hearing
  being used: you said one thing, and Zoro read back a different but correct word.
- **Voices differ by device.** Voices, and how they read numbers, vary by operating system and
  browser.
