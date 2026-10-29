// Groq-backed speech-to-text for Zoro's command mode (mic button / Alt+V / a spoken command
// after "Hey Zoro"). The browser uploads one short recorded utterance; this module forwards it
// to Groq's hosted Whisper model and returns plain text. Nothing here decides intent or runs any
// action — the returned text goes through the same validated classify-then-execute pipeline as
// typed text (see voice.js and the browser's voiceActions.js). The audio is never stored, and the
// Groq key never reaches the browser.

const { HttpError } = require('./http');

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 2000;

// Groq identifies the audio format from the uploaded filename's extension, not the form field's
// declared mime type, and rejects anything else (flac/mp3/mp4/mpeg/mpga/m4a/ogg/opus/wav/webm).
const EXTENSION_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
};

function filenameFor(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return `utterance.${EXTENSION_BY_MIME[base] || 'webm'}`;
}

/** Calls Groq's Whisper endpoint. Returns { text }, or throws HttpError(502/503/504). */
async function transcribeWithGroqWhisper({ audio, mimeType, apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) throw new HttpError(503, 'ai_not_configured', 'The AI assistant is not configured on the server.');
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new HttpError(400, 'invalid_input', 'No audio was received.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    const form = new FormData();
    form.append('model', model);
    // response_format "text" keeps the Groq response small and avoids trusting anything but a string back.
    form.append('response_format', 'json');
    form.append('file', new Blob([audio], { type: mimeType || 'application/octet-stream' }), filenameFor(mimeType));
    response = await fetchImpl(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    throw new HttpError(e.name === 'AbortError' ? 504 : 502, 'ai_unavailable', 'The AI service did not respond.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Log the status only; provider bodies can echo request details.
    console.error(`Groq transcription error: HTTP ${response.status}`);
    if (response.status === 429) throw new HttpError(503, 'ai_rate_limited', 'The AI service is busy. Please try again shortly.');
    throw new HttpError(502, 'ai_unavailable', 'The AI service returned an error.');
  }

  let text = '';
  try {
    const data = await response.json();
    text = typeof data.text === 'string' ? data.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
  } catch (e) {
    text = '';
  }
  return { text };
}

module.exports = { transcribeWithGroqWhisper, GROQ_TRANSCRIBE_URL };
