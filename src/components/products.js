import React, { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import "./products.css";
import Icon from "./Icon";
import { productImages } from "../services/images";
import ProductImage from "./ProductImage";
import { setCurrentProduct } from "../services/voiceContext";
import { variantOptions, brandOf } from "../services/productMatching";
import { announce } from "../services/announcer";
import { useHoverSpeech, formatPrice } from "../services/uiHooks";

export const VARIANT_LABEL = { size: "Size", color: "Colour" };
/** Id of a product card's heading (its name link is the card's main focus target). */
export const productTitleId = (product) => `product-${String(product.id || product.name).replace(/\W+/g, "-")}-title`;
const MAX_THUMBS = 4;
const titleCase = (s) => (s ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : "");

/** A catalog rating only if it is a number from 0 to 5; anything else (e.g. 6) is treated as missing. */
export function ratingOf(product) {
    const r = Number(product && product.rating);
    return product && product.rating !== "" && product.rating !== null && Number.isFinite(r) && r >= 0 && r <= 5 ? r : null;
}

/** "Nike · Casual" from the catalog's category list (brand, then sub-category). */
export function productMeta(product) {
    const category = Array.isArray(product.category) ? product.category : [];
    return [titleCase(brandOf(product)), titleCase(category[1])].filter(Boolean).join(" · ");
}

/**
 * One product card. `product` is the real catalog record (with its Firestore id).
 * - addToCart / addToWishlist return true on success (the caller announces the result).
 * - compact: image, name, price and wishlist only (home page).
 * - onRemove: shows "Remove from wishlist" (wishlist page).
 */
function Product({ product, addToCart, addToWishlist, onRemove, compact = false, headingLevel = 2 }){
    const images = productImages(product);
    const thumbs = images.slice(0, MAX_THUMBS);
    const [current, setCurrent] = useState(0);
    const [selected, setSelected] = useState({});
    const [missing, setMissing] = useState(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [wished, setWished] = useState(false);
    const timer = useRef(null);
    const hover = useHoverSpeech();
    const idBase = `product-${String(product.id || product.name).replace(/\W+/g, "-")}`;
    const titleId = productTitleId(product);
    const options = variantOptions(product);
    const optionFields = Object.keys(options);
    const Heading = `h${headingLevel}`;
    const detailUrl = product.id ? `/product/${product.id}` : null;
    const meta = productMeta(product);
    const rating = ratingOf(product);

    useEffect(() => () => clearTimeout(timer.current), []);

    // Visual confirmation only; the result is announced by the page through announce().
    function flash(text) {
        setFeedback(text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFeedback(""), 2500);
    }

    async function onAddToCart() {
        if (busy) return;
        const miss = optionFields.find((f) => !selected[f]);
        if (miss) {
            setMissing(miss);
            announce(`Choose a ${VARIANT_LABEL[miss].toLowerCase()} for ${product.name} first.`);
            const select = document.getElementById(`${idBase}-${miss}`);
            if (select) select.focus();
            return;
        }
        setBusy(true);
        const ok = await addToCart({ ...product, ...selected });
        setBusy(false);
        if (ok) flash("Added to your cart");
    }

    async function onAddToWishlist() {
        if (busy) return;
        setBusy(true);
        const ok = await addToWishlist(product);
        setBusy(false);
        if (ok) {
            setWished(true);
            flash("Saved to your wishlist");
        }
    }

    const image = <ProductImage src={images[current] || images[0]} name={product.name} loading="lazy" productId={product.id} />;

    return(
        <article
            className={`product-card${compact ? " product-card--compact" : ""}`}
            aria-labelledby={titleId}
            // "Tell me about this product" refers to the card the user is on.
            onFocus={() => setCurrentProduct(product)}
            onMouseEnter={() => setCurrentProduct(product)}
        >
            <div className="product-card__media">
                {detailUrl
                    ? <Link to={detailUrl} className="product-card__image" tabIndex={-1} aria-hidden="true">{image}</Link>
                    : <div className="product-card__image">{image}</div>}
                {addToWishlist ? (
                    <button
                        type="button"
                        className={`product-card__wish${wished ? " is-saved" : ""}`}
                        aria-label={wished ? `${product.name} is in your wishlist` : `Add ${product.name} to wishlist`}
                        disabled={busy}
                        onClick={onAddToWishlist}
                        {...hover("Add to wishlist")}
                    >
                        <Icon name="heart" size={22} filled={wished} />
                    </button>
                ) : null}
                {thumbs.length > 1 ? (
                    <div className="product-card__thumbs" role="group" aria-label={`Images of ${product.name}`}>
                        {thumbs.map((src, i) => (
                            <button
                                key={`${src}-${i}`}
                                type="button"
                                className="product-card__thumb"
                                aria-label={`Show image ${i + 1} of ${thumbs.length}`}
                                aria-pressed={i === current}
                                onClick={() => setCurrent(i)}
                            >
                                <ProductImage src={src} className="" loading="lazy" compact productId={product.id} />
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>

            <div className="product-card__body">
                <div className="product-card__heading">
                    <Heading className="product-card__name" id={titleId}>
                        {detailUrl ? <Link to={detailUrl} {...hover(product.name)}>{product.name}</Link> : product.name}
                    </Heading>
                    <p className="product-card__price price" {...hover(`Price: ₹${product.price}`)}>{formatPrice(product.price)}</p>
                </div>
                {meta ? <p className="product-card__meta">{meta}</p> : null}
                {rating !== null ? <p className="product-card__rating">Rated {rating} out of 5</p> : null}

                {!compact && (addToCart || onRemove) ? (
                    <div className="product-card__actions">
                        {addToCart && optionFields.length ? (
                            <div className="product-card__options">
                                {optionFields.map((field) => {
                                    const selectId = `${idBase}-${field}`;
                                    const invalid = missing === field;
                                    return (
                                        <div className="field" key={field}>
                                            <label htmlFor={selectId}>{VARIANT_LABEL[field]}</label>
                                            <div className="select-wrap">
                                                <select
                                                    id={selectId}
                                                    className="select"
                                                    value={selected[field] || ""}
                                                    aria-invalid={invalid}
                                                    aria-describedby={invalid ? `${selectId}-error` : undefined}
                                                    onChange={(e) => {
                                                        const value = e.target.value || undefined;
                                                        setSelected((s) => ({ ...s, [field]: value }));
                                                        if (invalid && value) setMissing(null);
                                                    }}
                                                >
                                                    <option value="">Choose {VARIANT_LABEL[field].toLowerCase()}</option>
                                                    {options[field].map((o) => <option key={o} value={o}>{o}</option>)}
                                                </select>
                                            </div>
                                            {invalid ? <p id={`${selectId}-error`} className="form-error">Choose a {VARIANT_LABEL[field].toLowerCase()}.</p> : null}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                        {addToCart ? (
                            <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={onAddToCart} {...hover("Add to cart")}>
                                Add to cart<span className="visually-hidden">: {product.name}, ₹{product.price}</span>
                            </button>
                        ) : null}
                        {onRemove ? (
                            <button type="button" className="btn-quiet product-card__remove" onClick={() => onRemove(product)}>
                                Remove<span className="visually-hidden"> {product.name}</span> from wishlist
                            </button>
                        ) : null}
                    </div>
                ) : null}
                <p className="product-card__feedback" aria-hidden="true">
                    {feedback ? <><Icon name="check" size={16} /> {feedback}</> : null}
                </p>
            </div>
        </article>
    );
}

export default Product;
