import { validateShipping, validateRefillAmount } from "../validation";
import { resolveImage, productImages } from "../images";

test("checkout rejects invalid delivery details", () => {
    expect(Object.keys(validateShipping({}))).toHaveLength(5);
    expect(validateShipping({ customerMobile: "12345", customerAddress: "12 MG Road", customerCity: "Pune", customerState: "MH", customerPincode: "411001" }))
        .toEqual({ customerMobile: expect.any(String) });
    expect(validateShipping({ customerMobile: "98765 43210", customerAddress: "12 MG Road", customerCity: "Pune", customerState: "MH", customerPincode: "411001" }))
        .toEqual({});
});

test("refill amounts must be whole positive rupees within the limit", () => {
    for (const bad of ["", "0", "-5", "10.5", "1e3", "abc", "100001", " "]) {
        expect(validateRefillAmount(bad)).not.toBeNull();
    }
    expect(validateRefillAmount("500")).toBeNull();
});

test("image paths are matched to real files regardless of letter case", () => {
    expect(resolveImage("/images/vans1.png")).toBe("/images/vans1.PNG");
    expect(resolveImage("/images/AirForce1_1.png")).toBe("/images/AirForce1_1.PNG");
    expect(resolveImage("/images/prod11.png")).toBe("/images/prod11.png");
    expect(resolveImage("/images/view cart.png")).toBe("/images/view%20cart.png");
});

describe("product image fields", () => {
    beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
    afterEach(() => console.warn.mockRestore());

    test("a list of paths keeps its order and every real file", () => {
        expect(productImages({ id: "af1", image: ["/images/AirForce1_1.png", "/images/AirForce1_2.png"] }))
            .toEqual(["/images/AirForce1_1.PNG", "/images/AirForce1_2.PNG"]);
    });

    test("an older record with one path (a string) is not split into characters", () => {
        expect(productImages({ id: "v", image: "/images/vans1.png" })).toEqual(["/images/vans1.PNG"]);
    });

    test("missing, empty and unknown images give no URL at all, never another product's picture", () => {
        expect(resolveImage("/images/does-not-exist.png")).toBeNull();
        expect(productImages({ id: "a", image: [] })).toEqual([]);
        expect(productImages({ id: "b" })).toEqual([]);
        expect(productImages({ id: "c", image: ["", null, "/images/watch-1.png"] })).toEqual([]);
        expect(productImages(null)).toEqual([]);
    });

    test("only real files and https URLs are used; Storage paths and other schemes are not guessed", () => {
        expect(resolveImage("https://cdn.example.com/p/1.png")).toBe("https://cdn.example.com/p/1.png");
        expect(resolveImage("gs://bucket/products/1.png")).toBeNull();
        expect(resolveImage("products/1.png")).toBeNull();
        // eslint-disable-next-line no-script-url
        expect(resolveImage("javascript:alert(1)")).toBeNull();
        expect(resolveImage("data:image/png;base64,AAAA")).toBeNull();
        expect(resolveImage("http://insecure.example.com/1.png")).toBeNull();
    });

    test("a bad path is reported once in development, naming the product and without query strings", () => {
        productImages({ id: "w1", image: ["/images/watch-9.png"] });
        productImages({ id: "w1", image: ["/images/watch-9.png"] });
        productImages({ id: "s1", image: ["https://bad.example.com/x.png?token=secret"].map((u) => u.replace("https", "http")) });
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(console.warn.mock.calls[0][0]).toBe('[images] Product w1, field "image": /images/watch-9.png has no matching file in public/images (or is not a supported image URL).');
        expect(console.warn.mock.calls[1][0]).not.toMatch(/secret/);
    });
});
