import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe, toHaveNoViolations } from "jest-axe";
import Container from "../container";
import { UserContext, TTSContext, SearchContext, VoiceFilterContext } from "../../App";
import { createListing, loadCatalog, CatalogError } from "../../services/catalogService";

expect.extend(toHaveNoViolations);

jest.mock("../../services/catalogService", () => {
    const actual = jest.requireActual("../../services/catalogService");
    return { ...actual, createListing: jest.fn(), loadCatalog: jest.fn() };
});

const shoe = (n) => ({ id: `s${n}`, name: `Shoe ${n}`, price: 1000 + n, rating: 4, image: [], category: ["shoes", "casual", n % 2 ? "nike" : "puma"] });

function fakeListing(steps) {
    const queue = [...steps];
    return { more: jest.fn(async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next; }) };
}

function renderPage(name = "Shoes", search = "", voiceFilter = null) {
    return render(
        <MemoryRouter>
            <UserContext.Provider value={{ user: null, authReady: true }}>
                <TTSContext.Provider value={{ screenReader: false, changeScreenReader: jest.fn() }}>
                    <SearchContext.Provider value={{ valueToBeSearched: search, setValueToBeSearched: jest.fn() }}>
                        <VoiceFilterContext.Provider value={{ voiceFilter, setVoiceFilter: jest.fn() }}>
                            <Container name={name} />
                        </VoiceFilterContext.Provider>
                    </SearchContext.Provider>
                </TTSContext.Provider>
            </UserContext.Provider>
        </MemoryRouter>
    );
}

const productNames = () => within(screen.getByRole("list", { name: "Shoes" })).getAllByRole("heading").map((h) => h.textContent);

test("a category shows its first page; Show more adds the next one and moves focus to the first new product", async () => {
    const listing = fakeListing([
        { products: [shoe(1), shoe(2), shoe(3)], done: false },
        { products: [shoe(1), shoe(2), shoe(3), shoe(4), shoe(5)], done: true },
    ]);
    createListing.mockReturnValue(listing);
    renderPage();
    expect(await screen.findByText("3 pieces shown, more available")).toBeInTheDocument();
    expect(createListing).toHaveBeenCalledWith({ category: "shoes" });
    expect(productNames()).toEqual(["Shoe 1", "Shoe 2", "Shoe 3"]);
    expect(screen.getByRole("group", { name: "Brand" })).toHaveAccessibleDescription(/Brands among the products shown so far/);

    fireEvent.click(screen.getByRole("button", { name: "Show more products" }));
    await waitFor(() => expect(productNames()).toHaveLength(5));
    await waitFor(() => expect(screen.getByRole("link", { name: "Shoe 4" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Show more products" })).not.toBeInTheDocument();
    expect(screen.getByText("5 pieces")).toBeInTheDocument();
    expect(loadCatalog).not.toHaveBeenCalled();
});

test("a catalog that cannot load says why, keeps the cart message honest, and offers to try again", async () => {
    createListing
        .mockReturnValueOnce(fakeListing([new CatalogError("quota", "resource-exhausted")]))
        .mockReturnValueOnce(fakeListing([{ products: [shoe(1)], done: true }]));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The product catalog can't be loaded right now because the store has reached its database usage limit. Your cart hasn't been changed.");
    expect(screen.queryByText(/No products found/)).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 piece")).toBeInTheDocument();
    expect(createListing).toHaveBeenCalledTimes(2);
});

test("a failed Show more keeps the products already shown", async () => {
    createListing.mockReturnValue(fakeListing([
        { products: [shoe(1), shoe(2)], done: false },
        new CatalogError("transient", "unavailable"),
    ]));
    renderPage();
    await screen.findByText("2 pieces shown, more available");
    fireEvent.click(screen.getByRole("button", { name: "Show more products" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be loaded\. Check your internet connection/);
    expect(productNames()).toEqual(["Shoe 1", "Shoe 2"]);
    expect(screen.getByRole("button", { name: "Show more products" })).toBeEnabled();
});

test("a text search reads the shared catalog instead of paging", async () => {
    loadCatalog.mockResolvedValue([shoe(1), { ...shoe(2), name: "Air Max" }]);
    renderPage("Search Results", "air");
    expect(await screen.findByText("1 piece")).toBeInTheDocument();
    expect(createListing).not.toHaveBeenCalled();
});

test("a voice filter for this category narrows the list and highlights the matching Brand chip", async () => {
    createListing.mockReturnValue(fakeListing([{ products: [shoe(1), shoe(2), shoe(3), shoe(4)], done: true }]));
    renderPage("Shoes", "", { category: "Shoes", brand: "nike" });
    await screen.findByText(/piece/);
    // The list's own accessible name now includes the brand, same as a manual brand-chip click would.
    const names = within(screen.getByRole("list", { name: "Shoes, Nike" })).getAllByRole("heading").map((h) => h.textContent);
    expect(names).toEqual(["Shoe 1", "Shoe 3"]); // odd-numbered shoes are "nike" per the shoe() fixture
    expect(screen.getByRole("button", { name: "Nike" })).toHaveAttribute("aria-pressed", "true");
});

test("a voice filter learned for a different category does not affect this page", async () => {
    createListing.mockReturnValue(fakeListing([{ products: [shoe(1), shoe(2)], done: true }]));
    renderPage("Shoes", "", { category: "Electronics", brand: "nike" });
    await screen.findByText(/piece/);
    expect(productNames()).toEqual(["Shoe 1", "Shoe 2"]);
});

test("the paged listing has no automatically detectable accessibility violations", async () => {
    createListing.mockReturnValue(fakeListing([{ products: [shoe(1), shoe(2)], done: false }]));
    const { container } = renderPage();
    await screen.findByRole("button", { name: "Show more products" });
    expect(await axe(container)).toHaveNoViolations();
});
