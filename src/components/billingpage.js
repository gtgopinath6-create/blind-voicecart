import OrderTable from "./ordertable"
import React, {useState, useContext, useEffect, useRef, useCallback} from "react";
import { Link } from "react-router-dom";
import RefillWallet from "./refillwallet";
import "./billingpage.css"
import CustInfo from "./custinfo";
import FinalSummary from "./finalsummary";
import { UserContext } from "../App";
import Icon from "./Icon";
import { usePageTitle } from "../services/uiHooks";
import { readData } from "./firebaseservices";
import { apiRequest, newRequestId } from "../services/apiClient";
import { validateShipping, inputIdFor, SHIPPING_FIELDS } from "../services/validation";
import { registerBilling } from "../services/voiceContext";
import { announce } from "../services/announcer";

const EMPTY_SHIPPING = { customerMobile: "", customerAddress: "", customerCity: "", customerState: "", customerPincode: "" };
const CHECKOUT_TIMEOUT_MS = 30 * 1000;
// No answer from the server: the order may or may not exist. Paying again resends the same request
// id, so the server returns the existing order instead of charging a second time.
export const UNCONFIRMED_ORDER =
    "We couldn't confirm your order because the server didn't answer. It may or may not have been placed. " +
    "Try again to check: the same order request is sent again, so you can't be charged twice.";

/**
 * Checkout. Totals come from the server (/api/checkout/quote) and the order is placed by
 * the server (/api/checkout), which re-reads prices, checks stock and the wallet, and uses
 * an idempotency key so a double click or a retry can never charge twice.
 */
