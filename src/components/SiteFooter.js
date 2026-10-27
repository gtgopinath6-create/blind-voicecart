import React from "react";
import { Link } from "react-router-dom";
import { NAV_ITEMS } from "./navbar";

/** Store footer: real navigation and the keyboard shortcuts only. */
export default function SiteFooter() {
    return (
        <footer className="site-footer">
            <div className="container site-footer__grid">
                <div className="site-footer__brand">
                    <p className="wordmark wordmark--footer"><span className="wordmark__text">VoiceCart</span></p>
                    <p className="muted">An online store designed to be used with a keyboard, a screen reader or your voice.</p>
                </div>
                <nav aria-labelledby="footer-shop">
                    <h2 id="footer-shop" className="site-footer__title">Shop</h2>
                    <ul>
                        {NAV_ITEMS.map((item) => <li key={item.to}><Link to={item.to}>{item.label}</Link></li>)}
                    </ul>
                </nav>
                <nav aria-labelledby="footer-account">
                    <h2 id="footer-account" className="site-footer__title">Your account</h2>
                    <ul>
                        <li><Link to="/account">Account</Link></li>
                        <li><Link to="/cart">Cart</Link></li>
                        <li><Link to="/wishlist">Wishlist</Link></li>
                        <li><Link to="/sign">Sign in</Link></li>
                    </ul>
                </nav>
                <div>
                    <h2 className="site-footer__title">Keyboard shortcuts</h2>
                    <dl className="shortcut-list">
                        <div><dt><kbd>Alt</kbd> + <kbd>V</kbd></dt><dd>Talk to Zoro, or turn Zoro off</dd></div>
                        <div><dt><kbd>Esc</kbd></dt><dd>Stop Zoro speaking</dd></div>
                        <div><dt><kbd>Tab</kbd></dt><dd>Move between controls</dd></div>
                    </dl>
                </div>
            </div>
        </footer>
    );
}
