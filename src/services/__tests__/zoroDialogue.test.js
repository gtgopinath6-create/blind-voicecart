import { zoroTurn, createConversation, zoroAuthEvent, pauseConversation, resumeMessage, GREETING } from "../zoroDialogue";
import { fallbackVoiceParser } from "../groqVoiceService";

// Test fixtures (not the store's catalog): enough variety for types, colours and sizes.
const CATALOG = [
    { id: "af1", name: "Nike Air Force 1", price: 9000, rating: 5, category: ["shoes", "casual", "nike"], size: ["6", "7", "8", "9", "10"], color: ["red", "black", "green"] },
    { id: "vans", name: "Vans Old Skool", price: 5000, rating: 5, category: ["shoes", "casual", "vans"], size: ["7", "8", "9"], color: ["black"] },
    { id: "merc", name: "Nike Mercurial", price: 8000, rating: 5, category: ["shoes", "sports", "nike"], size: ["8", "9", "10"], color: ["green", "black"] },
    { id: "puma", name: "Puma Lex", price: 5099, rating: 3, category: ["shoes", "sports", "puma"], size: ["9", "10"], color: ["grey"] },
    { id: "ip13", name: "iPhone 13 Pro", price: 100000, rating: 5, category: ["electronics", "phones", "apple"], size: ["128 GB", "256 GB"] },
    { id: "chips", name: "Chilli Chatka", price: 15, rating: 4.5, category: ["food", "dry snacks", "kurkure"] },
];

function makeEnv(overrides = {}) {
    const signIn = {
        setMode: jest.fn(), setLoginEmail: jest.fn(), focusLoginPassword: jest.fn(), focusGoogle: jest.fn(),
        setSignupField: jest.fn(), focusSignupPassword: jest.fn(),
    };
    let shipping = { customerMobile: "", customerAddress: "", customerCity: "", customerState: "", customerPincode: "" };
    const billing = {
        getShipping: () => shipping,
        setShippingField: jest.fn((field, value) => { shipping = { ...shipping, [field]: value }; }),
        getSummary: () => ({ ready: true, problems: [], total: 10620, itemCount: 1 }),
        placeOrder: jest.fn(),
    };
    const env = {
        user: { uid: "u1" },
        products: async () => CATALOG,
        interpret: jest.fn(async (text, products) => fallbackVoiceParser(text, products)),
        legacyRun: jest.fn(async () => ({ type: "done", message: "Done by the command layer." })),
        legacyResolve: jest.fn(async () => ({ type: "done", message: "Resolved." })),
        navigate: jest.fn(),
        setVoiceFilter: jest.fn(),
        setSpeechRate: jest.fn(),
        addToCart: jest.fn(async () => {}),
        signIn: async () => signIn,
        billing: async () => billing,
        quote: async () => ({ items: [{ name: "Nike Air Force 1", quantity: 1, size: "9", color: "black" }], subtotal: 9000, tax: 1620, total: 10620, problems: [] }),
        currentProduct: () => null,
        ...overrides,
    };
    return { env, signIn, billing };
}

async function talk(env, lines, conv = createConversation()) {
    const replies = [];
    for (const line of lines) {
        const result = await zoroTurn(line, conv, env);
        conv = result.conv;
        replies.push(result.reply);
    }
    return { conv, replies, last: replies[replies.length - 1] };
}

