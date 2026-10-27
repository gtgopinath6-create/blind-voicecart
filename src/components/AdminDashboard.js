import { getAllUsers } from "./firebaseservices";
import { useState } from "react"
import { dedupeProducts } from "../services/productMatching";
import { loadAllProductDocuments, catalogErrorMessage } from "../services/catalogService";

/**
 * Counts read from Firestore; nothing here is estimated or invented. Counting reads every product
 * and customer document, so it runs only when an administrator asks for it.
 */
function AdminDashboard(){
    const [allUsers, setAllUsers] = useState(null);
    const [allProducts, setAllProducts] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    async function count() {
        setLoading(true);
        setError("");
        try {
            const [users, products] = await Promise.all([getAllUsers(), loadAllProductDocuments()]);
            setAllUsers(users);
            setAllProducts(products);
        } catch (e) {
            setError(e && e.name === "CatalogError" ? catalogErrorMessage(e) : "Dashboard data could not be loaded.");
        } finally {
            setLoading(false);
        }
    }

    const value = (n) => (n === null ? "—" : n);

    return (
        <section className="admin-section" aria-labelledby="dashboard-title">
            <header className="admin-header">
                <p className="eyebrow">Overview</p>
                <h1 id="dashboard-title">Dashboard</h1>
            </header>
            <div className="stat-actions">
                <button type="button" className="btn btn-secondary" onClick={count} disabled={loading} aria-busy={loading}>
                    {loading ? "Counting…" : allUsers === null ? "Count products and customers" : "Count again"}
                </button>
                <p className="muted small">Counting reads every product and customer document once.</p>
            </div>
            {error ? <p role="alert" className="banner banner--error">{error}</p> : null}
            {loading ? <p role="status" className="loading">Counting…</p> : null}
            <dl className="stat-grid">
                <div className="stat">
                    <dt className="stat__label">Customer profiles</dt>
                    <dd className="stat__value">{value(allUsers && allUsers.length)}</dd>
                </div>
                <div className="stat">
                    <dt className="stat__label">Product documents</dt>
                    <dd className="stat__value">{value(allProducts && allProducts.length)}</dd>
                </div>
                <div className="stat">
                    <dt className="stat__label">Distinct products in the store</dt>
                    <dd className="stat__value">{value(allProducts && dedupeProducts(allProducts).length)}</dd>
                    <dd className="stat__note">Exact copies are shown once.</dd>
                </div>
            </dl>
        </section>
    )
}

export default AdminDashboard;
