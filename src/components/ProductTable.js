import { formatPrice } from "../services/uiHooks";
import { useState, useMemo } from "react";

function ProductTable({ products, deleteProduct, complete = true }){
    const [productToBeSearched, setProductToBeSearched] = useState("");

    // Always filter the full list, so clearing or shortening the search restores every match.
    const currentProducts = useMemo(() => {
        const q = productToBeSearched.trim().toLowerCase();
        if (!q) return products;
        return products.filter((p) => (p.name || "").toLowerCase().includes(q));
    }, [products, productToBeSearched]);

    function confirmDelete(product) {
        if (window.confirm(`Delete "${product.name}" from the catalog?`)) deleteProduct(product);
    }

    return(
        <div className="panel admin-table">
            <div className="admin-table__top">
                <h2 className="panel__title">Products</h2>
                <div className="admin-search" role="search">
                    <label htmlFor="product-search" className="field-label">Search products by name</label>
                    <div className="admin-search__row">
                        <input id="product-search" className="input" type="search" value={productToBeSearched} onChange={(event) => setProductToBeSearched(event.target.value)}></input>
                        {productToBeSearched ? <button type="button" className="btn btn-secondary" onClick={() => setProductToBeSearched("")}>Clear</button> : null}
                    </div>
                </div>
            </div>
            <p role="status" className="muted small admin-table__count">
                {currentProducts.length} {currentProducts.length === 1 ? "product" : "products"} shown
                {complete ? "" : `, from the first ${products.length} documents loaded. Load more to search the rest`}
            </p>
            <div className="table-scroll">
                <table className="data-table">
                    <caption className="visually-hidden">Product catalog documents</caption>
                    <thead>
                        <tr>
                            <th scope="col">Name</th>
                            <th scope="col" className="num">Price</th>
                            <th scope="col">Category</th>
                            <th scope="col"><span className="visually-hidden">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {currentProducts.map((product) => (
                            <tr key={product.id}>
                                <th scope="row">{product.name}</th>
                                <td className="num">{formatPrice(product.price)}</td>
                                <td className="admin-table__cap">{Array.isArray(product.category) ? product.category[0] : ""}</td>
                                <td className="admin-table__actions"><button type="button" className="btn btn-danger btn-sm" onClick={() => confirmDelete(product)}>Delete<span className="visually-hidden"> {product.name}</span></button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

export default ProductTable;
