import { removeProduct, addNewProduct } from "./firebaseservices";
import { useState, useEffect, useCallback } from "react";
import ProductTable from "./ProductTable";
import AddProduct from "./AddProduct";
import { announce } from "../services/announcer";
import { fetchProductPage, loadAllProductDocuments, invalidateCatalog, catalogErrorMessage } from "../services/catalogService";

// Every document is listed (copies included), 50 at a time, so opening this page does not read the whole catalog.
const ADMIN_PAGE_SIZE = 50;

// Product writes are allowed only for the admin claim (firestore.rules).
function ManageProducts(){
    const [allProducts, setAllProducts] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [complete, setComplete] = useState(false);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState({ text: "", error: false });

    const report = (text, error = false) => {
        setStatus({ text, error });
        announce(text);
    };

    const loadPage = useCallback(async (after) => {
        setLoading(true);
        try {
            const page = await fetchProductPage({ cursor: after, pageSize: ADMIN_PAGE_SIZE });
            setAllProducts((list) => (after ? [...list, ...page.docs] : page.docs));
            setCursor(page.cursor);
            setComplete(page.done);
        } catch (e) {
            report(catalogErrorMessage(e), true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPage(null); }, [loadPage]);

    async function loadAll() {
        setLoading(true);
        try {
            setAllProducts(await loadAllProductDocuments());
            setComplete(true);
            report("Every product document is loaded.");
        } catch (e) {
            report(catalogErrorMessage(e), true);
        } finally {
            setLoading(false);
        }
    }

    async function deleteProduct(product){
        try {
            await removeProduct(product.id);
            invalidateCatalog();
            setAllProducts((list) => list.filter((p) => p.id !== product.id));
            report(`${product.name} was deleted.`);
        } catch (e) {
            report(`${product.name} could not be deleted: ${e.message}`, true);
        }
    }

    async function addProduct(product){
        try {
            const created = await addNewProduct(product);
            invalidateCatalog();
            setAllProducts((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
            report(`${created.name} was added.`);
            return true;
        } catch (e) {
            report(`The product was not added: ${e.message}`, true);
            return false;
        }
    }

    return(
        <section className="admin-section" aria-labelledby="products-title">
            <header className="admin-header">
                <p className="eyebrow">Administration</p>
                <h1 id="products-title">Manage products</h1>
            </header>
            <p role={status.error ? "alert" : "status"} className={status.error ? "form-error" : "form-success"}>{status.text}</p>
            <ProductTable products = {allProducts} deleteProduct = {deleteProduct} complete={complete}></ProductTable>
            {!complete ? (
                <div className="admin-more">
                    <button type="button" className="btn btn-secondary" onClick={() => loadPage(cursor)} disabled={loading} aria-busy={loading}>
                        {loading ? "Loading…" : `Show ${ADMIN_PAGE_SIZE} more`}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={loadAll} disabled={loading}>Load every document</button>
                    <p className="muted small">Loading every document reads the whole catalog once.</p>
                </div>
            ) : null}
            <AddProduct addProduct = {addProduct}></AddProduct>
        </section>
    )
}

export default ManageProducts;
