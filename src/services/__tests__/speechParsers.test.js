import {
    extractNumber, classifyAnswer, parseOptionIndex, parseShoeSize, parseHeight, parseWeight, parseFootLength,
    parseBudget, parseQuantity, parseDigits, parseEmail, speakableEmail, parseSizeAnswer, numberSoundalikes, speakableDigits,
} from "../speechParsers";

test("numbers in digits and words", () => {
    expect(extractNumber("186 centimetres")).toBe(186);
    expect(extractNumber("one hundred eighty six")).toBe(186);
    expect(extractNumber("nine and a half")).toBe(9.5);
    expect(extractNumber("size 9.")).toBe(9);
    expect(extractNumber("five thousand rupees")).toBe(5000);
    expect(extractNumber("5 thousand")).toBe(5000);
    expect(extractNumber("no number here")).toBeNull();
});

test("yes and no, with natural variations; anything unclear is never a yes", () => {
    for (const t of ["yes", "Yeah.", "that's right", "correct", "Yes please", "sure", "exactly"]) expect(classifyAnswer(t).answer).toBe("yes");
    for (const t of ["no", "nope", "not quite", "no, change it", "that's wrong", "cancel"]) expect(classifyAnswer(t).answer).toBe("no");
    for (const t of ["maybe", "black", "what?", "yes no", "right, but no", ""]) expect(classifyAnswer(t).answer).toBe("unclear");
    expect(classifyAnswer("no, size 10")).toEqual({ answer: "no", rest: "size 10" });
    expect(classifyAnswer("no it's blue").rest).toBe("blue");
});

test("choosing from a read-out list", () => {
    expect(parseOptionIndex("the first one", 3)).toBe(0);
    expect(parseOptionIndex("option two", 3)).toBe(1);
    expect(parseOptionIndex("number 3", 3)).toBe(2);
    expect(parseOptionIndex("the last one", 3)).toBe(2);
    expect(parseOptionIndex("option four", 3)).toBeNull();
    expect(parseOptionIndex("nike air force", 3)).toBeNull();
});

test("shoe sizes keep the sizing system the user said, and are never converted", () => {
    expect(parseShoeSize("size 9")).toEqual({ size: "9", system: null });
    expect(parseShoeSize("UK nine and a half")).toEqual({ size: "9.5", system: "UK" });
    expect(parseShoeSize("EU 43")).toEqual({ size: "43", system: "EU" });
    expect(parseShoeSize("I don't know")).toBeNull();
});

test("height, weight and foot length are validated and converted with exact units only", () => {
    expect(parseHeight("186 centimeters")).toEqual({ cm: 186 });
    expect(parseHeight("1.86 metres")).toEqual({ cm: 186 });
    expect(parseHeight("six feet one inch")).toEqual({ cm: 185 });
    expect(parseHeight("5'11")).toEqual({ cm: 180 });
    expect(parseHeight("12 centimetres")).toBeNull();
    expect(parseWeight("70 kilograms")).toEqual({ kg: 70 });
    expect(parseWeight("154 pounds")).toEqual({ kg: 70 });
    expect(parseWeight("5 kilos")).toBeNull();
    expect(parseFootLength("27 centimetres")).toEqual({ cm: 27 });
    expect(parseFootLength("265 millimetres")).toEqual({ cm: 26.5 });
    expect(parseFootLength("10 inches")).toEqual({ cm: 25.4 });
    expect(parseFootLength("90 centimetres")).toBeNull();
});

test("budget and quantity", () => {
    expect(parseBudget("comfortable walking shoes under ₹5,000")).toEqual({ max: 5000 });
    expect(parseBudget("less than five thousand rupees")).toEqual({ max: 5000 });
    expect(parseBudget("above 1000")).toEqual({ min: 1000 });
    expect(parseBudget("black shoes")).toBeNull();
    expect(parseQuantity("two pairs please")).toBe(2);
    expect(parseQuantity("quantity 3")).toBe(3);
    expect(parseQuantity("size 9")).toBeNull();
});

