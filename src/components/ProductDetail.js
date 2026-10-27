import React, { useContext, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import "./ProductDetail.css";
import Icon from "./Icon";
import { UserContext } from "../App";
import { getProduct } from "../services/catalogService";
import CatalogErrorNotice from "./CatalogErrorNotice";
import { addToCart, addToWishlist } from "../services/cartStore";
import { productImages } from "../services/images";
import ProductImage from "./ProductImage";
import { setCurrentProduct } from "../services/voiceContext";
import { variantOptions, categoryOf } from "../services/productMatching";
import { announce } from "../services/announcer";
import { formatPrice, usePageTitle, useHoverSpeech } from "../services/uiHooks";
import { VARIANT_LABEL, productMeta, ratingOf } from "./products";

const MAX_QUANTITY = 20;
const titleCase = (s) => (s ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : "");

/** Product page: gallery, verified catalog price, options, quantity, add to cart and wishlist. */
export default function ProductDetail() {
    const { productId } = useParams();
    const { user } = useContext(UserContext);
    const hover = useHoverSpeech();
    const [state, setState] = useState({ status: "loading", product: null, error: null });
    const [attempt, setAttempt] = useState(0);
    const [current, setCurrent] = useState(0);
    const [selected, setSelected] = useState({});
    const [missing, setMissing] = useState([]);
    const [quantity, setQuantity] = useState(1);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setState({ status: "loading", product: null, error: null });
        setCurrent(0);
        setSelected({});
        setMissing([]);
        setQuantity(1);
        setMessage(null);
        // One product (and its stored copies), read fresh: its current price and options.
        getProduct(productId)
            .then((product) => {
                if (cancelled) return;
                setState({ status: product ? "ready" : "missing", product, error: null });
                // "Tell me about this product" now refers to this page's product.
                if (product) setCurrentProduct(product);
            })
            .catch((error) => { if (!cancelled) setState({ status: "error", product: null, error }); });
        return () => { cancelled = true; };
    }, [productId, attempt]);

    const product = state.product;
    usePageTitle(product ? product.name : "Product");

    if (state.status === "loading") {
        return <div className="container"><p role="status" className="loading">Loading product…</p></div>;
    }
    if (!product) {
        return (
            <div className="container">
                <div className="empty-state">
                    <h1>{state.status === "error" ? "The product could not be loaded" : "This product could not be found"}</h1>
                    {state.status === "error"
                        ? <CatalogErrorNotice error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
                        : <p>It may have been removed from the catalog.</p>}
                    <Link to="/shop" className="btn btn-primary">Browse the collection</Link>
                </div>
            </div>
        );
    }

    const images = productImages(product);
    const options = variantOptions(product);
    const optionFields = Object.keys(options);
    const idBase = `pd-${String(product.id).replace(/\W+/g, "-")}`;
    const category = titleCase(categoryOf(product));
    const rating = ratingOf(product);
    const hasStock = typeof product.stock === "number";

    function changeQuantity(next) {
        const value = Math.max(1, Math.min(MAX_QUANTITY, Number(next) || 1));
        setQuantity(value);
    }

    async function onAddToCart(event) {
        event.preventDefault();
        if (busy) return;
        const miss = optionFields.filter((f) => !selected[f]);
        setMissing(miss);
        if (miss.length) {
            const text = `Choose a ${miss.map((f) => VARIANT_LABEL[f].toLowerCase()).join(" and a ")} first.`;
            setMessage({ tone: "error", text });
            announce(`${text} Nothing was added.`);
            const first = document.querySelector(`input[name="${idBase}-${miss[0]}"]`);
            if (first) first.focus();
            return;
        }
        setBusy(true);
        try {
            await addToCart({ ...product, ...selected }, user, quantity);
            const chosen = optionFields.map((f) => selected[f]).join(", ");
            const text = `${quantity} × ${product.name}${chosen ? ` (${chosen})` : ""} added to your cart.`;
            setMessage({ tone: "success", text });
            announce(text);
        } catch (e) {
            const text = `Sorry, ${product.name} could not be added to your cart. Please try again.`;
            setMessage({ tone: "error", text });
            announce(text);
        } finally {
            setBusy(false);
        }
    }

    async function onAddToWishlist() {
        if (busy) return;
        setBusy(true);
        try {
            const added = await addToWishlist(product, user);
            const text = added ? `${product.name} saved to your wishlist.` : `${product.name} is already in your wishlist.`;
            setMessage({ tone: "success", text });
            announce(text);
        } catch (e) {
            const text = `Sorry, ${product.name} could not be saved to your wishlist.`;
            setMessage({ tone: "error", text });
            announce(text);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="container product-detail">
            <nav aria-label="Breadcrumb" className="breadcrumb">
                <ol>
                    <li><Link to="/">Home</Link></li>
                    {category ? <li><Link to={`/categories/${category}`}>{category}</Link></li> : null}
                    <li><span aria-current="page">{product.name}</span></li>
                </ol>
            </nav>

            <div className="product-detail__layout">
                <section className="product-detail__gallery" aria-label="Product images">
                    <div className="product-detail__stage">
                        <ProductImage
                            src={images[current]}
                            name={product.name}
                            alt={images.length > 1 ? `${product.name}, view ${current + 1} of ${images.length}` : product.name}
                            productId={product.id}
                        />
                    </div>
                    {images.length > 1 ? (
                        <div className="product-detail__thumbs" role="group" aria-label={`Images of ${product.name}`}>
                            {images.map((src, i) => (
                                <button
                                    key={`${src}-${i}`}
                                    type="button"
                                    className="product-detail__thumb"
                                    aria-label={`Show image ${i + 1} of ${images.length}`}
                                    aria-pressed={i === current}
                                    onClick={() => setCurrent(i)}
                                >
                                    <ProductImage src={src} compact productId={product.id} />
                                </button>
                            ))}
                        </div>
                    ) : null}
                </section>

                <div className="product-detail__info">
                    {productMeta(product) ? <p className="eyebrow">{productMeta(product)}</p> : null}
                    <h1 className="product-detail__title" {...hover(product.name)}>{product.name}</h1>
                    <p className="product-detail__price price" {...hover(`Price: ₹${product.price}`)}>{formatPrice(product.price)}</p>
                    <p className="muted small">Before 18% tax. The final total is confirmed by the server at checkout.</p>
                    {rating !== null || hasStock ? (
                        <ul className="product-detail__facts">
                            {rating !== null ? <li>Rated {rating} out of 5</li> : null}
                            {hasStock ? <li>{product.stock > 0 ? (product.stock <= 5 ? `Only ${product.stock} left` : "In stock") : "Out of stock"}</li> : null}
                        </ul>
                    ) : null}

                    {product.description ? (
                        <div className="product-detail__description">
                            <h2 className="product-detail__subhead">Description</h2>
                            <p {...hover(product.description)}>{product.description}</p>
                        </div>
                    ) : null}

                    <form className="product-detail__form" onSubmit={onAddToCart} noValidate>
                        {optionFields.map((field) => {
                            const errorId = `${idBase}-${field}-error`;
                            const isMissing = missing.includes(field);
                            return (
                                <fieldset key={field} className="option-group" aria-describedby={isMissing ? errorId : undefined}>
                                    <legend className="option-group__legend">
                                        {VARIANT_LABEL[field]}
                                        {selected[field] ? <span className="muted">: {selected[field]}</span> : null}
                                    </legend>
                                    <div className="option-chips">
                                        {options[field].map((value) => (
                                            <label key={value} className="option-chip">
                                                <input
                                                    type="radio"
                                                    name={`${idBase}-${field}`}
                                                    value={value}
                                                    checked={selected[field] === value}
                                                    onChange={() => {
                                                        setSelected((s) => ({ ...s, [field]: value }));
                                                        setMissing((m) => m.filter((f) => f !== field));
                                                    }}
                                                />
                                                <span>{value}</span>
                                            </label>
                                        ))}
                                    </div>
                                    {isMissing ? <p id={errorId} className="form-error">Choose a {VARIANT_LABEL[field].toLowerCase()}.</p> : null}
                                </fieldset>
                            );
                        })}

                        <div className="quantity-field">
                            <label htmlFor={`${idBase}-qty`} className="field-label">Quantity</label>
                            <div className="qty-stepper">
                                <button type="button" className="qty-stepper__btn" aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => changeQuantity(quantity - 1)}>
                                    <Icon name="minus" size={18} />
                                </button>
                                <input
                                    id={`${idBase}-qty`}
                                    className="qty-stepper__input"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={MAX_QUANTITY}
                                    value={quantity}
                                    onChange={(e) => changeQuantity(e.target.value)}
                                />
                                <button type="button" className="qty-stepper__btn" aria-label="Increase quantity" disabled={quantity >= MAX_QUANTITY} onClick={() => changeQuantity(quantity + 1)}>
                                    <Icon name="plus" size={18} />
                                </button>
                            </div>
                        </div>

                        <div className="product-detail__buttons">
                            <button type="submit" className="btn btn-gold btn-lg" disabled={busy} {...hover("Add to cart")}>
                                {busy ? "Adding…" : "Add to cart"}
                            </button>
                            <button type="button" className="btn btn-secondary btn-lg" disabled={busy} onClick={onAddToWishlist} {...hover("Save to wishlist")}>
                                <Icon name="heart" size={18} /> Save to wishlist
                            </button>
                        </div>

                        {message ? (
                            <p className={message.tone === "error" ? "form-error" : "form-success product-detail__added"}>
                                {message.tone === "success" ? <Icon name="check" size={18} /> : null}
                                <span>{message.text} {message.tone === "success" ? <Link to="/cart">View cart</Link> : null}</span>
                            </p>
                        ) : null}
                    </form>
                </div>
            </div>
        </div>
    );
}
