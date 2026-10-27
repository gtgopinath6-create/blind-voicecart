import React from "react";
import Icon from "./Icon";
import { catalogErrorMessage } from "../services/catalogService";

/** A catalog that could not be loaded: what happened, that the cart is unchanged, and a way to try again. */
function CatalogErrorNotice({ error, onRetry, busy = false }) {
    return (
        <div role="alert" className="banner banner--error catalog-error">
            <Icon name="alert" size={20} />
            <div className="catalog-error__body">
                <p>{catalogErrorMessage(error)}</p>
                {onRetry ? (
                    <button type="button" className="btn btn-secondary" onClick={onRetry} disabled={busy} aria-busy={busy}>
                        {busy ? "Trying again…" : "Try again"}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

export default CatalogErrorNotice;
