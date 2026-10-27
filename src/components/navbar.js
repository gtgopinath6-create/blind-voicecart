import React, { useRef, useState, useContext, useEffect } from 'react';
import "./navbar.css";
import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { getAuth, signOut } from "firebase/auth";
import { UserContext, SearchContext, TTSContext, ThemeContext } from '../App';
import { VOICE_ACTIVATE_EVENT, VOICE_STATE_EVENT } from './GlobalAIVoiceAssistant';
import { announce, speakText } from '../services/announcer';
import { useBagCounts, useHoverSpeech } from '../services/uiHooks';
import Icon from './Icon';

const SEARCH_DEBOUNCE_MS = 400;

export const NAV_ITEMS = [
  { to: "/shop", label: "Shop all" },
  { to: "/categories/Shoes", label: "Shoes" },
  { to: "/categories/Electronics", label: "Electronics" },
  { to: "/categories/Clothes", label: "Clothes" },
  { to: "/categories/Food", label: "Food" },
];

/** A labelled on/off switch built on a native checkbox (keyboard and screen-reader friendly). */
function Switch({ id, label, checked, onChange, hoverProps }) {
  return (
    <div className="switch" {...hoverProps}>
      <input id={id} type="checkbox" role="switch" className="switch__input" checked={checked} onChange={onChange} />
      <label htmlFor={id} className="switch__label">
        <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
        <span className="switch__text">{label}</span>
      </label>
    </div>
  );
}

/** Account menu: opens with a button, closes on Escape (focus returns) or an outside click. */
function AccountMenu({ isAdmin, onSignOut, hover }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); if (buttonRef.current) buttonRef.current.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="account-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="utility-link"
        aria-expanded={open}
        aria-controls="account-menu-list"
        onClick={() => setOpen((v) => !v)}
        {...hover("Account menu")}
      >
        <Icon name="user" size={18} /> Account <Icon name="chevronDown" size={16} />
      </button>
      <ul id="account-menu-list" className="account-menu__list" hidden={!open}>
        <li><Link to="/account">My account</Link></li>
        <li><Link to="/wishlist">Wishlist</Link></li>
        {isAdmin ? <li><Link to="/admin">Administration</Link></li> : null}
        <li><button type="button" className="account-menu__signout" onClick={onSignOut}><Icon name="logout" size={18} /> Sign out</button></li>
      </ul>
    </div>
  );
}

