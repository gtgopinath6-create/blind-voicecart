import React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { axe, toHaveNoViolations } from "jest-axe";
import { AdminRoute } from "../PrivateRoute";
import Account from "../account";
import Sign from "../Sign";
import CustInfo from "../custinfo";
import FilterPane from "../filterpane";
import Product from "../products";
import FinalSummary from "../finalsummary";
import Navbar from "../navbar";
import { UserContext, TTSContext, ThemeContext, SearchContext } from "../../App";
import { readData } from "../firebaseservices";

expect.extend(toHaveNoViolations);

jest.mock("../firebaseservices", () => ({
    readData: jest.fn(),
    ensureUserProfile: jest.fn(),
    setProfileName: jest.fn(),
}));

function withProviders(ui, user = {}) {
    return (
        <UserContext.Provider value={{ user: null, isAdmin: false, authReady: true, ...user }}>
            <TTSContext.Provider value={{ screenReader: false, changeScreenReader: jest.fn() }}>
                <ThemeContext.Provider value={{ theme: "noir", chooseTheme: jest.fn() }}>
                    {ui}
                </ThemeContext.Provider>
            </TTSContext.Provider>
        </UserContext.Provider>
    );
}

function renderAdminRoute(user) {
    return render(withProviders(
        <MemoryRouter initialEntries={["/admin"]}>
            <Routes>
                <Route path="/admin" element={<AdminRoute><h1>Admin Panel</h1></AdminRoute>} />
                <Route path="/sign" element={<h1>Sign in page</h1>} />
            </Routes>
        </MemoryRouter>, user));
}

test("guests are sent to sign in instead of the admin panel", () => {
    renderAdminRoute({ user: null });
    expect(screen.getByRole("heading", { name: "Sign in page" })).toBeInTheDocument();
    expect(screen.queryByText("Admin Panel")).not.toBeInTheDocument();
});

test("signed-in users without the admin claim are denied", () => {
    renderAdminRoute({ user: { uid: "u1" }, isAdmin: false });
    expect(screen.getByRole("alert")).toHaveTextContent(/administrator access/i);
    expect(screen.queryByText("Admin Panel")).not.toBeInTheDocument();
});

test("the admin claim grants the admin panel", () => {
    renderAdminRoute({ user: { uid: "a1" }, isAdmin: true });
    expect(screen.getByRole("heading", { name: "Admin Panel" })).toBeInTheDocument();
});

test("nothing is shown while sign-in state is still loading", () => {
    renderAdminRoute({ user: null, authReady: false });
    expect(screen.getByRole("status")).toHaveTextContent(/checking/i);
});

test("the account page does not crash for guests", () => {
    render(withProviders(<MemoryRouter><Account /></MemoryRouter>));
    expect(screen.getByText(/you are not signed in/i)).toBeInTheDocument();
});

test("the account page loads the profile for signed-in users", async () => {
    readData.mockResolvedValue({ name: "Asha", email: "asha@example.com", wallet: 0 });
    render(withProviders(<MemoryRouter><Account /></MemoryRouter>, { user: { uid: "u1" } }));
    expect(await screen.findByText("Asha")).toBeInTheDocument();
});

const product = { id: "af1", name: "Nike Air Force 1", price: 9000, rating: 5, image: ["/images/AirForce1_1.png", "/images/AirForce1_2.png"], description: "The radiance lives on in the Nike Air Force 1.", category: ["shoes", "casual", "nike"] };

