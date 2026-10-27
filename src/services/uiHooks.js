// Small UI hooks shared by the redesigned pages.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { TTSContext, UserContext } from "../App";
import { readData } from "../components/firebaseservices";
import { readGuestCart, readGuestWishlist } from "./cartStore";
import { speakText, stopHoverSpeech } from "./announcer";

/**
 * Props that read `text` aloud on mouse hover when the built-in screen reader is on, in the same
 * voice and speed as everything else. Hovering never cuts off Zoro, a status message or the
 * reading of a focused control; moving the mouse away stops only hover reading.
 */
export function useHoverSpeech() {
    const { screenReader } = useContext(TTSContext);
    return useCallback((text) => ({
        onMouseEnter: () => {
            if (screenReader) speakText(text, { kind: "hover" });
        },
        onMouseLeave: () => stopHoverSpeech(),
    }), [screenReader]);
}

/** Sets the browser tab title, so screen readers announce where the user is. */
export function usePageTitle(title) {
    useEffect(() => {
        document.title = title ? `${title} — VoiceCart` : "VoiceCart — Accessible Voice Shopping";
    }, [title]);
}

/** Item counts for the header: cart (sum of quantities) and wishlist (entries). */
export function useBagCounts() {
    const { user, authReady } = useContext(UserContext);
    const [counts, setCounts] = useState({ cart: 0, wishlist: 0 });
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    const load = useCallback(async () => {
        if (!authReady) return;
        try {
            let cart;
            let wishlist;
            if (user) {
                const profile = await readData("users", "", user);
                cart = (profile && profile.cart) || [];
                wishlist = (profile && profile.wishlist) || [];
            } else {
                cart = readGuestCart();
                wishlist = readGuestWishlist();
            }
            const items = cart.reduce((n, line) => n + (Number(line.quantity) || 0), 0);
            if (mounted.current) setCounts({ cart: items, wishlist: wishlist.length });
        } catch (e) {
            // Counts are a convenience; keep the previous values if the profile cannot be read.
        }
    }, [user, authReady]);

    useEffect(() => {
        load();
        window.addEventListener("CART_UPDATED", load);
        window.addEventListener("WISHLIST_UPDATED", load);
        return () => {
            window.removeEventListener("CART_UPDATED", load);
            window.removeEventListener("WISHLIST_UPDATED", load);
        };
    }, [load]);

    return counts;
}

/** Indian rupee price with digit grouping, e.g. ₹10,620 or ₹49.50. */
export function formatPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
