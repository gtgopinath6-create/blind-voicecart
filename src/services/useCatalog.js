// React hooks over the shared catalog service. Results that arrive after the screen changed are dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { createListing, loadCatalog } from "./catalogService";

const LOADING = { status: "loading", products: [], done: false, error: null, loadingMore: false, moreError: null };

/**
 * A paged listing of one category (null: every store category).
 * { status: "loading" | "ready" | "error", products, done, error, loadingMore, moreError, loadMore(), retry() }
 * loadMore() resolves to { products, done } and rejects with a CatalogError; the products already
 * shown stay on screen when it fails.
 */
export function useProductListing(category, { enabled = true } = {}) {
    const [state, setState] = useState(LOADING);
    const [attempt, setAttempt] = useState(0);
    const listingRef = useRef(null);

    useEffect(() => {
        if (!enabled) return undefined;
        const listing = createListing({ category });
        listingRef.current = listing;
        setState(LOADING);
        listing.more().then(
            ({ products, done }) => {
                if (listingRef.current === listing) setState({ ...LOADING, status: "ready", products, done });
            },
            (error) => {
                if (listingRef.current === listing) setState({ ...LOADING, status: "error", error });
            }
        );
        return () => {
            if (listingRef.current === listing) listingRef.current = null;
        };
    }, [category, enabled, attempt]);

    const loadMore = useCallback(async () => {
        const listing = listingRef.current;
        if (!listing) return null;
        setState((s) => ({ ...s, loadingMore: true, moreError: null }));
        try {
            const result = await listing.more();
            if (listingRef.current === listing) setState({ ...LOADING, status: "ready", products: result.products, done: result.done });
            return result;
        } catch (error) {
            if (listingRef.current === listing) setState((s) => ({ ...s, loadingMore: false, moreError: error }));
            throw error;
        }
    }, []);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { ...state, loadMore, retry };
}

/** Every product (copies merged), loaded only while `enabled`: { status, products, error, retry() }. */
export function useWholeCatalog(enabled) {
    const [state, setState] = useState(LOADING);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        setState((s) => (s.status === "ready" ? s : LOADING));
        loadCatalog().then(
            (products) => { if (!cancelled) setState({ ...LOADING, status: "ready", products, done: true }); },
            (error) => { if (!cancelled) setState({ ...LOADING, status: "error", error }); }
        );
        return () => { cancelled = true; };
    }, [enabled, attempt]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { ...state, retry };
}