describe("product discovery", () => {
    test("a shoe request is confirmed, then Zoro asks for the type using the catalog's types", async () => {
        const { env } = makeEnv();
        const { replies } = await talk(env, ["I'm looking for shoes", "yes"]);
        expect(replies[0].message).toBe("I understood that you're looking for shoes. Is that correct?");
        expect(replies[0].expect).toBe("answer");
        expect(replies[1].message).toMatch(/What type of shoes are you looking for\? I have casual shoes or sports shoes/);
        expect(replies[1].choices.map((c) => c.label)).toEqual(["Casual", "Sports"]);
    });

    test("a type with no exact category is confirmed honestly as the closest match", async () => {
        const { env } = makeEnv();
        const { replies } = await talk(env, ["I'm looking for shoes", "yes", "gym shoes"]);
        expect(replies[2].message).toMatch(/gym shoes\. I don't have a separate gym category; sports shoes are the closest match\. Is that correct\?/);
    });

    test('"no" does not advance: the same question stays open', async () => {
        const { env } = makeEnv();
        const { conv, last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "no"]);
        expect(conv.slots.type).toBeFalsy();
        expect(conv.step).toBe("type");
        expect(last.message).toMatch(/^Okay\. Which type would you like\?/);
    });

    test("an unclear answer is never taken as yes", async () => {
        const { env } = makeEnv();
        const { conv, last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "hmm maybe"]);
        expect(last.message).toBe("Sorry, I didn't understand. Please say yes or no, or tell me what you would like to change.");
        expect(conv.confirm).toEqual(expect.objectContaining({ kind: "slots" }));
        expect(conv.slots.type).toBeFalsy();
    });

    test("colour questions offer only colours that matching products have", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "sports", "yes"]);
        expect(last.message).toMatch(/What colour would you prefer\? Available colours are black, green and grey\./);
    });

    test("a vague request is inferred by the AI, grounded in the catalog, and confirmed as the closest match", async () => {
        const { env } = makeEnv({
            interpret: jest.fn(async () => ({ intent: "FIND_PRODUCT", target: null, entities: { productType: "walking", category: "Shoes" } })),
        });
        const { conv, last } = await talk(env, ["something comfortable for my morning strolls"]);
        expect(last.message).toBe("I understood that you're looking for walking shoes. I don't have a separate walking category; casual shoes are the closest match. Is that correct?");
        expect(conv.slots.type).toBeUndefined(); // not used until confirmed
    });

    test("an unavailable colour is explained with the real alternatives", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "sports", "yes", "pink"]);
        expect(last.message).toMatch(/pink isn't available .* Available colours are black, green and grey/);
    });

    test("details already given are not asked again: one read-back, then results", async () => {
        const { env } = makeEnv();
        const { replies } = await talk(env, ["I need black Nike sports shoes in size 9", "yes"]);
        expect(replies[0].message).toBe("I understood that you're looking for black Nike sports shoes in size 9. Is that correct?");
        // Only one product matches everything: it is read back in full with the add question.
        expect(replies[1].message).toBe("I found one match: Nike Mercurial, black, size 9, for ₹8,000. Shall I add this item to your cart?");
    });

    test("several matches are read as a numbered list; the shopper chooses by number", async () => {
        const { env } = makeEnv();
        const { replies, conv } = await talk(env, ["I want black casual shoes in size 9", "yes"]);
        // Equal ratings: the cheaper one first. Real names, options and prices only.
        expect(replies[1].message).toBe("I found 2 matching options. Option 1: Vans Old Skool, black, size 9, ₹5,000. Option 2: Nike Air Force 1, black, size 9, ₹9,000. Which option would you like?");
        expect(replies[1].choices.map((c) => c.say)).toEqual(["option 1", "option 2"]);
        const picked = await zoroTurn("option two", conv, env);
        expect(picked.reply.message).toBe("You selected Nike Air Force 1, black, size 9, for ₹9,000. Shall I add this item to your cart?");
    });

    test("a confirmed product is added only after yes, with catalog price and chosen options", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I need black Nike sports shoes in size 9", "yes", "yes"]);
        expect(env.addToCart).toHaveBeenCalledTimes(1);
        const [item, quantity] = env.addToCart.mock.calls[0];
        expect(item).toMatchObject({ id: "merc", price: 8000, color: "black", size: "9" });
        expect(quantity).toBe(1);
        expect(last.message).toMatch(/^Added Nike Mercurial, black, size 9, to your cart\. Would you like to keep shopping, or check out\?/);
    });

    test("nothing is picked for the shopper: an out-of-range option is asked again, never the first item", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I want black casual shoes in size 9", "yes"]);
        const result = await zoroTurn("option nine", conv, env);
        expect(result.reply.message).toMatch(/^Sorry, I didn't catch that\./);
        expect(result.conv.productId).toBeNull();
        expect(env.addToCart).not.toHaveBeenCalled();
    });

    test("corrections change the preference and drop a product that no longer fits", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I need black Nike sports shoes in size 9", "yes"]);
        expect(conv.productId).toBe("merc");
        const { conv: after, replies } = await talk(env, ["no", "actually I want grey", "yes"], conv);
        expect(replies[1].message).toMatch(/you'd now like grey/);
        expect(after.slots.color).toBe("grey");
        expect(after.productId).toBeNull();
        expect(replies[2].message).toMatch(/I couldn't find any grey Nike sports shoes in size 9/);
        expect(env.addToCart).not.toHaveBeenCalled();
    });

    test('"show cheaper options" lists only cheaper matches, and says so when there are none', async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I want black casual shoes in size 9", "yes"]);
        const none = await zoroTurn("show cheaper options", conv, env);
        expect(none.reply.message).toMatch(/^There are no cheaper options that match\./);
        const picked = await zoroTurn("option two", conv, env);
        const cheaper = await zoroTurn("show me something cheaper", picked.conv, env);
        expect(cheaper.reply.message).toBe("Here are options under ₹9,000. I found one match: Vans Old Skool, black, size 9, for ₹5,000. Shall I add this item to your cart?");
    });

    test("go back one step and start over", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I'm looking for shoes", "yes", "sports", "yes"]);
        expect(conv.step).toBe("color");
        const back = await zoroTurn("go back one step", conv, env);
        expect(back.reply.message).toMatch(/^Okay, going back one step\. What type of shoes/);
        const over = await zoroTurn("start over", back.conv, env);
        expect(over.conv.slots).toEqual({});
        expect(over.reply.message).toMatch(/let's start again/);
    });

    test("repeat that, and speech speed", async () => {
        const { env } = makeEnv();
        const { conv, last } = await talk(env, ["I'm looking for shoes"]);
        const again = await zoroTurn("repeat that", conv, env);
        expect(again.reply.message).toBe(last.message);
        const slower = await zoroTurn("speak more slowly", conv, env);
        expect(env.setSpeechRate).toHaveBeenCalledWith("slower");
        expect(slower.reply.message).toMatch(/^Okay, I'll speak more slowly\. I understood/);
    });
});

