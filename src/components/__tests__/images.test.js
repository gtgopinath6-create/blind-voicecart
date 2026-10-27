/* eslint-disable testing-library/no-node-access, testing-library/no-container --
   These tests check states that are deliberately hidden from assistive technology (decorative
   images with alt="" and aria-hidden placeholders), which role-based queries cannot reach. */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe, toHaveNoViolations } from "jest-axe";
import ProductImage, { resetFailedImages } from "../ProductImage";
import Categories from "../Categories";
import Product from "../products";
import { TTSContext } from "../../App";

expect.extend(toHaveNoViolations);

beforeEach(() => {
    resetFailedImages();
    jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

const frame = (container) => container.querySelector(".photo");
const withProviders = (ui) => (
    <MemoryRouter>
        <TTSContext.Provider value={{ screenReader: false, changeScreenReader: jest.fn() }}>{ui}</TTSContext.Provider>
    </MemoryRouter>
);

test("a loading image keeps its frame, and the note appears only if loading takes a while", () => {
    const { container } = render(<ProductImage src="/images/vans1.PNG" name="Vans Old Skool" />);
    expect(frame(container)).toHaveAttribute("data-state", "loading");
    expect(container.querySelector("img")).toHaveAttribute("src", "/images/vans1.PNG");
    // The note is in the DOM but faded in by CSS after a delay; it is hidden from screen readers.
    expect(container.querySelector(".photo__placeholder")).toHaveAttribute("aria-hidden", "true");
});

test("once loaded, only the photo remains", () => {
    const { container } = render(<ProductImage src="/images/vans1.PNG" name="Vans Old Skool" />);
    fireEvent.load(container.querySelector("img"));
    expect(frame(container)).toHaveAttribute("data-state", "loaded");
    expect(container.querySelector(".photo__placeholder")).toBeNull();
});

test("a failed image shows the product name instead of an empty frame or a broken image, and is not requested again", () => {
    const { container } = render(<ProductImage src="/images/gone.png" name="Nike Blazer" productId="nb1" />);
    fireEvent.error(container.querySelector("img"));
    expect(frame(container)).toHaveAttribute("data-state", "failed");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Nike Blazer")).toBeInTheDocument();
    expect(screen.getByText("Image not available")).toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith('[images] Product nb1, field "image": /images/gone.png failed to load.');

    // Another card with the same URL starts as failed, without a new request.
    const view = render(<ProductImage src="/images/gone.png" name="Nike Blazer" productId="nb1" />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
});

test("a product without an image says so at once", () => {
    const { container } = render(<ProductImage src={undefined} name="Chilli Chatka" />);
    expect(frame(container)).toHaveAttribute("data-state", "missing");
    expect(screen.getByText("Image not available")).toBeInTheDocument();
});

test("on the product page a failed image keeps a description for screen readers", () => {
    const { container } = render(<ProductImage src="/images/gone.png" name="Nike Blazer" alt="Nike Blazer, view 1 of 2" />);
    fireEvent.error(container.querySelector("img"));
    expect(screen.getByRole("img", { name: "Nike Blazer, view 1 of 2. Image not available." })).toBeInTheDocument();
});

test("thumbnails show no text when they fail", () => {
    const { container } = render(<ProductImage src="/images/gone.png" compact />);
    fireEvent.error(container.querySelector("img"));
    expect(container.querySelector(".photo__placeholder")).toBeEmptyDOMElement();
});

describe("category tiles", () => {
    test("with a picture, the picture loads", () => {
        const { container } = render(withProviders(<Categories name="Shoes" image="/images/AirForce1_1.PNG" />));
        expect(container.querySelector(".category-tile__media img")).toHaveAttribute("src", "/images/AirForce1_1.PNG");
    });

    test("while the picture is looked up, nothing is requested and the frame waits", () => {
        const { container } = render(withProviders(<Categories name="Shoes" image={undefined} />));
        expect(container.querySelector("img")).toBeNull();
        expect(frame(container)).toHaveAttribute("data-state", "loading");
    });

    test("without a picture, the tile shows the category name instead of a blank frame", async () => {
        const { container } = render(withProviders(<Categories name="Food" image={null} />));
        expect(frame(container)).toHaveAttribute("data-state", "missing");
        expect(container.querySelector(".photo__name")).toHaveTextContent("Food");
        // Still one link, named once for screen readers.
        expect(screen.getByRole("link")).toHaveAccessibleName("Food Explore");
        expect(await axe(container)).toHaveNoViolations();
    });
});

test("a product card uses the stored image list, and a card without images shows its name", () => {
    const withImages = { id: "af1", name: "Nike Air Force 1", price: 9000, image: ["/images/AirForce1_1.png", "/images/AirForce1_2.png"], category: ["shoes", "casual", "nike"] };
    const { container, unmount } = render(withProviders(<Product product={withImages} compact />));
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/images/AirForce1_1.PNG", "/images/AirForce1_1.PNG", "/images/AirForce1_2.PNG"]);
    unmount();

    const without = { id: "x1", name: "Mystery Snack", price: 10, image: [], category: ["food", "dry snacks", "x"] };
    const view = render(withProviders(<Product product={without} compact />));
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".photo__name")).toHaveTextContent("Mystery Snack");
});
