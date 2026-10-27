import React, { useState, useContext, useEffect } from 'react';
import { Link } from "react-router-dom";
import { UserContext } from '../App';
import {readData} from "./firebaseservices";
import Icon from "./Icon";
import { formatPrice, usePageTitle, useHoverSpeech } from "../services/uiHooks";
import "./account.css";

const MAX_HISTORY = 20;

/** purchaseHistory entries are { orderId, name, price, quantity, purchaseDate: [day, month, year] }. */
function purchaseDate(entry) {
    const d = entry && entry.purchaseDate;
    if (Array.isArray(d) && d.length === 3) return `${d[0]}/${d[1]}/${d[2]}`;
    return typeof d === "string" ? d : "—";
}

function Account() {
    const {user, authReady, isAdmin} = useContext(UserContext);
    const hover = useHoverSpeech();
    const [currUser, setCurrUser] = useState(null);
    const [error, setError] = useState("");
    usePageTitle("Your account");

    useEffect(() => {
        if (!user) return undefined;
        let cancelled = false;
        readData("users", "", user)
            .then((profile) => { if (!cancelled) setCurrUser(profile); })
            .catch(() => { if (!cancelled) setError("Your account details could not be loaded. Please reload the page."); });
        return () => { cancelled = true; };
    }, [user]);

    if (!authReady) return <div className="container"><p role="status" className="loading">Loading your account…</p></div>;
    if (!user) {
        return (
            <div className="container">
                <div className="empty-state">
                    <h1>Your account</h1>
                    <p>You are not signed in. <Link to="/sign">Sign in or create an account</Link> to see your details.</p>
                </div>
            </div>
        );
    }
    if (error) return <div className="container"><p role="alert" className="banner banner--error account__error">{error}</p></div>;
    if (!currUser) return <div className="container"><p role="status" className="loading">Loading your account…</p></div>;

    const history = Array.isArray(currUser.purchaseHistory) ? [...currUser.purchaseHistory].reverse().slice(0, MAX_HISTORY) : [];
    const wallet = Number(currUser.wallet) || 0;

    return(
        <div className="container account">
            <header className="page-header">
                <p className="eyebrow">Your account</p>
                <h1 className="page-title" {...hover("Account details")}>Account details</h1>
            </header>

            <div className="account__grid">
                <section className="panel" aria-labelledby="profile-title">
                    <h2 id="profile-title" className="panel__title">Profile</h2>
                    <dl className="account__details">
                        <div {...hover(`Name: ${currUser.name}`)}><dt>Name</dt><dd>{currUser.name}</dd></div>
                        <div {...hover(`Email: ${currUser.email}`)}><dt>Email</dt><dd>{currUser.email}</dd></div>
                    </dl>
                </section>
                <section className="panel" aria-labelledby="wallet-title">
                    <h2 id="wallet-title" className="panel__title">Wallet</h2>
                    <p className="account__balance price" {...hover(`E-Wallet balance: ₹${wallet}`)}>{formatPrice(wallet)}</p>
                    <p className="muted small">Your balance is used to pay at checkout.</p>
                </section>
                <section className="panel" aria-labelledby="shortcuts-title">
                    <h2 id="shortcuts-title" className="panel__title">Shortcuts</h2>
                    <ul className="account__links">
                        <li><Link to="/cart"><Icon name="bag" size={18} /> Cart</Link></li>
                        <li><Link to="/wishlist"><Icon name="heart" size={18} /> Wishlist</Link></li>
                        {isAdmin ? <li><Link to="/admin"><Icon name="grid" size={18} /> Administration</Link></li> : null}
                    </ul>
                </section>
            </div>

            <section className="section--tight" aria-labelledby="history-title">
                <h2 id="history-title" className="account__history-title">Purchase history</h2>
                {history.length ? (
                    <div className="table-scroll">
                        <table className="data-table">
                            <caption className="visually-hidden">Your most recent purchases, newest first</caption>
                            <thead>
                                <tr>
                                    <th scope="col">Product</th>
                                    <th scope="col">Date</th>
                                    <th scope="col" className="num">Qty</th>
                                    <th scope="col" className="num">Price</th>
                                </tr>
                            </thead>
                            <tbody>
                                {history.map((entry, i) => (
                                    <tr key={`${entry.orderId || "legacy"}-${i}`}>
                                        <th scope="row">{entry.name || "Item"}</th>
                                        <td>{purchaseDate(entry)}</td>
                                        <td className="num">{entry.quantity ?? "—"}</td>
                                        <td className="num">{entry.price !== undefined ? formatPrice(entry.price) : "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="muted">No purchases yet.</p>
                )}
            </section>
        </div>
    )
}
export default Account