describe("the page follows the conversation, not just speech", () => {
    test("the category page opens as soon as the category is known, and is not re-opened every turn", async () => {
        const { env } = makeEnv();
        await talk(env, ["I'm looking for shoes", "yes"]);
        const opened = env.navigate.mock.calls.filter((c) => c[0] === "/categories/Shoes");
        expect(opened).toHaveLength(1);
    });

    test("the filter narrows as colour and type are learned, without leaving the category page", async () => {
        const { env } = makeEnv();
        await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes"]);
        const filters = env.setVoiceFilter.mock.calls.map((c) => c[0]);
        expect(filters[filters.length - 1]).toMatchObject({ category: "Shoes", type: "casual", color: "black" });
        expect(env.navigate.mock.calls.filter((c) => c[0] === "/categories/Shoes")).toHaveLength(1);
    });

    test("once the conversation narrows to one product, its page opens", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I need black Nike sports shoes in size 9", "yes"]);
        expect(conv.productId).toBe("merc");
        expect(env.navigate).toHaveBeenCalledWith("/product/merc");
    });

    test("adding the product to the cart opens the cart page", async () => {
        const { env } = makeEnv();
        await talk(env, ["I need black Nike sports shoes in size 9", "yes", "yes"]);
        expect(env.addToCart).toHaveBeenCalledTimes(1);
        expect(env.navigate).toHaveBeenLastCalledWith("/cart");
    });

    test("starting over clears the voice filter instead of leaving it stuck on the old category", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I'm looking for shoes", "yes"]);
        env.setVoiceFilter.mockClear();
        await talk(env, ["start over"], conv);
        expect(env.setVoiceFilter).toHaveBeenCalledWith(null);
    });
});

