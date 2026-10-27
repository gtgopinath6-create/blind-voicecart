import { useEffect, useRef, useState } from "react";
import "./refillwallet.css"
import { apiRequest, newRequestId } from "../services/apiClient";
import { validateRefillAmount } from "../services/validation";
import { announce } from "../services/announcer";
import { formatPrice, useHoverSpeech } from "../services/uiHooks";

/**
 * Wallet balance and refill. The balance is changed only by the server, and only after a
 * verified payment. No payment provider is connected yet: the server reports this through
 * /api/health (devWalletCredit is the emulator-only test mode), so the page shows refills as
 * unavailable instead of offering a button that cannot work. The server enforces it either way.
 */
function RefillWallet({ balance, balanceLoaded, onBalanceChange }){
    const hover = useHoverSpeech();
    const [availability, setAvailability] = useState("checking"); // checking | available | unavailable | unknown
    const [open, setOpen] = useState(false);
    const [amount, setAmount] = useState("");
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);
    const requestIdRef = useRef(newRequestId());

    useEffect(() => {
        let cancelled = false;
        apiRequest("/api/health", { method: "GET", auth: false })
            .then((health) => { if (!cancelled) setAvailability(health.devWalletCredit ? "available" : "unavailable"); })
            .catch(() => { if (!cancelled) setAvailability("unknown"); });
        return () => { cancelled = true; };
    }, []);

    async function submit(event) {
        event.preventDefault();
        const problem = validateRefillAmount(amount);
        if (problem) {
            setError(problem);
            announce(problem);
            return;
        }
        setBusy(true);
        setError("");
        setStatus("");
        try {
            const { transaction } = await apiRequest("/api/wallet/refill", {
                body: { amount: Number(amount), idempotencyKey: requestIdRef.current },
            });
            requestIdRef.current = newRequestId();
            const message = `Wallet refilled with ₹${transaction.amount}. New balance ₹${transaction.balanceAfter}.`;
            setStatus(message);
            announce(message);
            setAmount("");
            setOpen(false);
            onBalanceChange();
        } catch (e) {
            const message = e.code === "payments_unavailable"
                ? "Wallet refill is not available yet because no payment provider is connected. Your balance was not changed."
                : `Refill failed: ${e.message} Your balance was not changed.`;
            if (e.code === "payments_unavailable") setAvailability("unavailable");
            setError(message);
            announce(message);
        } finally {
            setBusy(false);
        }
    }

    let action = null;
    if (availability === "unavailable") {
        action = <p className="banner banner--info wallet__note">Refills are not available yet because no payment provider is connected. Nothing can be charged here.</p>;
    } else if (open) {
        action = (
            <form className="wallet__form" onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="updateBalance">Amount in rupees</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        id="updateBalance"
                        className="input"
                        value={amount}
                        onChange={(e) => { setAmount(e.target.value); setError(""); }}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? "refill-error" : undefined}
                        autoFocus
                    />
                    {error ? <p id="refill-error" className="form-error">{error}</p> : null}
                </div>
                <div className="wallet__buttons">
                    <button type="submit" className="btn btn-primary" disabled={busy || !balanceLoaded}>{busy ? "Processing…" : "Add to wallet"}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
                </div>
            </form>
        );
    } else if (availability !== "checking") {
        action = (
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} disabled={!balanceLoaded} {...hover("Add money to wallet")}>
                Add money to wallet
            </button>
        );
    }

    return(
        <section className="checkout-card wallet" aria-labelledby="refillHeader">
            <h2 id="refillHeader" className="checkout-card__title">Wallet</h2>
            <div className="wallet__balance" {...hover(`Current balance: ₹${balance}`)}>
                <p className="wallet__label">Current balance</p>
                <p className="wallet__amount price">{balanceLoaded ? formatPrice(balance) : "Loading…"}</p>
            </div>
            {status ? <p className="form-success">{status}</p> : null}
            {!open && error ? <p className="form-error">{error}</p> : null}
            {action}
        </section>
    )
}

export default RefillWallet;
