import React, { useState } from "react";
import { warnImage } from "../services/images";

// URLs that failed once in this session are not requested again.
const failedUrls = new Set();

/**
 * A catalog photo in its frame, with honest states:
 *  - loading: the lit frame; after a moment a quiet "Loading image" note (for a slow or stalled server);
 *  - loaded: the photo;
 *  - failed or missing: the product (or category) name and "Image not available", never a
 *    broken-image icon, an empty frame, or another picture presented as this product's photo.
 * `pending` means the image is not known yet (for example a category picture still being looked up).
 * The image and the note share one grid cell, so every existing frame keeps its size and layout.
 */
function ProductImage({ src, name = "", alt = "", className = "product-photo", loading, compact = false, pending = false, productId }) {
    const [outcome, setOutcome] = useState(null); // { src, state: "loaded" | "failed" }
    let state;
    if (pending) state = "loading";
    else if (!src) state = "missing";
    else if (outcome && outcome.src === src) state = outcome.state;
    else state = failedUrls.has(src) ? "failed" : "loading";

    const showImage = src && !pending && (state === "loading" || state === "loaded");
    // With a real description (product page), the placeholder takes over the image's role.
    const describe = alt && state !== "loaded" && state !== "loading";

    return (
        <span className={`photo${compact ? " photo--compact" : ""}`} data-state={state}>
            {showImage ? (
                <img
                    className={className}
                    src={src}
                    alt={alt}
                    loading={loading}
                    onLoad={() => setOutcome({ src, state: "loaded" })}
                    onError={() => {
                        failedUrls.add(src);
                        warnImage(productId, src, "failed to load");
                        setOutcome({ src, state: "failed" });
                    }}
                />
            ) : null}
            {state !== "loaded" ? (
                <span
                    className="photo__placeholder"
                    {...(describe ? { role: "img", "aria-label": `${alt}. Image not available.` } : { "aria-hidden": "true" })}
                >
                    {compact ? null : (
                        <>
                            {name ? <span className="photo__name">{name}</span> : null}
                            <span className="photo__note">{state === "loading" ? "Loading image…" : "Image not available"}</span>
                        </>
                    )}
                </span>
            ) : null}
        </span>
    );
}

/** For tests: forget which URLs failed. */
export function resetFailedImages() {
    failedUrls.clear();
}

export default ProductImage;