describe("size selection and sizing help", () => {
    async function atSizeQuestion(env) {
        return talk(env, ["I want black casual shoes", "yes"]).then(() => talk(env, ["I want black Nike casual shoes", "yes"]));
    }

    test("Zoro asks whether the shopper knows their size", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes"]);
        expect(last.message).toBe("Do you already know your shoe size, or would you like help choosing one?");
    });

    test("a known size is confirmed and checked against real sizes; unavailable sizes are rejected", async () => {
        const { env } = makeEnv();
        const { replies, conv } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes", "I know my size", "size 11", "yes"]);
        expect(replies[7].message).toBe("You usually wear size 11. Is that correct?");
        expect(replies[8].message).toMatch(/Size 11 isn't available for these shoes\. The available sizes are 6, 7, 8, 9 and 10\. Which size would you like\?/);
        expect(conv.slots.size).toBeUndefined();
        const chosen = await talk(env, ["9", "yes"], conv);
        expect(chosen.replies[0].message).toBe("You selected size 9. Is that correct?");
        expect(chosen.conv.slots.size).toBe("9");
    });

    test("a size in another system is never converted", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes", "I know my size", "EU 43", "yes"]);
        expect(last.message).toMatch(/doesn't say whether they are UK or US sizes, so I can't convert between sizing systems/);
        expect(last.message).toMatch(/Size 43 isn't available/);
    });

    test("height and weight are captured and confirmed, and alone never produce a size", async () => {
        const { env } = makeEnv();
        const { replies } = await talk(env, [
            "I'm looking for shoes", "yes", "casual", "yes", "black", "yes",
            "help me choose", "186 centimetres", "yes", "70 kilograms", "yes", "no", "skip",
        ]);
        expect(replies[6].message).toMatch(/height and weight alone cannot accurately determine shoe size\. What is your height\?/);
        expect(replies[7].message).toBe("I understood your height as 186 centimetres. Is that correct?");
        expect(replies[9].message).toBe("I understood your weight as 70 kilograms. Is that correct?");
        expect(replies[10].message).toMatch(/Do you have a pair of shoes that fits you comfortably\?/);
        expect(replies[11].message).toMatch(/Do you know the length of your foot in centimetres\?/);
        expect(replies[12].message).toMatch(/^With only height and weight, I don't have enough information to recommend a shoe size reliably\. The available sizes are 6, 7, 8, 9 and 10\./);
    });

    test("a foot length outside the human range is not accepted", async () => {
        const { env } = makeEnv();
        const { conv, last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes", "help me choose", "skip", "skip", "no", "90 centimetres"]);
        expect(last.message).toMatch(/^Sorry, I didn't catch that\./);
        expect(conv.sizing.footCm).toBeUndefined();
    });

    test("without a verified chart, a foot length is not turned into a size", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes", "help me choose", "skip", "skip", "no", "26.5 centimetres", "yes"]);
        expect(last.message).toMatch(/I don't have a verified size chart .* so I can't turn a foot length into a size reliably/);
    });

    test("with a verified brand chart and a known store system, the chart is used and called an estimate", async () => {
        const charts = { nike: { source: "fixture", rows: [{ footCm: 26, UK: "8" }, { footCm: 27, UK: "9" }] } };
        const { env } = makeEnv({ sizing: { charts, storeSystem: "UK" } });
        const { last } = await talk(env, ["I need black Nike casual shoes", "yes", "help me choose", "skip", "skip", "no", "26.5 centimetres", "yes"]);
        expect(last.message).toMatch(/Based on your foot length of 26.5 centimetres and Nike's size chart, size 9 appears to be the closest match\. This is an estimate, not a guarantee of fit/);
    });

    test("measuring guidance is available", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["I'm looking for shoes", "yes", "casual", "yes", "black", "yes", "help me choose", "skip", "skip", "no", "help me measure"]);
        expect(last.message).toMatch(/Stand on a sheet of paper/);
        void atSizeQuestion;
    });
});

describe("sign-in by voice", () => {
    test("a guest shopping request asks how to sign in, and 'guest' continues the request", async () => {
        const { env } = makeEnv({ user: null });
        const { replies } = await talk(env, ["I'm looking for shoes", "continue as a guest"]);
        expect(replies[0].message).toMatch(/^You're not signed in yet\. Would you like to sign in using your email and password, continue with Google, or continue browsing as a guest\?/);
        expect(replies[1].message).toMatch(/^Okay, you can keep browsing as a guest\. .* I understood that you're looking for shoes\. Is that correct\?/);
    });

    test("email is captured locally and read back; the password is typed, never spoken or sent to the AI", async () => {
        const { env, signIn } = makeEnv({ user: null });
        const { conv, replies } = await talk(env, ["sign me in", "email and password", "gopi nath at example dot com", "yes"]);
        expect(env.navigate).toHaveBeenCalledWith("/sign");
        expect(replies[2].message).toBe("I heard g o p i n a t h, at example dot com. That is gopinath at example dot com. Is that correct?");
        expect(signIn.setLoginEmail).toHaveBeenCalledWith("gopinath@example.com");
        expect(signIn.focusLoginPassword).toHaveBeenCalled();
        expect(replies[3].expect).toBe("keyboard");
        expect(replies[3].message).toMatch(/I don't take passwords by voice/);
        // Only the first request ("sign me in") went to the intent service; answers were parsed locally.
        expect(env.interpret).toHaveBeenCalledTimes(1);
        expect(env.interpret.mock.calls[0][0]).toBe("sign me in");
        // Nothing sensitive is kept in the conversation.
        expect(JSON.stringify({ ...conv, lastResponse: "", history: [] })).not.toMatch(/gopinath@example\.com/);
    });

    test("a wrong email can be corrected without restarting", async () => {
        const { env, signIn } = makeEnv({ user: null });
        const { last } = await talk(env, ["sign me in", "email", "asha at example dot com", "no", "asha one at example dot com", "yes"]);
        expect(signIn.setLoginEmail).toHaveBeenCalledWith("asha1@example.com");
        expect(signIn.setLoginEmail).toHaveBeenCalledTimes(1);
        expect(last.expect).toBe("keyboard");
    });

    test("sign-in success welcomes the shopper on the home page; failure offers a retry", async () => {
        const { env } = makeEnv({ user: null });
        const { conv } = await talk(env, ["sign me in", "email", "asha at example dot com", "yes"]);
        const failed = zoroAuthEvent(conv, { ok: false, message: "Incorrect email or password." }, env);
        expect(failed.reply.message).toMatch(/^That didn't work: Incorrect email or password\. Would you like to type your password again/);
        const ok = zoroAuthEvent(conv, { ok: true }, env);
        expect(env.navigate).toHaveBeenLastCalledWith("/");
        expect(ok.reply.message).toMatch(/^You're signed in successfully\. Welcome to VoiceCart\./);
        // Not helping with sign-in: nothing to say.
        expect(zoroAuthEvent(createConversation(), { ok: true }, env)).toBeNull();
    });

    test("Google sign-in moves focus to the button and asks for a key press", async () => {
        const { env, signIn } = makeEnv({ user: null });
        const { last } = await talk(env, ["log in", "Google"]);
        expect(signIn.focusGoogle).toHaveBeenCalled();
        expect(last.expect).toBe("keyboard");
        expect(last.message).toMatch(/Press Enter to open it/);
    });

    test("registration fills name and email after read-back, then hands over to the password fields", async () => {
        const { env, signIn } = makeEnv({ user: null });
        await talk(env, ["create an account", "Asha Rao", "yes", "asha at example dot com", "yes"]);
        expect(signIn.setMode).toHaveBeenCalledWith("signup");
        expect(signIn.setSignupField).toHaveBeenCalledWith("newName", "Asha Rao");
        expect(signIn.setSignupField).toHaveBeenCalledWith("newEmail", "asha@example.com");
        expect(signIn.focusSignupPassword).toHaveBeenCalled();
    });
});

describe("checkout", () => {
    test("guests are asked to sign in (no guest checkout)", async () => {
        const { env } = makeEnv({ user: null });
        const { last } = await talk(env, ["check out"]);
        expect(last.message).toMatch(/^To check out you need to sign in\./);
        expect(last.choices.map((c) => c.label)).not.toContain("Continue as a guest");
    });

    test("the server total is read, delivery details are confirmed one by one, and the order needs an explicit yes", async () => {
        const { env, billing } = makeEnv();
        const { replies, conv } = await talk(env, ["check out", "yes", "nine eight seven six five four three two one zero", "yes"]);
        expect(replies[0].message).toMatch(/^Your cart has 1 Nike Air Force 1, black, size 9\. The subtotal is ₹9,000, tax is ₹1,620, and the total is ₹10,620, as calculated by the server\./);
        expect(env.navigate).toHaveBeenCalledWith("/billing");
        expect(replies[1].message).toMatch(/I need your delivery details\. What is your 10-digit mobile number\?/);
        // Read back in two groups of five, with a pause, so the number is easy to check.
        expect(replies[2].message).toBe("I heard 9 8 7 6 5, 4 3 2 1 0. Is that correct?");
        expect(billing.setShippingField).toHaveBeenCalledWith("customerMobile", "9876543210");
        expect(replies[3].message).toMatch(/What is your delivery address\?/);
        const rest = await talk(env, ["12 Review Lane, Local Test Block", "yes", "Mumbai", "yes", "Maharashtra", "yes", "four zero zero zero zero one", "yes"], conv);
        expect(rest.last.message).toMatch(/The final total is ₹10,620 for 1 item, paid from your VoiceCart wallet\. Say "yes, place order"/);
        expect(rest.conv.legacyPending).toEqual({ kind: "confirmOrder" });
        expect(billing.placeOrder).not.toHaveBeenCalled();
    });

    test("an invalid mobile number is rejected with the reason", async () => {
        const { env, billing } = makeEnv();
        const { last } = await talk(env, ["check out", "yes", "one two three"]);
        expect(last.message).toMatch(/^Enter a valid 10-digit mobile number\./);
        expect(billing.setShippingField).not.toHaveBeenCalled();
    });
});

describe("session", () => {
    test("pausing drops anything that could spend money, but keeps the shopping context", () => {
        const conv = { ...createConversation(), slots: { category: "Shoes" }, legacyPending: { kind: "confirmOrder" }, confirm: { kind: "product" } };
        const paused = pauseConversation(conv);
        expect(paused.legacyPending).toBeNull();
        expect(paused.confirm).toBeNull();
        expect(paused.slots).toEqual({ category: "Shoes" });
    });

    test("greeting first, then a resume that repeats the open question", () => {
        expect(resumeMessage(createConversation(), true)).toBe(GREETING);
        const asking = { ...createConversation(), workflow: "discover", lastResponse: "Which colour would you like?", lastExpect: "answer" };
        expect(resumeMessage(asking, false)).toBe("Welcome back. Which colour would you like?");
    });

    test("commands that are not shopping go to the command layer unchanged", async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["open electronics"]);
        expect(env.legacyRun).toHaveBeenCalledWith(expect.objectContaining({ intent: "NAVIGATE", target: "/categories/Electronics" }), CATALOG);
        expect(last.message).toBe("Done by the command layer.");
    });
});

describe("catalog access", () => {
    // env.products as the app wires it: with a category, only that category is read.
    function scopedEnv(overrides = {}) {
        const reads = [];
        const { env } = makeEnv({
            products: jest.fn(async (scope) => {
                reads.push(scope ? scope.category : "everything");
                return scope ? CATALOG.filter((p) => p.category[0] === scope.category.toLowerCase()) : CATALOG;
            }),
            ...overrides,
        });
        return { env, reads };
    }

    test("a narrow request reads only its category, from the first words to the cart", async () => {
        const { env, reads } = scopedEnv();
        await talk(env, ["I need black sports shoes in size 9", "yes", "yes"]);
        expect(env.addToCart).toHaveBeenCalledWith(expect.objectContaining({ id: "merc", price: 8000, color: "black", size: "9" }), 1);
        expect(reads.length).toBeGreaterThan(0);
        expect(new Set(reads)).toEqual(new Set(["Shoes"]));
    });

    test("only a product named without its category reads the whole catalog", async () => {
        const { env, reads } = scopedEnv();
        await talk(env, ["add Nike Air Force 1 to my cart"]);
        expect(reads).toEqual(["everything"]);
    });

    test("requests that are not about products read no products at all", async () => {
        const { env, reads } = scopedEnv();
        await talk(env, ["what's in my cart"]);
        await talk(env, ["sign me in"]);
        expect(reads).toEqual([]);
    });

    test("when the catalog cannot be loaded Zoro says so, changes nothing and keeps the question", async () => {
        const failure = Object.assign(new Error("quota"), { name: "CatalogError", kind: "quota" });
        let calls = 0;
        // The first read works; the next one hits the quota.
        const products = jest.fn(async () => { calls += 1; if (calls > 1) throw failure; return CATALOG; });
        const { env } = scopedEnv({ products });
        const { conv, replies, last } = await talk(env, ["I'm looking for shoes", "yes"]);
        expect(replies[0].message).toMatch(/Is that correct\?$/);
        expect(last.message).toBe("I can't load the product catalog right now. Your cart hasn't been changed. You can try again later.");
        expect(last.message).not.toMatch(/couldn't find|no .* match/i);
        expect(env.addToCart).not.toHaveBeenCalled();
        expect(env.legacyRun).not.toHaveBeenCalled();
        expect(conv.confirm).toMatchObject({ kind: "slots" });
    });
});

describe("natural speech", () => {
    test.each([
        ["I want shoes.", /^I understood that you're looking for shoes\. Is that correct\?$/],
        ["I'm looking for a pair of shoes.", /^I understood that you're looking for shoes\. Is that correct\?$/],
        ["Show me sports shoes.", /^I understood that you're looking for sports shoes\. Is that correct\?$/],
        ["I need shoes for the gym.", /^I understood that you're looking for gym shoes\. I don't have a separate gym category; sports shoes are the closest match\. Is that correct\?$/],
        ["Do you have black shoes?", /^I understood that you're looking for black shoes\. Is that correct\?$/],
        ["um, I'm looking for nikey shoes", /^I understood that you're looking for Nike shoes\. Is that correct\?$/],
    ])("%s", async (said, reply) => {
        const { env } = makeEnv();
        const { last } = await talk(env, [said]);
        expect(last.message).toMatch(reply);
        expect(last.expect).toBe("answer");
    });

    test('"black shoes" starts a search, even though one product\'s name contains "Black"', async () => {
        const vansBW = { id: "vbw", name: "Vans Old Skool Black/White", price: 5000, rating: 4, category: ["shoes", "casual", "vans"], size: ["8", "9"], color: ["black"] };
        const { env } = makeEnv({ products: async () => [...CATALOG, vansBW] });
        const { last } = await talk(env, ["I'm looking for black shoes"]);
        expect(last.message).toBe("I understood that you're looking for black shoes. Is that correct?");
        const named = await talk(env, ["I'm looking for Nike Air Force 1"]);
        expect(named.last.message).toMatch(/^I found Nike Air Force 1\./);
    });

    test('"something cheaper" with nothing to compare asks what, instead of searching for those words', async () => {
        const { env } = makeEnv();
        const { last } = await talk(env, ["Can you find something cheaper?"]);
        expect(last.message).toMatch(/^Cheaper than what\?/);
        expect(env.legacyRun).not.toHaveBeenCalled();
    });

    test("polite and filler words do not hide a command", async () => {
        const { env } = makeEnv();
        const first = await talk(env, ["I'm looking for shoes"]);
        const { replies } = await talk(env, ["can you repeat that please", "slow down", "speak normally"], first.conv);
        expect(replies[0].message).toBe(first.last.message);
        expect(env.setSpeechRate).toHaveBeenNthCalledWith(1, "slower");
        expect(env.setSpeechRate).toHaveBeenNthCalledWith(2, "normal");
        expect(replies[1].expect).toBe("answer"); // still waiting for the same answer
    });

    test('"mute" and "unmute" switch Zoro\'s voice and keep the question', async () => {
        const setMuted = jest.fn();
        const { env } = makeEnv({ setMuted });
        const first = await talk(env, ["I'm looking for shoes"]);
        const { replies } = await talk(env, ["mute", "unmute"], first.conv);
        expect(setMuted.mock.calls).toEqual([[true], [false]]);
        expect(replies[0].message).toMatch(/My replies are still shown on screen\..*Is that correct\?$/);
    });
});

describe("corrections keep the step until confirmed", () => {
    async function atColourQuestion(env) {
        const { conv, last } = await talk(env, ["I'm looking for sports shoes", "yes"]);
        expect(last.message).toMatch(/What colour would you prefer\? Available colours are black, green and grey\./);
        return conv;
    }

    test("Black, no, grey: the new colour is read back and nothing is applied until yes", async () => {
        const { env } = makeEnv();
        const conv = await atColourQuestion(env);
        const { replies, conv: after } = await talk(env, ["Black.", "No, grey."], conv);
        expect(replies[0].message).toBe("You'd prefer black. Is that correct?");
        expect(replies[1].message).toBe("You'd prefer grey. Is that correct?");
        expect(after.slots.color).toBeUndefined(); // not applied yet
        const { conv: done } = await talk(env, ["yes"], after);
        expect(done.slots.color).toBe("grey");
    });

    test('"no" is never a yes, and "make it size nine" is a correction that is read back', async () => {
        const { env } = makeEnv();
        const conv = await atColourQuestion(env);
        const { replies, conv: after } = await talk(env, ["black", "no"], conv);
        expect(replies[1].message).toBe("Okay. Which colour would you like?");
        expect(after.slots.color).toBeUndefined();
        const { last } = await talk(env, ["make it size nine"], after);
        expect(last.message).toMatch(/size 9\. Is that correct\?$/);
    });

    test('"go back" during a conversation goes back a step instead of leaving the page', async () => {
        const { env } = makeEnv();
        const conv = await atColourQuestion(env);
        const { last } = await talk(env, ["go back"], conv);
        expect(last.message).toMatch(/^Okay, going back one step\./);
        expect(env.navigate).not.toHaveBeenCalledWith(-1);
        expect(env.legacyRun).not.toHaveBeenCalled();
    });

    test("a size that is not a whole or half size is said back as heard, never rounded", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I'm looking for casual shoes", "yes", "black", "yes", "I know my size"]);
        const { last } = await talk(env, ["nine point two"], conv);
        expect(last.message).toMatch(/^I heard 9\.2\. Shoe sizes here are whole or half sizes, such as 9 or 9\.5\./);
        const { last: soundalike } = await talk(env, ["size for"], conv);
        expect(soundalike.message).toBe("You usually wear size 4. Is that correct?");
    });
});

describe("consent and the browser's uncertainty", () => {
    async function atAddQuestion(env) {
        const { conv, last } = await talk(env, ["I'm looking for casual shoes", "yes", "black", "yes", "I know my size", "9", "yes"]);
        expect(last.message).toMatch(/Shall I add this item to your cart\?$|Which option would you like\?$/);
        if (/Which option/.test(last.message)) {
            const picked = await talk(env, ["option 1"], conv);
            expect(picked.last.message).toMatch(/Shall I add this item to your cart\?$/);
            return picked.conv;
        }
        return conv;
    }

    test("a yes the browser was unsure about is asked again and adds nothing", async () => {
        const { env } = makeEnv();
        const conv = await atAddQuestion(env);
        const unsure = await zoroTurn("yes", conv, env, { source: "voice", confidence: 0.31, alternatives: ["yes", "guess"] });
        expect(unsure.reply.message).toBe("I think I heard yes, but I'm not sure. Please say yes or no again, or use the Yes and No buttons.");
        expect(unsure.reply.unclear).toBe(true);
        expect(unsure.conv.confirm).toEqual(conv.confirm);
        expect(env.addToCart).not.toHaveBeenCalled();
        await zoroTurn("yes", unsure.conv, env, { source: "voice", confidence: 0.92 });
        expect(env.addToCart).toHaveBeenCalledTimes(1);
    });

    test("a typed or clicked yes has no browser confidence and counts as given", async () => {
        const { env } = makeEnv();
        const conv = await atAddQuestion(env);
        await zoroTurn("yes", conv, env, { source: "button" });
        expect(env.addToCart).toHaveBeenCalledTimes(1);
    });

    test("an unsure yes to placing an order never reaches the order step", async () => {
        const { env } = makeEnv();
        const conv = { ...createConversation(), legacyPending: { kind: "confirmOrder" }, lastResponse: "Place the order?", lastExpect: "answer", lastChoices: [] };
        const result = await zoroTurn("yes, place order", conv, env, { source: "voice", confidence: 0.4 });
        expect(result.reply.message).toMatch(/^I think I heard yes/);
        expect(env.legacyResolve).not.toHaveBeenCalled();
    });

    test("the browser's other hearings help with an answer that is read back, but never make a yes", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I'm looking for sports shoes", "yes"]);
        const colour = await zoroTurn("lack", conv, env, { source: "voice", confidence: 0.5, alternatives: ["lack", "black"] });
        expect(colour.reply.message).toBe("You'd prefer black. Is that correct?");
        const notYes = await zoroTurn("guess", colour.conv, env, { source: "voice", confidence: 0.6, alternatives: ["guess", "yes"] });
        expect(notYes.reply.message).toMatch(/^Sorry, I didn't understand\./);
        expect(notYes.conv.slots.color).toBeUndefined();
    });

    test("replies that did not understand are flagged, so the assistant can offer typing", async () => {
        const { env } = makeEnv();
        const { conv } = await talk(env, ["I'm looking for sports shoes", "yes"]);
        const { last } = await talk(env, ["banana spaceship"], conv);
        expect(last.unclear).toBe(true);
        expect(last.message).toMatch(/^Sorry, I didn't catch that\./);
    });
});