const Navbar = () => {
  const { user, setUser, isAdmin } = useContext(UserContext);
  const { screenReader, changeScreenReader } = useContext(TTSContext);
  const { theme, chooseTheme } = useContext(ThemeContext);
  const lightTheme = theme === "ivory";
  const { valueToBeSearched, setValueToBeSearched } = useContext(SearchContext);
  const navigate = useNavigate();
  const location = useLocation();
  const hover = useHoverSpeech();
  const counts = useBagCounts();
  const [menuOpen, setMenuOpen] = useState(false);

  // Voice input is handled by the single GlobalAIVoiceAssistant; this only mirrors its state.
  const [voiceAwake, setVoiceAwake] = useState(false);
  useEffect(() => {
    const onVoiceState = (event) => setVoiceAwake(Boolean(event.detail?.awake));
    window.addEventListener(VOICE_STATE_EVENT, onVoiceState);
    return () => window.removeEventListener(VOICE_STATE_EVENT, onVoiceState);
  }, []);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Category and search pages already filter as you type; elsewhere, open the results page.
  const onProductsPage = location.pathname.startsWith('/categories/') || location.pathname === '/shop';
  useEffect(() => {
    if (!valueToBeSearched || onProductsPage) return undefined;
    const timer = setTimeout(() => navigate('/categories/Search'), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [valueToBeSearched, onProductsPage, navigate]);

  const submitSearch = (event) => {
    event.preventDefault();
    if (!valueToBeSearched.trim()) {
      announce("Type something to search for.");
      return;
    }
    navigate('/categories/Search');
  };

  const emailSignOut = async () => {
    try {
      await signOut(getAuth());
      setUser(null);
      navigate('/sign');
      announce("You are signed out.");
    } catch (error) {
      announce("Sign out failed. Please try again.");
    }
  };

  return (
    <header className="site-header">
      <div className="site-header__utility">
        <div className="container site-header__utility-inner">
          <form className="header-search" role="search" onSubmit={submitSearch}>
            <label htmlFor="site-search" className="visually-hidden">Search products</label>
            <button type="submit" className="header-search__submit" aria-label="Search" {...hover("Search")}>
              <Icon name="search" size={20} />
            </button>
            <input
              type="search"
              id="site-search"
              className="header-search__input"
              placeholder="Search the collection"
              autoComplete="off"
              value={valueToBeSearched}
              onChange={(event) => setValueToBeSearched(event.target.value)}
              {...hover("Search")}
            />
            {valueToBeSearched ? (
              <button type="button" className="icon-btn header-search__clear" aria-label="Clear search" onClick={() => setValueToBeSearched("")}>
                <Icon name="close" size={18} />
              </button>
            ) : null}
          </form>
          <div className="utility-links">
            <Switch
              id="theme-switch"
              label="Light theme"
              checked={lightTheme}
              hoverProps={hover(`Light theme, currently ${lightTheme ? 'on' : 'off'}`)}
              onChange={() => {
                chooseTheme(lightTheme ? "noir" : "ivory");
                if (screenReader) speakText(`Light theme ${lightTheme ? 'off' : 'on'}`);
              }}
            />
            <Switch
              id="reader-switch"
              label={<><span className="sm-hidden">Built-in screen </span><span className="switch__short">reader</span></>}
              checked={screenReader}
              hoverProps={hover(`Built-in screen reader, currently ${screenReader ? 'on' : 'off'}`)}
              onChange={() => {
                changeScreenReader(!screenReader);
                // Confirm turning it off too, otherwise the change would be silent.
                speakText(`Screen Reader ${!screenReader ? "On" : "Off"}`);
              }}
            />
            {user
              ? <AccountMenu isAdmin={isAdmin} onSignOut={emailSignOut} hover={hover} />
              : <Link to="/sign" className="utility-link" {...hover("Sign in")}><Icon name="user" size={18} /> Sign in</Link>}
          </div>
        </div>
      </div>

      <div className="container site-header__main">
        <button
          type="button"
          className="icon-btn menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name={menuOpen ? "close" : "menu"} size={22} />
          <span className="visually-hidden">{menuOpen ? "Close menu" : "Menu"}</span>
        </button>

        <Link to="/" className="wordmark" onClick={() => setValueToBeSearched('')} {...hover("VoiceCart home")}>
          <span className="wordmark__text">VoiceCart</span><span className="visually-hidden"> home</span>
        </Link>

        <nav id="primary-nav" className={`primary-nav${menuOpen ? " is-open" : ""}`} aria-label="Main">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className="primary-nav__link" onClick={() => setValueToBeSearched('')} {...hover(item.label)}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="header-actions">
          <button
            type="button"
            className="header-action header-action--voice"
            aria-label="Talk to Zoro, the voice assistant (Alt+V)"
            aria-pressed={voiceAwake}
            onClick={() => window.dispatchEvent(new CustomEvent(VOICE_ACTIVATE_EVENT))}
            {...hover("Talk to Zoro, the voice assistant. You can also press Alt and V.")}
          >
            <Icon name={voiceAwake ? "micOff" : "mic"} size={20} />
            <span className="header-action__text" aria-hidden="true">Voice</span>
          </button>
          <Link to="/wishlist" className="header-action" aria-label={`Wishlist, ${counts.wishlist} ${counts.wishlist === 1 ? "item" : "items"}`} {...hover(`Wishlist, ${counts.wishlist} items`)}>
            <Icon name="heart" size={21} />
            {counts.wishlist ? <span className="count-badge" aria-hidden="true">{counts.wishlist}</span> : null}
          </Link>
          <Link to="/cart" className="header-action" aria-label={`Cart, ${counts.cart} ${counts.cart === 1 ? "item" : "items"}`} {...hover(`Cart, ${counts.cart} items`)}>
            <Icon name="bag" size={21} />
            {counts.cart ? <span className="count-badge" aria-hidden="true">{counts.cart}</span> : null}
          </Link>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
