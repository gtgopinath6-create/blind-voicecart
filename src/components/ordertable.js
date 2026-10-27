import React from "react";
import "./ordertable.css"
import { formatPrice, useHoverSpeech } from "../services/uiHooks";

const options = (line) => [line.size && `Size ${line.size}`, line.color && `Colour ${line.color}`].filter(Boolean).join(" · ");

/** Items and prices as quoted by the server. */
function OrderTable({ items }){
    const hover = useHoverSpeech();

    return(
        <section className="checkout-card" aria-labelledby="orderHeader">
            <h2 id="orderHeader" className="checkout-card__title">Your order</h2>
            <div className="table-scroll">
                <table className="data-table order-table">
                    <caption className="visually-hidden">Items in this order, with server-verified prices</caption>
                    <thead>
                        <tr>
                            <th scope="col">Product</th>
                            <th scope="col" className="num">Qty</th>
                            <th scope="col" className="num">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.length === 0 ? (
                            <tr><td colSpan={3} className="muted">No items.</td></tr>
                        ) : items.map((line) => (
                            <tr key={`${line.productId}-${line.size || ""}-${line.color || ""}`}>
                                <th scope="row" {...hover(`Product: ${line.name}`)}>
                                    <span className="order-table__name">{line.name}</span>
                                    {options(line) ? <span className="order-table__meta">{options(line)}</span> : null}
                                    <span className="order-table__meta">{formatPrice(line.unitPrice)} each</span>
                                </th>
                                <td className="num" {...hover(`Quantity: ${line.quantity}`)}>{line.quantity}</td>
                                <td className="num" {...hover(`Total: ₹${line.lineTotal}`)}>{formatPrice(line.lineTotal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    )
}

export default OrderTable;
