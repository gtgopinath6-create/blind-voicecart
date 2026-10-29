import React, { useCallback, useEffect, useRef, useState } from "react";
import Homepage from "./components/Homepage";
import SignIn from "./components/Sign";
import AccountPage from "./components/AccountPage"
import { Route, Routes, BrowserRouter, useLocation } from "react-router-dom";
import ProductPage from "./components/productpage";
import ProductDetail from "./components/ProductDetail";
import CartPage from "./components/cartpage";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { AdminRoute } from "./components/PrivateRoute";
import Wishlist from "./components/wishlist";
import BillingPage from "./components/billingpage";
import AdminPanel from "./components/AdminPanel";
import Navbar from "./components/navbar";
import SiteFooter from "./components/SiteFooter";
import GlobalAIVoiceAssistant, { VOICE_STATE_EVENT } from "./components/GlobalAIVoiceAssistant";
import LiveAnnouncer from "./components/LiveAnnouncer";
import { ensureUserProfile } from "./components/firebaseservices";
import { mergeGuestCartInto } from "./services/cartStore";
import { setCustomSpeechEnabled, speakText, announce, watchVoices } from "./services/announcer";
import { CATEGORIES } from "./services/storeCategories";

export const UserContext = React.createContext({
  user: null,
  setUser: () => {},
  isAdmin: false,
  authReady: false,
});

export const OrderContext = React.createContext({
  orderTotal: 0,
  setOrderTotal: () => {},
});

export const SearchContext = React.createContext({
  valueToBeSearched: "",
  setValueToBeSearched: () => {},
})

// What Zoro's shopping conversation has learned so far (category/type/brand/colour/size/budget),
// so a category page can narrow its listing to match as the conversation progresses, the same way
// SearchContext lets typed search override it. null means no voice filter is active.
export const VoiceFilterContext = React.createContext({
  voiceFilter: null,
  setVoiceFilter: () => {},
})

export const TTSContext = React.createContext({})

// Noir Prestige is the default theme and "ivory" the light alternative. The switch in the header
// and the voice command "toggle contrast" / "dark mode" both change it.
export const ThemeContext = React.createContext({ theme: "noir", chooseTheme: () => {} })

const THEME_KEY = "vc-theme";
const THEMES = ["noir", "ivory"];

/**
 * A saved choice, else Noir. Earlier versions wrote "light" or "dark" on every visit rather than
 * when someone chose a theme, so those values are not treated as a choice.
 */
function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch (e) { /* storage unavailable */ }
  return "noir";
}

/** Short accessible name of a focused element, for the custom screen reader. */
function accessibleName(el) {
  const label = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute("alt") || el.getAttribute("title");
  const text = label || (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.getAttribute("placeholder") : el.textContent);
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 150);
}

// Pages with their own focused layout (no store header or footer).
const BARE_ROUTES = ["/sign", "/admin"];

/**
 * After navigation: scroll to the top and move focus to the new page's heading, so keyboard and
 * screen-reader users start at the new content. Skipped while typing in search (live results)
 * and while the voice assistant is busy (it announces the change itself).
 */
