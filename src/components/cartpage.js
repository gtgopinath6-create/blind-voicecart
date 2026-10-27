import React, {useState, useContext, useEffect, useCallback} from "react";
import { Link, useNavigate } from 'react-router-dom'
import CartItem from "./cartitem";
import OrderSummary from "./ordersummary";
import "./cartpage.css"
import {UserContext} from "../App";
import { getCart, saveCart, estimateTotal } from "../services/cartStore";
import { sameCartLine } from "./firebaseservices";
import { announce } from "../services/announcer";
import { usePageTitle, useHoverSpeech } from "../services/uiHooks";

const MAX_QUANTITY = 20;

function CartPage(){
    const {user, authReady} = useContext(UserContext);
    const hover = useHoverSpeech();
    const [currentCart, updateCurrentCart] = useState([]);
    const [backupCart, setBackupCart] = useState([]);
    const [loadState, setLoadState] = useState("loading");
    const [saving, setSaving] = useState(false);
    const navigate = useNavigate();
    const dirty = JSON.stringify(currentCart) !== JSON.stringify(backupCart);
    const itemCount = currentCart.reduce((n, line) => n + (Number(line.quantity) || 0), 0);
    usePageTitle("Your cart");

    const load = useCallback(async () => {
        try {
            const cart = await getCart(user);
            updateCurrentCart(cart);
            setBackupCart(cart);
            setLoadState("ready");
        } catch (e) {
            console.error("Could not load cart:", e);
            setLoadState("error");
        }
    }, [user]);

    useEffect(() => {
        if (authReady) load();
    }, [authReady, load]);

    // Reload when the voice assistant changes the cart while this page is open.
    useEffect(() => {
        const onCartUpdated = () => load();
        window.addEventListener("CART_UPDATED", onCartUpdated);
        return () => window.removeEventListener("CART_UPDATED", onCartUpdated);
    }, [load]);

    function onCartUpdate(line, newValue) {
        const quantity = Math.min(MAX_QUANTITY, newValue);
        if (newValue > MAX_QUANTITY) announce(`The maximum is ${MAX_QUANTITY} of each item.`);
        updateCurrentCart((cart) => quantity <= 0
            ? cart.filter((item) => !sameCartLine(item, line))
            : cart.map((item) => (sameCartLine(item, line) ? { ...item, quantity } : item)));
        announce(quantity <= 0 ? `${line.name} removed. Remember to save your changes.` : `${line.name} quantity ${quantity}.`);
    }

    function clearCart(){
        updateCurrentCart([]);
        announce("Cart cleared. Press Save Changes to keep this, or Undo Changes to restore it.");
    }

    function undoChanges(){
        updateCurrentCart(backupCart);
        announce("Changes undone.");
    }

    async function persist() {
        setSaving(true);
        try {
            await saveCart(user, currentCart);
            setBackupCart(currentCart);
            return true;
        } catch (e) {
            console.error("Could not save cart:", e);
            announce("Sorry, your cart could not be saved. Please try again.");
            return false;
        } finally {
            setSaving(false);
        }
    }

    async function saveChanges(){
        if (await persist()) announce("Cart saved.");
    }

    async function toBilling(){
        if (currentCart.length === 0) {
            announce("Your cart is empty.");
            return;
        }
        if (dirty && !(await persist())) return;
        navigate('/billing');
    }

    let body;
    if (loadState === "loading") body = <p role="status" className="loading">Loading your cart…</p>;
    else if (loadState === "error") body = <p role="alert" className="banner banner--error">Your cart could not be loaded. Please reload the page.</p>;
    else if (currentCart.length) body = (
        <ul className="cart-list" aria-label="Cart items">
            {currentCart.map((item) => (
                <li key={`${item.id || item.name}-${item.size || ""}-${item.color || ""}`}>
                    <CartItem item={item} onCartUpdate={onCartUpdate} />
                </li>
            ))}
        </ul>
    );
    else body = (
        <div className="empty-state">
            <h2>{dirty ? "Your cart will be empty" : "Your cart is empty"}</h2>
            <p>{dirty ? "Save your changes to empty the cart, or undo them to bring the items back." : "Pieces you add will wait for you here."}</p>
            {dirty ? null : <Link to="/shop" className="btn btn-primary">Shop the collection</Link>}
        </div>
    );

    const showSummary = loadState === "ready" && (currentCart.length > 0 || dirty);

    return (
        <div className="container cart-page">
            <header className="page-header">
                <p className="eyebrow">Your selection</p>
                <h1 className="page-title" {...hover("Your cart. The items are listed first, then the order summary.")}>Your cart</h1>
                {loadState === "ready" ? <p className="page-subtitle">{itemCount} {itemCount === 1 ? "item" : "items"}</p> : null}
            </header>
            {!user && authReady ? (
                <div className="banner banner--info cart-page__guest"><p>You are shopping as a guest. <Link to="/sign">Sign in</Link> before checkout and your cart will be kept.</p></div>
            ) : null}
            <div className={`cart-layout${showSummary ? "" : " cart-layout--single"}`}>
                <section className="cart-lines" aria-labelledby="cart-items-heading">
                    <h2 id="cart-items-heading" className="visually-hidden">Items</h2>
                    {body}
                    {loadState === "ready" && (currentCart.length > 0 || dirty) ? (
                        <div className="cart-actions">
                            {dirty ? <p className="cart-actions__note">You have unsaved changes.</p> : null}
                            <div className="cart-actions__buttons">
                                <button type="button" className="btn btn-primary" onClick={saveChanges} disabled={!dirty || saving} {...hover("Save changes")}>{saving ? "Saving…" : "Save changes"}</button>
                                <button type="button" className="btn btn-secondary" onClick={undoChanges} disabled={!dirty} {...hover("Undo changes")}>Undo changes</button>
                                <button type="button" className="btn btn-danger" onClick={clearCart} disabled={currentCart.length === 0} {...hover("Clear cart")}>Clear cart</button>
                            </div>
                        </div>
                    ) : null}
                </section>
                {showSummary ? (
                    <OrderSummary subtotal={estimateTotal(currentCart)} canProceed={currentCart.length > 0 && !saving} toBilling={toBilling}></OrderSummary>
                ) : null}
            </div>
        </div>
    )
}

export default CartPage;
