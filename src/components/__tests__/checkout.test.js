import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BillingPage, { UNCONFIRMED_ORDER } from "../billingpage";
import { UserContext, TTSContext } from "../../App";
import { apiRequest, ApiError } from "../../services/apiClient";
import { readData } from "../firebaseservices";

jest.mock("../firebaseservices", () => ({ readData: jest.fn() }));
jest.mock("../../services/apiClient", () => {
    const actual = jest.requireActual("../../services/apiClient");
    return { ...actual, apiRequest: jest.fn() };
});

const QUOTE = { items: [{ productId: "af1", name: "Nike Air Force 1", size: "9", color: "black", unitPrice: 9000, quantity: 1, lineTotal: 9000 }], subtotal: 9000, tax: 1620, total: 10620, walletBalance: 20000, problems: [] };
const ORDER = { orderId: "u1_abcdefgh12345678", total: 10620, walletBalanceAfter: 9380, items: [{ name: "Nike Air Force 1", quantity: 1 }] };

function renderBilling() {
    return render(
        <MemoryRouter>
            <UserContext.Provider value={{ user: { uid: "u1" }, authReady: true }}>
                <TTSContext.Provider value={{ screenReader: false, changeScreenReader: jest.fn() }}>
                    <BillingPage />
                </TTSContext.Provider>
            </UserContext.Provider>
        </MemoryRouter>
    );
}

async function fillDelivery() {
    fireEvent.change(screen.getByLabelText(/Mobile number/), { target: { value: "9876543210" } });
    fireEvent.change(screen.getByLabelText(/Address/), { target: { value: "12 Park Street" } });
    fireEvent.change(screen.getByLabelText(/City/), { target: { value: "Chennai" } });
    fireEvent.change(screen.getByLabelText(/State/), { target: { value: "Tamil Nadu" } });
    fireEvent.change(screen.getByLabelText(/Pincode/), { target: { value: "600001" } });
}

beforeEach(() => {
    readData.mockResolvedValue({ name: "Asha", wallet: 20000 });
});

test("an order with no answer from the server is reported as unconfirmed, and paying again reuses the same request id", async () => {
    const checkoutCalls = [];
    let answer = "timeout";
    apiRequest.mockImplementation(async (path, options) => {
        if (path === "/api/checkout/quote") return QUOTE;
        checkoutCalls.push(options.body.idempotencyKey);
        expect(options.timeoutMs).toBeGreaterThan(0);
        if (answer === "timeout") throw new ApiError(0, "timeout", "The server did not answer in time.");
        return { order: { ...ORDER, duplicate: true } };
    });
    renderBilling();
    await fillDelivery();
    const pay = await screen.findByRole("button", { name: /Pay ₹10,620 and place order/ });
    await waitFor(() => expect(pay).toBeEnabled());

    fireEvent.click(pay);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(UNCONFIRMED_ORDER);
    expect(alert).not.toHaveTextContent(/The order was not placed/);

    answer = "placed";
    fireEvent.click(screen.getByRole("button", { name: /Pay ₹10,620 and place order/ }));
    expect(await screen.findByText(/Order placed\. You paid ₹10620 for 1 item\./)).toBeInTheDocument();
    expect(checkoutCalls).toHaveLength(2);
    expect(checkoutCalls[0]).toBe(checkoutCalls[1]);
});

test("a refusal from the server says the order was not placed, with the server's reason", async () => {
    apiRequest.mockImplementation(async (path) => {
        if (path === "/api/checkout/quote") return QUOTE;
        throw new ApiError(409, "out_of_stock", 'Only 0 of "Nike Air Force 1" left in stock.');
    });
    renderBilling();
    await fillDelivery();
    const pay = await screen.findByRole("button", { name: /Pay ₹10,620 and place order/ });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent('The order was not placed. Only 0 of "Nike Air Force 1" left in stock.');
});
