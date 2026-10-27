import React from "react";
import { Link } from "react-router-dom";
import "./cartitem.css"
import Icon from "./Icon";
import { productImages } from "../services/images";
import ProductImage from "./ProductImage";
import { formatPrice, useHoverSpeech } from "../services/uiHooks";

/** One cart line. Quantity is owned by the cart page (props.item.quantity). */
function CartItem({ item, onCartUpdate }){
    const hover = useHoverSpeech();
    const image = productImages(item)[0];
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const options = [item.size && `size ${item.size}`, item.color && `colour ${item.color}`].filter(Boolean).join(", ");
    const name = options ? `${item.name} (${options})` : item.name;
    const qtyId = `qty-${String(item.id || item.name).replace(/\W+/g, "-")}-${item.size || ""}-${item.color || ""}`.replace(/\W+/g, "-");

    return(
        <div className="cart-line" role="group" aria-label={name}>
            <div className="cart-line__image">
                <ProductImage src={image} compact productId={item.id} />
            </div>
            <div className="cart-line__info">
                <p className="cart-line__name" {...hover(name)}>
                    {item.id ? <Link to={`/product/${item.id}`}>{item.name}</Link> : item.name}
                </p>
                {item.size || item.color ? (
                    <p className="cart-line__options">
                        {item.size ? <span>Size {item.size}</span> : null}
                        {item.color ? <span>Colour {item.color}</span> : null}
                    </p>
                ) : null}
                <p className="cart-line__unit" {...hover(`Price: ₹${price}`)}>{formatPrice(price)} each</p>
            </div>
            <div className="cart-line__qty">
                <span className="visually-hidden" id={qtyId}>Quantity of {item.name}</span>
                <div className="qty-stepper" role="group" aria-labelledby={qtyId}>
                    <button type="button" className="qty-stepper__btn" aria-label={quantity === 1 ? `Remove ${item.name}` : `Decrease quantity of ${item.name}`} onClick={() => onCartUpdate(item, quantity - 1)} {...hover("Decrease quantity")}>
                        <Icon name="minus" size={18} />
                    </button>
                    <span className="qty-stepper__value" {...hover(`Quantity: ${quantity}`)}><span className="visually-hidden">Quantity </span>{quantity}</span>
                    <button type="button" className="qty-stepper__btn" aria-label={`Increase quantity of ${item.name}`} onClick={() => onCartUpdate(item, quantity + 1)} {...hover("Increase quantity")}>
                        <Icon name="plus" size={18} />
                    </button>
                </div>
            </div>
            <p className="cart-line__total price" {...hover(`Total: ₹${quantity * price}`)}>
                <span className="visually-hidden">Line total </span>{formatPrice(quantity * price)}
            </p>
            <button type="button" className="btn-quiet cart-line__remove" onClick={() => onCartUpdate(item, 0)} {...hover(`Remove ${item.name}`)}>
                Remove<span className="visually-hidden"> {item.name}</span>
            </button>
        </div>
    );
}

export default CartItem;
