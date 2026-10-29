import Product, { productTitleId } from "./products";
import FilterPane from "./filterpane";
import { Link } from "react-router-dom";
import "./container.css"
import { UserContext, SearchContext, VoiceFilterContext } from "../App";
import { CATEGORIES } from "../services/storeCategories";
import React, { useState, useContext, useEffect, useMemo, useRef } from "react";
import { addToCart, addToWishlist } from "../services/cartStore";
import { useProductListing, useWholeCatalog } from "../services/useCatalog";
import { catalogErrorMessage } from "../services/catalogService";
import CatalogErrorNotice from "./CatalogErrorNotice";
import { searchProducts, brandOf, categoryOf } from "../services/productMatching";
import { filterProducts } from "../services/shoppingCatalog";
import { announce } from "../services/announcer";
import { usePageTitle, useHoverSpeech } from "../services/uiHooks";

const STORE_CATEGORIES = CATEGORIES.map((c) => c.toLowerCase());
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Container(props){
    const hover = useHoverSpeech();
    const {user} = useContext(UserContext);
    const {valueToBeSearched, setValueToBeSearched} = useContext(SearchContext);
    const {voiceFilter} = useContext(VoiceFilterContext);

    const isSearchPage = props.name === "Search Results";
    const isShopAll = props.name === "Shop All";
    const category = props.name.toLowerCase();
    const [brand, setBrand] = useState(null);
    const [categoryFilter, setCategoryFilter] = useState(null);
    const headingRef = useRef(null);

    // Only apply a voice filter learned for THIS category; one learned elsewhere must not leak here.
    const activeVoiceFilter = voiceFilter && voiceFilter.category && voiceFilter.category.toLowerCase() === category ? voiceFilter : null;

    // The Brand chip reflects what Zoro picked, the same way a click would; a filter for another
    // page never touches this page's own brand selection.
    useEffect(() => {
        if (activeVoiceFilter) setBrand(activeVoiceFilter.brand || null);
    }, [activeVoiceFilter]);

    // Listings read one page at a time; only a text search reads the whole (shared, cached) catalog.
    const searching = Boolean(valueToBeSearched);
    const listing = useProductListing(isShopAll ? categoryFilter : category, { enabled: !searching && !isSearchPage });
    const catalog = useWholeCatalog(searching);
    const source = searching ? catalog : listing;
    const loadState = isSearchPage && !searching ? "ready" : source.status;

    // Only the four store categories are sold; anything else in the catalog is not listed.
    const searchable = useMemo(
        () => catalog.products.filter((p) => STORE_CATEGORIES.includes(categoryOf(p).toLowerCase())),
        [catalog.products]
    );
    const inCategory = listing.products;
    const brands = useMemo(() => [...new Set(inCategory.map(brandOf).filter(Boolean))].sort(), [inCategory]);

    const visible = useMemo(() => {
        if (searching) return searchProducts(valueToBeSearched, searchable);
        if (isSearchPage) return [];
        if (activeVoiceFilter) return filterProducts(inCategory, { ...activeVoiceFilter, category: props.name });
        return brand ? inCategory.filter((p) => brandOf(p) === brand) : inCategory;
    }, [searching, valueToBeSearched, isSearchPage, searchable, inCategory, brand, activeVoiceFilter, props.name]);
    const hasMore = !searching && !isSearchPage && listing.status === "ready" && !listing.done;

    // Announce how many results the search found (debounced so typing is not interrupted).
    useEffect(() => {
        if (!valueToBeSearched || loadState !== "ready") return undefined;
        const timer = setTimeout(() => {
            announce(`${visible.length} result${visible.length === 1 ? "" : "s"} for ${valueToBeSearched}.`);
        }, 1200);
        return () => clearTimeout(timer);
    }, [valueToBeSearched, visible.length, loadState]);

    async function handleAddToCart(product){
        try {
            await addToCart(product, user);
            const chosen = [product.size, product.color].filter((v) => typeof v === "string").join(", ");
            announce(`${product.name}${chosen ? `, ${chosen},` : ""} added to your cart.`);
            return true;
        } catch (e) {
            console.error("Add to cart failed:", e);
            announce(`Sorry, ${product.name} could not be added to your cart. Please try again.`);
            return false;
        }
    }

    async function handleAddToWishlist(product){
        try {
            const added = await addToWishlist(product, user);
            announce(added ? `${product.name} added to your wishlist.` : `${product.name} is already in your wishlist.`);
            return true;
        } catch (e) {
            console.error("Add to wishlist failed:", e);
            announce(`Sorry, ${product.name} could not be added to your wishlist.`);
            return false;
        }
    }

    function chooseBrand(next) {
        setBrand(next);
        announce(next ? `Showing ${next} products.` : `Showing all brands.`);
    }

    function chooseCategory(next) {
        setCategoryFilter(next);
        setBrand(null);
        announce(next ? `Showing ${next}.` : "Showing all categories.");
    }

    async function showMore() {
        const before = visible.length;
        let result;
        try {
            result = await listing.loadMore();
        } catch (e) {
            announce(catalogErrorMessage(e));
            return;
        }
        if (!result) return;
        const now = brand ? result.products.filter((p) => brandOf(p) === brand) : result.products;
        const added = now.length - before;
        if (added > 0) {
            announce(`${plural(added, "more product")} loaded. Showing ${now.length}.`);
            // Continue reading from the first new product: its name link.
            const first = now[before];
            setTimeout(() => {
                const heading = document.getElementById(productTitleId(first));
                const target = heading && (heading.querySelector("a[href]") || heading);
                if (target) target.focus();
            }, 0);
        } else {
            announce(result.done ? "There are no more products." : "No new products matched yet. You can show more.");
            if (result.done && headingRef.current) headingRef.current.focus();
        }
    }

    const brandLabel = brand ? `${brand[0].toUpperCase()}${brand.slice(1)}` : "";
    const title = valueToBeSearched ? `Results for “${valueToBeSearched}”`
        : isSearchPage ? "Search"
        : isShopAll ? "The collection"
        : props.name;
    const eyebrow = valueToBeSearched || isSearchPage ? "Search" : isShopAll ? "Shop all" : "Collection";
    usePageTitle(valueToBeSearched ? `Search: ${valueToBeSearched}` : isShopAll ? "Shop all" : props.name);

    let body;
    if (loadState === "loading") body = <p role="status" className="loading">Loading products…</p>;
    else if (loadState === "error") body = <CatalogErrorNotice error={source.error} onRetry={source.retry} />;
    else if (isSearchPage && !valueToBeSearched) body = (
        <div className="empty-state">
            <h2>What are you looking for?</h2>
            <p>Type in the search field at the top of the page, or press <kbd>Alt</kbd> + <kbd>V</kbd> and say “search for” followed by a product.</p>
            <ul className="suggestion-list">
                {CATEGORIES.map((c) => <li key={c}><Link to={`/categories/${c}`}>{c}</Link></li>)}
            </ul>
        </div>
    );
    else if (visible.length === 0 && !hasMore) body = (
        <div className="empty-state">
            <h2>No products found</h2>
            <p role="status">{valueToBeSearched ? `Nothing matches “${valueToBeSearched}”. Try a brand or a product name.` : "There is nothing in this selection yet."}</p>
            {valueToBeSearched ? <button type="button" className="btn btn-secondary" onClick={() => setValueToBeSearched("")}>Clear search</button> : null}
        </div>
    );
    else body = (
        <ul className="product-grid" aria-label={brand ? `${title}, ${brandLabel}` : title}>
            {visible.map((product) => (
                <li key={product.id || product.name}>
                    <Product
                        product={product}
                        addToCart={handleAddToCart}
                        addToWishlist={handleAddToWishlist}
                    />
                </li>
            ))}
        </ul>
    );

    const showFilters = loadState === "ready" && !valueToBeSearched && !isSearchPage;

    return (
        <div className="container listing">
            <header className="page-header listing__header">
                <nav aria-label="Breadcrumb" className="breadcrumb">
                    <ol>
                        <li><Link to="/">Home</Link></li>
                        <li><span aria-current="page">{isShopAll ? "Shop all" : isSearchPage ? "Search" : props.name}</span></li>
                    </ol>
                </nav>
                <p className="eyebrow">{eyebrow}</p>
                <h1 id="category-header" ref={headingRef} tabIndex={-1} className="page-title" {...hover(title)}>{title}</h1>
                {loadState === "ready" && (valueToBeSearched || !isSearchPage) ? (
                    <p className="page-subtitle">
                        {plural(visible.length, "piece")}{brand ? ` by ${brandLabel}` : ""}{hasMore ? " shown, more available" : ""}
                    </p>
                ) : null}
            </header>
            {showFilters ? (
                <FilterPane
                    // On "Shop all", brands appear once a category is chosen (otherwise the list is too long to scan).
                    brands={isShopAll && !categoryFilter ? [] : brands}
                    selectedBrand={brand}
                    filterBrand={chooseBrand}
                    categories={isShopAll ? STORE_CATEGORIES : null}
                    selectedCategory={categoryFilter}
                    filterCategory={chooseCategory}
                    brandNote={hasMore ? "Brands among the products shown so far. Show more products to see other brands." : null}
                />
            ) : null}
            {body}
            {hasMore ? (
                <div className="listing__more">
                    {listing.moreError ? <CatalogErrorNotice error={listing.moreError} /> : null}
                    <button type="button" className="btn btn-secondary btn-lg" onClick={showMore} disabled={listing.loadingMore} aria-busy={listing.loadingMore} {...hover("Show more products")}>
                        {listing.loadingMore ? "Loading more products…" : "Show more products"}
                    </button>
                </div>
            ) : null}
        </div>
      );
}

export default Container;