function RouteFocus() {
  const { pathname } = useLocation();
  const first = useRef(true);
  const voiceBusy = useRef(false);

  useEffect(() => {
    const onVoice = (e) => { voiceBusy.current = Boolean(e.detail && e.detail.status && e.detail.status !== "IDLE" && e.detail.status !== "WAKE_WORD_LISTENING"); };
    window.addEventListener(VOICE_STATE_EVENT, onVoice);
    return () => window.removeEventListener(VOICE_STATE_EVENT, onVoice);
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.scrollTo(0, 0);
    const active = document.activeElement;
    if (voiceBusy.current || (active && active.closest && active.closest('[role="search"]'))) return;
    const timer = setTimeout(() => {
      const main = document.getElementById("main-content");
      if (!main) return;
      const heading = main.querySelector("h1");
      const target = heading || main;
      if (heading && !heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname]);
  return null;
}

function SiteFrame() {
  const { pathname } = useLocation();
  const bare = BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return (
    <>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {bare ? null : <Navbar />}
      <main id="main-content" tabIndex={-1} className="page-body">
        <Routes>
          <Route path="/" element={<Homepage />} />
          <Route path="/sign" element={<SignIn></SignIn>} />
          <Route path="shop" element={<ProductPage key="shop" name="Shop All" />} />
          {CATEGORIES.map((name) => (
            // A key per category so switching categories remounts the page with the right products.
            <Route key={name} path={`categories/${name}`} element={<ProductPage key={name} name={name} />} />
          ))}
          <Route path = "categories/Search" element = {<ProductPage key="search" name = "Search Results" />} />
          <Route path="product/:productId" element={<ProductDetail />} />
          <Route path="cart" element={<CartPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path = "wishlist" element = {<Wishlist />} />
          <Route path = "billing" element = {<BillingPage />} />
          <Route path = "admin" element = {<AdminRoute><AdminPanel /></AdminRoute>} />
        </Routes>
      </main>
      {bare ? null : <SiteFooter />}
      <RouteFocus />
      <GlobalAIVoiceAssistant />
      <LiveAnnouncer />
    </>
  );
}

function MainPage() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [orderTotal, setOrderTotal] = useState(0);
  const [valueToBeSearched, setValueToBeSearched] = useState("");
  const [voiceFilter, setVoiceFilter] = useState(null);
  const [screenReader, changeScreenReader] = useState(true);
  const [theme, setTheme] = useState(initialTheme);

  // Theme tokens switch on <html data-theme>.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Saved only when someone chooses a theme, so Noir stays the default for everyone else.
  const chooseTheme = useCallback((next) => {
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* not saved */ }
  }, []);

  // Custom speech follows the "Screen Reader" toggle everywhere.
  useEffect(() => {
    setCustomSpeechEnabled(screenReader);
  }, [screenReader]);

  // Installed voices arrive asynchronously; track them so every message uses the same voice.
  useEffect(() => {
    watchVoices();
  }, []);

  // One "bottom of page" announcement for the whole app.
  useEffect(() => {
    let announced = false;
    const handleScroll = () => {
      const atBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 2;
      if (atBottom && !announced) {
        announced = true;
        if (screenReader) speakText("You have reached the bottom of the page");
      } else if (!atBottom) {
        announced = false;
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [screenReader]);

  // Keyboard users hear the control they move to (mouse users already get hover speech).
  useEffect(() => {
    if (!screenReader) return undefined;
    const onFocus = (event) => {
      if (!event.target || !event.target.getAttribute) return;
      const name = accessibleName(event.target);
      if (name) speakText(name, { kind: "focus" });
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [screenReader]);

  useEffect(() => {
    const auth = getAuth();
    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setIsAdmin(false);
        setAuthReady(true);
        return;
      }
      try {
        // Every sign-in method (email or Google) gets a profile; existing ones are kept.
        await ensureUserProfile(firebaseUser);
        if (await mergeGuestCartInto(firebaseUser)) announce("Items from your guest cart were added to your account cart.");
      } catch (e) {
        console.error("Could not prepare your account:", e);
        announce("We could not load your account details. Some features may not work. Please reload the page.");
      }
      try {
        // Admin rights come only from the server-set custom claim.
        const token = await firebaseUser.getIdTokenResult(true);
        setIsAdmin(token.claims.admin === true);
      } catch (e) {
        setIsAdmin(false);
      }
      setUser(firebaseUser);
      setAuthReady(true);
    });
  }, []);

  return (
    <UserContext.Provider value={{ user, setUser, isAdmin, authReady }}>
      <OrderContext.Provider value = {{orderTotal, setOrderTotal}}>
        <SearchContext.Provider value = {{valueToBeSearched, setValueToBeSearched}}>
          <VoiceFilterContext.Provider value={{ voiceFilter, setVoiceFilter }}>
            <TTSContext.Provider value={{screenReader, changeScreenReader}}>
              <ThemeContext.Provider value={{ theme, chooseTheme }}>
                <BrowserRouter>
                  <SiteFrame />
                </BrowserRouter>
              </ThemeContext.Provider>
            </TTSContext.Provider>
          </VoiceFilterContext.Provider>
        </SearchContext.Provider>
      </OrderContext.Provider>
    </UserContext.Provider>
  );
}

export default MainPage;
