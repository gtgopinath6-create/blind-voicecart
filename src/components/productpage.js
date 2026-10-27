import React from "react";
import Container from "./container";

/** Category, search and "Shop all" listings. The site header and footer come from App. */
function ProductPage(props){
    return <Container name={props.name} />;
}

export default ProductPage;