test("spoken digits and email addresses", () => {
    expect(parseDigits("nine eight seven six five four three two one zero")).toBe("9876543210");
    expect(parseDigits("double nine 876")).toBe("99876");
    expect(parseEmail("gopi nath at example dot com")).toBe("gopinath@example.com");
    expect(parseEmail("john underscore doe at the rate gmail dot com")).toBe("john_doe@gmail.com");
    expect(parseEmail("asha one two at mail dot co dot in")).toBe("asha12@mail.co.in");
    expect(parseEmail("my email is something")).toBeNull();
    expect(speakableEmail("ab.c@example.com")).toBe("a b dot c, at example dot com");
});

describe("spoken numbers, as speech recognition writes them", () => {
    test("decimals are kept as said, never rounded", () => {
        expect(extractNumber("nine point five")).toBe(9.5);
        expect(extractNumber("size nine point two")).toBe(9.2);
        expect(extractNumber("9 point 5")).toBe(9.5);
        expect(extractNumber("ten and half")).toBe(10.5);
        expect(extractNumber("9½")).toBe(9.5);
        expect(extractNumber("size 9 1/2")).toBe(9.5);
    });

    test("prices and budgets in the forms people say them", () => {
        expect(extractNumber("two thousand rupees")).toBe(2000);
        expect(extractNumber("₹2,000")).toBe(2000);
        expect(extractNumber("Rs. 2,500")).toBe(2500);
        expect(extractNumber("1.5 lakh")).toBe(150000);
        expect(extractNumber("under 3k")).toBe(3000);
        expect(extractNumber("twenty five hundred")).toBe(2500);
        expect(parseBudget("under three thousand")).toEqual({ max: 3000 });
        expect(parseBudget("something under 3k")).toEqual({ max: 3000 });
        expect(parseQuantity("quantity two")).toBe(2);
    });

    test("a size answer: sound-alike words count only in short answers, and odd decimals are reported, not rounded", () => {
        expect(parseSizeAnswer("size nine")).toEqual({ size: "9", system: null });
        expect(parseSizeAnswer("size for")).toEqual({ size: "4", system: null });
        expect(parseSizeAnswer("to")).toEqual({ size: "2", system: null });
        expect(parseSizeAnswer("nine point two")).toEqual({ notShoeSize: "9.2" });
        expect(parseSizeAnswer("I want shoes for running in the park")).toBeNull();
        expect(numberSoundalikes("size for")).toBe("size four");
        expect(numberSoundalikes("shoes for the gym and for running")).toBe("shoes for the gym and for running");
    });
});

describe("yes and no, as people actually answer", () => {
    test("Indian English and Hindi answers", () => {
        for (const t of ["haan", "Haan ji", "yeah sure", "yes, add it", "add it", "sure, why not", "Okay.", "um, yes"]) expect(classifyAnswer(t).answer).toBe("yes");
        for (const t of ["nahi", "nahin", "No.", "know", "no, don't add it", "I don't want it", "please don't add it", "not now"]) expect(classifyAnswer(t).answer).toBe("no");
    });

    test("a correction after no keeps only the new value", () => {
        expect(classifyAnswer("No, I said size ten.")).toEqual({ answer: "no", rest: "size ten" });
        expect(classifyAnswer("No, grey.")).toEqual({ answer: "no", rest: "grey" });
        expect(classifyAnswer("no, I meant blue").rest).toBe("blue");
    });

    test("anything mixed or uncertain is never a yes", () => {
        for (const t of ["why not", "yes no", "add it to my wishlist", "I know", "maybe later", "now"]) expect(classifyAnswer(t).answer).not.toBe("yes");
    });
});

test("email spelling with double and triple letters, and under score", () => {
    expect(parseEmail("a double n a at gmail dot com")).toBe("anna@gmail.com");
    expect(parseEmail("triple seven at example dot in")).toBe("777@example.in");
    expect(parseEmail("john under score doe at the rate gmail dot com")).toBe("john_doe@gmail.com");
    expect(parseEmail("gopinath@gmail.com")).toBe("gopinath@gmail.com");
});

test("long numbers are read back in short groups", () => {
    expect(speakableDigits("9876543210")).toBe("9 8 7 6 5, 4 3 2 1 0");
    expect(speakableDigits("560001")).toBe("5 6 0, 0 0 1");
    expect(speakableDigits("1234")).toBe("1 2 3 4");
});
