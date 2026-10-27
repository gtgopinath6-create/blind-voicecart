// Product images are static files in public/images, named in each product's `image` field (a list of
// "/images/<file>" paths, or one path in older records). Paths are matched to the real files
// regardless of letter case, so images also load on case-sensitive (Linux) hosting.
// Full https URLs are used as stored. Nothing else (relative paths, gs:// Storage paths, data:
// URLs) is turned into an image: those records need fixing, and a dev-only warning names them.
import manifest from "../imageManifest.json";

const warned = new Set();

/** Dev-only, once per product and path. URLs are shown without query strings (they can hold tokens). */
export function warnImage(productId, path, problem) {
    if (process.env.NODE_ENV === "production") return;
    const shown = String(path || "(empty)").split("?")[0];
    const key = `${productId}|${shown}|${problem}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[images] Product ${productId || "(no id)"}, field "image": ${shown} ${problem}.`);
}

/** The URL to load for a stored image path, or null when it cannot be shown. */
export function resolveImage(imagePath) {
    if (typeof imagePath !== "string" || !imagePath.trim()) return null;
    const value = imagePath.trim();
    if (value.startsWith("/images/")) {
        const actual = manifest[value.slice("/images/".length).toLowerCase()];
        return actual ? `/images/${encodeURIComponent(actual)}` : null;
    }
    if (/^https:\/\//i.test(value)) return value;
    return null;
}

/** Every showable image of a product, in stored order ([] when it has none). */
export function productImages(product) {
    if (!product) return [];
    const stored = Array.isArray(product.image) ? product.image : [product.image];
    const resolved = [];
    for (const path of stored) {
        const url = resolveImage(path);
        if (url) resolved.push(url);
        else if (path) warnImage(product.id, path, "has no matching file in public/images (or is not a supported image URL)");
    }
    if (!stored.some(Boolean)) warnImage(product.id, "", "is missing");
    return resolved;
}
