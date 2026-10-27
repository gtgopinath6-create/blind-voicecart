import "./billingpage.css"
import Icon from "./Icon";
import { formatPrice, useHoverSpeech } from "../services/uiHooks";

/** Server-quoted totals and the Pay button. Disabled while paying or when the order is not ready. */
function FinalSummary({ quote, balance, placing, ready, problems, onPay }){
    const hover = useHoverSpeech();
    const subtotal = quote ? quote.subtotal : 0;
    const tax = quote ? quote.tax : 0;
    const total = quote ? quote.total : 0;
    const newBalance = Math.round((balance - total) * 100) / 100;

    return (
        <section className="checkout-card final-summary" aria-labelledby="final-total-heading">
            <h2 id="final-total-heading" className="checkout-card__title">Payment</h2>
            <dl className="summary-list">
                <div {...hover(`Subtotal: ₹${subtotal}`)}><dt>Subtotal</dt><dd>{formatPrice(subtotal)}</dd></div>
                <div {...hover(`Taxes: ₹${tax}`)}><dt>Tax (18%)</dt><dd>{formatPrice(tax)}</dd></div>
                <div className="total" {...hover(`Final total: ₹${total}`)}><dt>Total</dt><dd>{formatPrice(total)}</dd></div>
                <div {...hover(`Wallet balance: ₹${balance}`)}><dt>Wallet balance</dt><dd>{formatPrice(balance)}</dd></div>
                <div {...hover(`Balance after payment: ₹${newBalance}`)}>
                    <dt>Balance after payment</dt>
                    <dd>{newBalance >= 0 ? formatPrice(newBalance) : "Not enough"}</dd>
                </div>
            </dl>
            <button
                type="button"
                className="btn btn-gold btn-lg btn-block"
                disabled={!ready || placing}
                aria-busy={placing}
                aria-describedby={!ready ? "checkout-problems" : undefined}
                onClick={onPay}
                {...hover(ready ? `Pay ₹${total} and place your order` : "Pay is not available yet")}
            >
                {placing ? "Placing order…" : `Pay ${formatPrice(total)} and place order`}
            </button>
            {!ready ? (
                <div id="checkout-problems" className="checkout-problems">
                    <p className="checkout-problems__title"><Icon name="alert" size={18} /> Before you can pay</p>
                    <ul>
                        {problems.map((p) => <li key={p}>{p}</li>)}
                    </ul>
                </div>
            ) : null}
            <p className="field-hint">Paid from your VoiceCart wallet. Pressing Pay twice can never charge you twice.</p>
        </section>
    )
}

export default FinalSummary;
