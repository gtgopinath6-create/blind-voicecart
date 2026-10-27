import "./ordersummary.css"
import { Link } from "react-router-dom";
import { formatPrice, useHoverSpeech } from "../services/uiHooks";

const TAX_RATE = 0.18;
const money = (n) => Math.round(n * 100) / 100;

/** Estimate from the prices stored in the cart; the billing page shows the server-verified total. */
function OrderSummary(props){
    const hover = useHoverSpeech();
    const subtotal = money(props.subtotal || 0);
    const tax = money(TAX_RATE * subtotal);
    const final = money(subtotal + tax);
    return (
        <aside className="order-summary" aria-labelledby="order-summary-heading">
            <h2 id="order-summary-heading" className="order-summary__title">Order summary</h2>
            <dl className="summary-list">
                <div {...hover(`Subtotal: ₹${subtotal}`)}><dt>Subtotal</dt><dd>{formatPrice(subtotal)}</dd></div>
                <div {...hover(`Taxes: ₹${tax}`)}><dt>Tax (18%)</dt><dd>{formatPrice(tax)}</dd></div>
                <div className="total" {...hover(`Estimated total: ₹${final}`)}><dt>Estimated total</dt><dd>{formatPrice(final)}</dd></div>
            </dl>
            <p className="order-summary__note">Prices are checked again by the server on the billing page before you pay.</p>
            <button type="button" className="btn btn-gold btn-lg btn-block" onClick={props.toBilling} disabled={!props.canProceed} {...hover("Proceed to billing")}>
                Proceed to billing
            </button>
            <Link to="/shop" className="order-summary__continue">Continue shopping</Link>
        </aside>
    )
}

export default OrderSummary;
