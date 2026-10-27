// Calls the VoiceCart backend (server/). In development, CRA proxies /api to
// http://localhost:5055 (see "proxy" in package.json). In production, serve the API on the
// same origin or set REACT_APP_API_BASE_URL (a public URL, not a secret).
import { getAuth } from "firebase/auth";

const API_BASE = (process.env.REACT_APP_API_BASE_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
    constructor(status, code, message, fields) {
        super(message);
        this.status = status;
        this.code = code;
        this.fields = fields || null;
    }
}

/**
 * POST/DELETE JSON to the API, attaching the Firebase ID token when signed in.
 * With timeoutMs, a request that gets no answer in time fails with code "timeout" (status 0).
 * Status 0 means no answer arrived: the server may or may not have done the work.
 */
export async function apiRequest(path, { method = "POST", body, auth = true, signal, timeoutMs = 0 } = {}) {
    const headers = { "Content-Type": "application/json" };
    const user = auth ? getAuth().currentUser : null;
    if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;

    const controller = timeoutMs || signal ? new AbortController() : null;
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort);
    }

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller ? controller.signal : undefined,
        });
    } catch (e) {
        if (timedOut) throw new ApiError(0, "timeout", "The server did not answer in time. Check your connection and try again.");
        if (e.name === "AbortError") throw e;
        throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
    }

    let data = null;
    try {
        data = await response.json();
    } catch (e) {
        data = null;
    }
    if (!response.ok) {
        const err = (data && data.error) || {};
        throw new ApiError(response.status, err.code || "error", err.message || `Request failed (HTTP ${response.status}).`, err.fields);
    }
    if (!data || typeof data !== "object") {
        // A 200 that is not JSON usually means /api is not routed to the VoiceCart server
        // (for example a static host answered with index.html). Never treat that as success.
        throw new ApiError(response.status, "bad_response", "The server sent an unexpected response. Please try again later.");
    }
    return data;
}

/** Random id used to make checkout and wallet requests safe to retry. */
export function newRequestId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, "");
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
