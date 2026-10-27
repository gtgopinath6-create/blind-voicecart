import { Link } from "react-router-dom";
import "./container.css"
import "./products.css"
import {UserContext, SearchContext} from "../App";
import React, {useState, useContext, useEffect, useCallback} from "react";
import Product from "./products";
import Container from "./container";
import { getWishlist, saveWishlist, addToCart } from "../services/cartStore";
import { loadProductsNamed } from "../services/catalogService";
import { sameCartLine } from "./firebaseservices";
import { announce } from "../services/announcer";
import { usePageTitle, useHoverSpeech } from "../services/uiHooks";

/** The live catalog record for a saved entry (current price and options), or the entry itself. */
function liveProduct(entry, catalog) {
    return catalog.find((p) => entry.id && p.id === entry.id) || catalog.find((p) => p.name === entry.name) || entry;
}

function Wishlist(){
    const hover = useHoverSpeech();
    const {user, authReady} = useContext(UserContext);
    const {valueToBeSearched} = useContext(SearchContext);
    const [wishlist, setWishlistState] = useState([]);
    const [saved, setSaved] = useState([]);
    const [catalog, setCatalog] = useState([]);
    const [loadState, setLoadState] = useState("loading");
    const dirty = JSON.stringify(wishlist) !== JSON.stringify(saved);
    usePageTitle("Wishlist");

    const load = useCallback(async () => {
        try {
            const list = await getWishlist(user);
            setWishlistState(list);
            setSaved(list);
            setLoadState("ready");
        } catch (e) {
            console.error("Could not load wishlist:", e);
            setLoadState("error");
        }
    }, [user]);

    useEffect(() => {
        if (authReady) load();
    }, [authReady, load]);

    // Current prices and options for the saved products only (not the whole catalog).
    const savedNames = wishlist.map((entry) => entry.name).filter(Boolean).sort().join("\n");
    useEffect(() => {
        if (!savedNames) return undefined;
        let cancelled = false;
        loadProductsNamed(savedNames.split("\n")).then((list) => { if (!cancelled) setCatalog(list); }).catch(() => {});
        return () => { cancelled = true; };
    }, [savedNames]);

    async function moveToCart(product){
        try {
            await addToCart(product, user);
            const chosen = [product.size, product.color].filter((v) => typeof v === "string").join(", ");
            announce(`${product.name}${chosen ? `, ${chosen},` : ""} added to your cart.`);
            return true;
        } catch (e) {
            announce(`Sorry, ${product.name} could not be added to your cart.`);
            return false;
        }
    }

    function removeFromWishlist(entry){
        setWishlistState((list) => list.filter((item) => !sameCartLine(item, entry)));
        announce(`${entry.name} removed. Press Save Changes to keep this.`);
    }

    async function save(){
        try {
            await saveWishlist(user, wishlist);
            setSaved(wishlist);
            announce("Wishlist saved.");
        } catch (e) {
            announce("Sorry, your wishlist could not be saved. Please try again.");
        }
    }

    function undo(){
        setWishlistState(saved);
        announce("Changes undone.");
    }

    if (valueToBeSearched) return <Container name="Search Results" />;

    let body;
    if (loadState === "loading") body = <p role="status" className="loading">Loading your wishlist…</p>;
    else if (loadState === "error") body = <p role="alert" className="banner banner--error">Your wishlist could not be loaded. Please reload the page.</p>;
    else if (wishlist.length === 0) body = (
        <div className="empty-state">
            <h2>{dirty ? "Your wishlist will be empty" : "Your wishlist is empty"}</h2>
            <p>{dirty ? "Save your changes to keep this, or undo them." : "Press the heart on any product to save it here."}</p>
            {dirty ? null : <Link to="/shop" className="btn btn-primary">Shop the collection</Link>}
        </div>
    );
    else body = (
        <ul className="product-grid" aria-label="Wishlist items">
            {wishlist.map((entry) => (
                <li key={`${entry.id || entry.name}-${entry.size || ""}-${entry.color || ""}`}>
                    <Product
                        product={liveProduct(entry, catalog)}
                        addToCart={moveToCart}
                        onRemove={() => removeFromWishlist(entry)}
                    />
                </li>
            ))}
        </ul>
    );

    return (
        <div className="container listing wishlist-page">
            <header className="page-header">
                <p className="eyebrow">Saved for later</p>
                <h1 id="category-header" className="page-title" {...hover("Wishlist")}>Wishlist</h1>
                {loadState === "ready" ? <p className="page-subtitle">{wishlist.length} {wishlist.length === 1 ? "piece" : "pieces"}</p> : null}
            </header>
            {!user && authReady ? (
                <div className="banner banner--info wishlist-page__guest"><p>This wishlist is saved on this device only. <Link to="/sign">Sign in</Link> to keep it with your account.</p></div>
            ) : null}
            {body}
            {dirty ? (
                <div className="save-bar">
                    <p><strong>You have unsaved changes.</strong></p>
                    <div className="cart-actions__buttons">
                        <button type="button" className="btn btn-primary" onClick={save} {...hover("Save changes")}>Save changes</button>
                        <button type="button" className="btn btn-secondary" onClick={undo} {...hover("Undo changes")}>Undo</button>
                    </div>
                </div>
            ) : null}
        </div>
      );
}

export default Wishlist;
