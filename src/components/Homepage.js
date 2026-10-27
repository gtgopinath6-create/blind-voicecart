import React, { useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import "./Homepage.css";
import Categories from "./Categories";
import Product, { ratingOf } from "./products";
import Icon from "./Icon";
import { UserContext } from "../App";
import { CATEGORIES } from "../services/storeCategories";
import { VOICE_ACTIVATE_EVENT } from "./GlobalAIVoiceAssistant";
import { addToWishlist } from "../services/cartStore";
import { loadTopRated, loadCategoryCover, loadProductsNamed } from "../services/catalogService";
import { productImages } from "../services/images";
import CatalogErrorNotice from "./CatalogErrorNotice";
import { announce } from "../services/announcer";
import { usePageTitle, useHoverSpeech, formatPrice } from "../services/uiHooks";

// Real commands the assistant understands (see the README).
const EXAMPLES = ["Hey Zoro, I'm looking for shoes", "I need black sports shoes in size 9", "Add Nike Air Force 1 to my cart", "Read my cart"];
const FEATURED_COUNT = 4;
// Hero art: the catalog's only cut-out photo (transparent background), so it can sit on black.
// The caption links to the product only when it is in the live catalog.
const HERO_IMAGE = "/images/prod11.png";
const HERO_PRODUCT_NAME = "Nike Mercurial";
const byRating = (a, b) => (ratingOf(b) ?? -1) - (ratingOf(a) ?? -1) || String(a.name).localeCompare(String(b.name));

function Homepage(){
    const { user } = useContext(UserContext);
    const hover = useHoverSpeech();
    const [top, setTop] = useState([]);
    const [covers, setCovers] = useState({});
    const [heroProduct, setHeroProduct] = useState(null);
    const [loadState, setLoadState] = useState("loading");
    const [error, setError] = useState(null);
    const [attempt, setAttempt] = useState(0);
    usePageTitle("");

    // A few reads instead of the whole catalog: the top-rated products, one picture per category,
    // and the hero product's own record.
    useEffect(() => {
        let cancelled = false;
        setLoadState("loading");
        loadTopRated(FEATURED_COUNT)
            .then((list) => { if (!cancelled) { setTop(list); setLoadState("ready"); } })
            .catch((e) => { if (!cancelled) { setError(e); setLoadState("error"); } });
        // Pictures and the hero link are optional: without them the page still works.
        const hasImage = (p) => productImages(p).length > 0;
        Promise.all(CATEGORIES.map((name) => loadCategoryCover(name.toLowerCase(), { usable: hasImage }).catch(() => null)))
            .then((list) => { if (!cancelled) setCovers(Object.fromEntries(CATEGORIES.map((name, i) => [name, list[i]]))); });
        loadProductsNamed([HERO_PRODUCT_NAME])
            .then((list) => { if (!cancelled) setHeroProduct(list.find((p) => p.id) || null); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [attempt]);

    const categories = useMemo(() => CATEGORIES.map((name) => ({
        name,
        // undefined while the picture is looked up; null when the category has no usable image.
        image: covers[name] === undefined ? undefined : (covers[name] && productImages(covers[name])[0]) || null,
    })), [covers]);

    // Highest rated pieces from the catalog (real ratings only).
    const featured = useMemo(() => top.filter((p) => ratingOf(p) !== null).sort(byRating).slice(0, FEATURED_COUNT), [top]);

    async function handleAddToWishlist(product) {
        try {
            const added = await addToWishlist(product, user);
            announce(added ? `${product.name} added to your wishlist.` : `${product.name} is already in your wishlist.`);
            return true;
        } catch (e) {
            announce(`Sorry, ${product.name} could not be added to your wishlist.`);
            return false;
        }
    }

    return(
        <div className="home">
            <section className="hero" aria-labelledby="hero-title">
                <div className="container hero__inner">
                    <div className="hero__text">
                        <p className="eyebrow">Voice-first shopping</p>
                        <h1 id="hero-title" className="hero__title" {...hover("VoiceCart. Considered pieces, found by voice.")}>
                            Considered pieces, <em>found by voice.</em>
                        </h1>
                        <p className="hero__lede">Shoes, electronics, clothing and food in one calm store. Browse with your keyboard, your screen reader, or simply by asking.</p>
                        <div className="hero__actions">
                            <Link to="/shop" className="btn btn-gold btn-lg" {...hover("Shop the collection")}>Shop the collection</Link>
                            <a href="#categories" className="btn btn-secondary btn-lg" {...hover("Browse categories")}>Browse categories</a>
                        </div>
                        <p className="hero__hint"><kbd>Alt</kbd> + <kbd>V</kbd> starts Zoro, the voice assistant, on any page.</p>
                    </div>
                    <figure className="hero__media">
                        <div className="hero__stage" aria-hidden="true">
                            <img className="hero__image" src={HERO_IMAGE} alt="" width="447" height="559" />
                        </div>
                        {heroProduct ? (
                            <figcaption className="hero__caption">
                                <span className="hero__caption-label">In the collection</span>
                                <Link to={`/product/${heroProduct.id}`} className="hero__caption-link" {...hover(`${heroProduct.name}, ${formatPrice(heroProduct.price)}`)}>
                                    <span>{heroProduct.name}</span>
                                    <span className="price">{formatPrice(heroProduct.price)}</span>
                                    <Icon name="arrowRight" size={18} />
                                </Link>
                            </figcaption>
                        ) : null}
                    </figure>
                </div>
            </section>

            <section id="categories" className="section container" aria-labelledby="categories-title">
                <div className="section-header">
                    <div>
                        <p className="eyebrow">Categories</p>
                        <h2 id="categories-title">Shop by category</h2>
                    </div>
                </div>
                <ul className="category-grid">
                    {categories.map((c) => (
                        <li key={c.name}><Categories name={c.name} image={c.image} /></li>
                    ))}
                </ul>
            </section>

            <section className="voice-band band" aria-labelledby="voice-title">
                <div className="container voice-band__inner">
                    <div className="voice-band__intro">
                        <p className="eyebrow">Meet Zoro, your voice assistant</p>
                        <h2 id="voice-title">Simply say what you need.</h2>
                        <p className="voice-band__text">Zoro asks what you're looking for, reads out the real colours, sizes and prices, and checks every important answer with you. It listens only after you press the microphone or <kbd>Alt</kbd> + <kbd>V</kbd>, or when you switch on "Hey Zoro", and it always asks before placing an order.</p>
                        <button type="button" className="btn btn-primary btn-lg voice-band__cta" onClick={() => window.dispatchEvent(new CustomEvent(VOICE_ACTIVATE_EVENT))} {...hover("Talk to Zoro")}>
                            <Icon name="mic" size={20} /> Talk to Zoro
                        </button>
                    </div>
                    <div>
                        <h3 className="voice-band__list-title">Try saying</h3>
                        <ul className="voice-band__examples">
                            {EXAMPLES.map((e) => <li key={e}>“{e}”</li>)}
                        </ul>
                    </div>
                </div>
            </section>

            <section className="section container" aria-labelledby="featured-title">
                <div className="section-header">
                    <div>
                        <p className="eyebrow">From the catalog</p>
                        <h2 id="featured-title">Highest rated</h2>
                    </div>
                    <Link to="/shop" className="section-link">View the collection <Icon name="arrowRight" size={18} /></Link>
                </div>
                {loadState === "loading" ? <p role="status" className="loading">Loading products…</p> : null}
                {loadState === "error" ? <CatalogErrorNotice error={error} onRetry={() => setAttempt((n) => n + 1)} /> : null}
                {featured.length ? (
                    <ul className="product-grid product-grid--featured">
                        {featured.map((product) => (
                            <li key={product.id || product.name}>
                                <Product product={product} addToWishlist={handleAddToWishlist} compact headingLevel={3} />
                            </li>
                        ))}
                    </ul>
                ) : null}
            </section>
        </div>
    );
}

export default Homepage;