function BillingPage(){
    const {user, authReady} = useContext(UserContext);
    usePageTitle("Checkout");

    const [profile, setProfile] = useState(null);
    const [quote, setQuote] = useState(null);
    const [loadError, setLoadError] = useState("");
    const [shipping, setShipping] = useState(EMPTY_SHIPPING);
    const [fieldErrors, setFieldErrors] = useState({});
    const [placing, setPlacing] = useState(false);
    const [result, setResult] = useState(null); // { ok, message }
    const idempotencyKeyRef = useRef(newRequestId());
    const placingRef = useRef(false);
    const resultRef = useRef(null);

    const load = useCallback(async () => {
        if (!user) return;
        setLoadError("");
        try {
            setProfile(await readData("users", "", user));
        } catch (e) {
            console.error("Could not read profile:", e);
        }
        try {
            setQuote(await apiRequest("/api/checkout/quote", { body: {} }));
        } catch (e) {
            setQuote(null);
            setLoadError(e.status === 0 || e.code === "server_not_configured"
                ? "Checkout is unavailable right now because the payment server cannot be reached. Your cart is saved."
                : `${e.message} Your cart is saved.`);
        }
    }, [user]);

    useEffect(() => {
        if (authReady && user) load();
    }, [authReady, user, load]);

    // Refresh the quote when the voice assistant changes the cart while this page is open.
    useEffect(() => {
        const onCartUpdated = () => { if (!placingRef.current) load(); };
        window.addEventListener("CART_UPDATED", onCartUpdated);
        return () => window.removeEventListener("CART_UPDATED", onCartUpdated);
    }, [load]);

    const balance = quote ? quote.walletBalance : (profile && Number(profile.wallet)) || 0;
    const items = quote ? quote.items : [];
    const total = quote ? quote.total : 0;

    const problems = [];
    if (!quote) problems.push(loadError || "The order total is still loading.");
    else {
        if (items.length === 0) problems.push("Your cart is empty.");
        problems.push(...quote.problems);
        if (total > balance) problems.push(`Your wallet balance of ₹${balance} is less than the total of ₹${total}.`);
    }
    const shippingErrors = validateShipping(shipping);
    const incomplete = SHIPPING_FIELDS.filter((rule) => shippingErrors[rule.field]).map((rule) => rule.label);
    if (incomplete.length) problems.push(`Please complete your delivery details: ${incomplete.join(", ")}.`);
    const ready = problems.length === 0;

    function updateShipping(field, value) {
        setShipping((s) => ({ ...s, [field]: value }));
        if (fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: undefined }));
    }

    // Check a field when the shopper leaves it (only once something was typed), so a mistake is
    // reported next to the field without waiting for Pay.
    function checkField(field) {
        if (!String(shipping[field] || "").trim()) return;
        const error = validateShipping(shipping)[field];
        setFieldErrors((e) => ({ ...e, [field]: error }));
    }

    const placeOrder = useCallback(async () => {
        if (placingRef.current) return { ok: false, message: "Your order is already being placed. Please wait." };
        const errors = validateShipping(shipping);
        if (Object.keys(errors).length) {
            setFieldErrors(errors);
            const first = document.getElementById(inputIdFor(Object.keys(errors)[0]));
            if (first) first.focus();
            const message = `Please correct the delivery details: ${Object.values(errors).join(" ")}`;
            announce(message);
            return { ok: false, message };
        }
        placingRef.current = true;
        setPlacing(true);
        setResult(null);
        let outcome;
        try {
            const { order } = await apiRequest("/api/checkout", {
                body: { idempotencyKey: idempotencyKeyRef.current, shipping },
                timeoutMs: CHECKOUT_TIMEOUT_MS,
            });
            const count = order.items.reduce((n, l) => n + l.quantity, 0);
            outcome = {
                ok: true,
                message: `Order placed. You paid ₹${order.total} for ${count} ${count === 1 ? "item" : "items"}. ` +
                    `Your new wallet balance is ₹${order.walletBalanceAfter}. Order reference ${order.orderId.slice(-8)}.`,
            };
            // A new key for any later, separate order.
            idempotencyKeyRef.current = newRequestId();
            setQuote((q) => (q ? { ...q, items: [], subtotal: 0, tax: 0, total: 0, walletBalance: order.walletBalanceAfter, problems: [] } : q));
            // The server emptied the cart: let the header count catch up.
            window.dispatchEvent(new CustomEvent("CART_UPDATED", { detail: { reason: "order" } }));
        } catch (e) {
            if (e.fields) setFieldErrors(e.fields);
            // The same key is kept, so retrying after a network error cannot create a second order.
            outcome = { ok: false, message: e.status === 0 ? UNCONFIRMED_ORDER : `The order was not placed. ${e.message}` };
        } finally {
            placingRef.current = false;
            setPlacing(false);
        }
        setResult(outcome);
        announce(outcome.message);
        setTimeout(() => resultRef.current && resultRef.current.focus(), 0);
        return outcome;
    }, [shipping]);

    // Let Zoro ("place my order") use exactly this checkout (after spoken confirmation).
    const summaryRef = useRef();
    summaryRef.current = { ready, problems, total, itemCount: items.reduce((n, l) => n + l.quantity, 0) };
    // Zoro reads and fills the delivery form one confirmed answer at a time (same validation as typing).
    const shippingRef = useRef(shipping);
    shippingRef.current = shipping;
    useEffect(() => registerBilling({
        getSummary: () => summaryRef.current,
        placeOrder: () => placeOrder(),
        getShipping: () => shippingRef.current,
        setShippingField: (field, value) => {
            if (!(field in EMPTY_SHIPPING)) return;
            shippingRef.current = { ...shippingRef.current, [field]: value };
            setShipping((current) => ({ ...current, [field]: value }));
            setFieldErrors((errors) => (errors[field] ? { ...errors, [field]: undefined } : errors));
        },
    }), [placeOrder]);

    let content;
    if (!authReady) {
        content = <p role="status" className="loading">Loading…</p>;
    } else if (!user) {
        content = (
            <div className="empty-state billingGuest">
                <h2>Sign in to check out</h2>
                <p>Your guest cart will be added to your account when you sign in.</p>
                <Link to="/sign" className="btn btn-primary">Sign in</Link>
            </div>
        );
    } else {
        content = (
            <>
                {result ? (
                    <div ref={resultRef} tabIndex={-1} role={result.ok ? "status" : "alert"} className={`banner ${result.ok ? "banner--success" : "banner--error"} checkout__result`}>
                        <Icon name={result.ok ? "check" : "alert"} size={20} />
                        <p>{result.message} {result.ok ? <Link to="/">Continue shopping</Link> : null}</p>
                    </div>
                ) : null}
                {loadError ? (
                    <div role="alert" className="banner banner--error checkout__result">
                        <Icon name="alert" size={20} />
                        <p>{loadError} <button type="button" className="link-button" onClick={load}>Try again</button></p>
                    </div>
                ) : null}
                <div className="checkout__layout">
                    <div className="checkout__main">
                        <CustInfo profile={profile} shipping={shipping} errors={fieldErrors} onChange={updateShipping} onBlur={checkField}></CustInfo>
                        <RefillWallet balance={balance} balanceLoaded={Boolean(quote || profile)} onBalanceChange={() => load()}></RefillWallet>
                    </div>
                    <aside className="checkout__summary" aria-label="Order summary and payment">
                        <OrderTable items={items}></OrderTable>
                        <FinalSummary
                            quote={quote}
                            balance={balance}
                            placing={placing}
                            ready={ready}
                            problems={problems}
                            onPay={placeOrder}
                        ></FinalSummary>
                    </aside>
                </div>
            </>
        );
    }

    return (
        <div className="container checkout">
            <header className="page-header">
                <nav aria-label="Breadcrumb" className="breadcrumb">
                    <ol>
                        <li><Link to="/cart">Cart</Link></li>
                        <li><span aria-current="page">Checkout</span></li>
                    </ol>
                </nav>
                <p className="eyebrow">Checkout</p>
                <h1 className="page-title">Review and pay</h1>
                <p className="page-subtitle">Totals are calculated by the server. You are charged only when you press Pay, or say “yes” to the assistant’s order summary.</p>
            </header>
            {content}
        </div>
    )
}

export default BillingPage;
