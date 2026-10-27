import React from "react";
import "./Categories.css"
import { Link } from "react-router-dom";
import Icon from "./Icon";
import ProductImage from "./ProductImage";
import { useHoverSpeech } from "../services/uiHooks";

/**
 * Image-led category tile: one link (one keyboard stop) to the category page.
 * image: a URL, null when the category has no usable picture, or undefined while it is looked up.
 */
function Categories({ name, image, count }){
    const hover = useHoverSpeech();
    const meta = typeof count === "number" ? `${count} ${count === 1 ? "piece" : "pieces"}` : "Explore";
    return(
        <Link className="category-tile" to={`/categories/${name}`} {...hover(`${name}, ${meta}`)}>
            <span className="category-tile__media" aria-hidden="true">
                <ProductImage src={image || undefined} name={name} loading="lazy" pending={image === undefined} />
            </span>
            <span className="category-tile__label">
                <span className="category-tile__name">{name}</span>
                <span className="category-tile__meta">{meta} <Icon name="arrowRight" size={18} /></span>
            </span>
        </Link>
    );
}

export default Categories;
