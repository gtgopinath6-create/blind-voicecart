import { apiRequest, ApiError } from "../apiClient";

jest.mock("firebase/auth", () => ({ getAuth: () => ({ currentUser: null }) }));

const reply = (status, body, { json = true } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: json ? async () => body : async () => { throw new SyntaxError("Unexpected token <"); },
});

beforeEach(() => {
    global.fetch = jest.fn();
});

test("returns the JSON body of a successful response", async () => {
    global.fetch.mockResolvedValue(reply(200, { action: { intent: "UNKNOWN" } }));
    await expect(apiRequest("/api/voice/intent", { body: { text: "hi" } })).resolves.toEqual({ action: { intent: "UNKNOWN" } });
    expect(global.fetch).toHaveBeenCalledWith("/api/voice/intent", expect.objectContaining({ method: "POST" }));
});

test("a 200 HTML page (API not routed to the server) is an error, not a success", async () => {
    global.fetch.mockResolvedValue(reply(200, null, { json: false }));
    const error = await apiRequest("/api/checkout", { body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("bad_response");
});

test("server errors keep their code, message and field errors", async () => {
    global.fetch.mockResolvedValue(reply(400, { error: { code: "invalid_shipping", message: "Fix it.", fields: { customerPincode: "Bad" } } }));
    const error = await apiRequest("/api/checkout", { body: {} }).catch((e) => e);
    expect([error.status, error.code, error.message, error.fields]).toEqual([400, "invalid_shipping", "Fix it.", { customerPincode: "Bad" }]);
});

test("network failures become a readable error", async () => {
    global.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await apiRequest("/api/checkout", { body: {} }).catch((e) => e);
    expect(error.code).toBe("network");
});

test("a request with no answer in time fails as a timeout (status 0), not as a server refusal", async () => {
    jest.useFakeTimers();
    global.fetch.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const pending = apiRequest("/api/checkout", { body: {}, timeoutMs: 30000 }).catch((e) => e);
    jest.advanceTimersByTime(30000);
    const error = await pending;
    jest.useRealTimers();
    expect(error).toBeInstanceOf(ApiError);
    expect([error.status, error.code]).toEqual([0, "timeout"]);
});

test("a caller's own cancel is still an AbortError", async () => {
    global.fetch.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const controller = new AbortController();
    const pending = apiRequest("/api/voice/intent", { body: {}, signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect((await pending).name).toBe("AbortError");
});