test("product card: named controls, a thumbnail gallery and a link to the product page", async () => {
    const { container } = render(withProviders(<MemoryRouter><Product product={product} addToCart={jest.fn()} addToWishlist={jest.fn()} /></MemoryRouter>));
    const gallery = screen.getByRole("group", { name: "Images of Nike Air Force 1" });
    const thumbs = within(gallery).getAllByRole("button");
    expect(thumbs.map((b) => b.getAttribute("aria-label"))).toEqual(["Show image 1 of 2", "Show image 2 of 2"]);
    expect(thumbs[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(thumbs[1]);
    expect(thumbs[1]).toHaveAttribute("aria-pressed", "true");
    // Visible label first ("Add to cart"), then the product and price for screen readers.
    expect(screen.getByRole("button", { name: /^Add to cart\s?: Nike Air Force 1, ₹9000$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Nike Air Force 1 to wishlist" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nike Air Force 1" })).toHaveAttribute("href", "/product/af1");
    expect(screen.getByRole("heading", { level: 2, name: "Nike Air Force 1" })).toBeInTheDocument();
    expect(await axe(container, { rules: {} })).toHaveNoViolations();
});

test("product card: the saved heart says so in its name, not only by colour", async () => {
    render(withProviders(<MemoryRouter><Product product={product} addToCart={jest.fn()} addToWishlist={jest.fn().mockResolvedValue(true)} /></MemoryRouter>));
    fireEvent.click(screen.getByRole("button", { name: "Add Nike Air Force 1 to wishlist" }));
    expect(await screen.findByRole("button", { name: "Nike Air Force 1 is in your wishlist" })).toBeInTheDocument();
});

test("product card: adding without a required size is refused and points to the size field", async () => {
    const addToCart = jest.fn();
    const shoe = { ...product, size: ["7", "8"], color: ["black", "white"] };
    render(withProviders(<MemoryRouter><Product product={shoe} addToCart={addToCart} addToWishlist={jest.fn()} /></MemoryRouter>));
    fireEvent.click(screen.getByRole("button", { name: /^Add to cart/ }));
    const size = screen.getByLabelText("Size");
    expect(addToCart).not.toHaveBeenCalled();
    expect(size).toHaveFocus();
    expect(size).toHaveAttribute("aria-invalid", "true");
    expect(size).toHaveAccessibleDescription(/choose a size/i);
});

test("sign-in form has labelled fields and passes axe", async () => {
    const { container } = render(withProviders(<MemoryRouter><Sign /></MemoryRouter>));
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toHaveAttribute("type", "button");
    expect(await axe(container)).toHaveNoViolations();
});

test("delivery form links errors to fields and passes axe", async () => {
    const { container } = render(withProviders(
        <CustInfo profile={{ name: "Asha", email: "a@example.com" }} shipping={{ customerMobile: "1", customerAddress: "", customerCity: "", customerState: "", customerPincode: "" }}
            errors={{ customerMobile: "Enter a valid 10-digit mobile number." }} onChange={jest.fn()} />
    ));
    // The required asterisk is decorative (aria-hidden), so the accessible name is just the label.
    const mobile = screen.getByRole("textbox", { name: "Mobile number" });
    expect(mobile).toHaveAttribute("aria-invalid", "true");
    expect(mobile).toHaveAccessibleDescription(/10 digits.*Enter a valid 10-digit mobile number/);
    expect(await axe(container)).toHaveNoViolations();
});

test("delivery form reports the field the shopper leaves, so it can be checked before Pay", () => {
    const onBlur = jest.fn();
    render(withProviders(
        <CustInfo profile={null} shipping={{ customerMobile: "12345", customerAddress: "", customerCity: "", customerState: "", customerPincode: "" }}
            errors={{}} onChange={jest.fn()} onBlur={onBlur} />
    ));
    fireEvent.blur(screen.getByRole("textbox", { name: "Mobile number" }));
    expect(onBlur).toHaveBeenCalledWith("customerMobile");
});

test("header: the Light theme switch chooses Ivory, and Noir again when turned off", async () => {
    const chooseTheme = jest.fn();
    readData.mockResolvedValue(null);
    const header = (theme) => (
        <UserContext.Provider value={{ user: null, isAdmin: false, authReady: true, setUser: jest.fn() }}>
            <TTSContext.Provider value={{ screenReader: false, changeScreenReader: jest.fn() }}>
                <ThemeContext.Provider value={{ theme, chooseTheme }}>
                    <SearchContext.Provider value={{ valueToBeSearched: "", setValueToBeSearched: jest.fn() }}>
                        <MemoryRouter><Navbar /></MemoryRouter>
                    </SearchContext.Provider>
                </ThemeContext.Provider>
            </TTSContext.Provider>
        </UserContext.Provider>
    );
    const { rerender } = render(header("noir"));
    const toggle = screen.getByRole("switch", { name: "Light theme" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(chooseTheme).toHaveBeenLastCalledWith("ivory");
    rerender(header("ivory"));
    expect(screen.getByRole("switch", { name: "Light theme" })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Light theme" }));
    expect(chooseTheme).toHaveBeenLastCalledWith("noir");
    expect(await screen.findByRole("link", { name: "Cart, 0 items" })).toBeInTheDocument();
});

test("brand filter offers a way back to all brands and passes axe", async () => {
    const { container } = render(withProviders(<FilterPane brands={["adidas", "nike"]} selectedBrand="nike" filterBrand={jest.fn()} />));
    expect(screen.getByRole("button", { name: "All brands" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Nike" })).toHaveAttribute("aria-pressed", "true");
    expect(await axe(container)).toHaveNoViolations();
});

test("the Pay button is disabled while an order is being placed or when not ready", () => {
    const quote = { subtotal: 100, tax: 18, total: 118, items: [], problems: [] };
    const { rerender } = render(withProviders(<FinalSummary quote={quote} balance={500} placing={false} ready={true} problems={[]} onPay={jest.fn()} />));
    expect(screen.getByRole("button", { name: /pay ₹118/i })).toBeEnabled();
    rerender(withProviders(<FinalSummary quote={quote} balance={500} placing={true} ready={true} problems={[]} onPay={jest.fn()} />));
    expect(screen.getByRole("button", { name: /placing order/i })).toBeDisabled();
    rerender(withProviders(<FinalSummary quote={quote} balance={50} placing={false} ready={false} problems={["Your wallet balance of ₹50 is less than the total of ₹118."]} onPay={jest.fn()} />));
    expect(screen.getByRole("button", { name: /pay ₹118/i })).toBeDisabled();
    expect(screen.getByText(/less than the total/)).toBeInTheDocument();
});
