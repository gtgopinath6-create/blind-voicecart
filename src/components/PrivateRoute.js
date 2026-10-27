import React, { useContext } from 'react'
import { Link, Navigate } from 'react-router-dom';
import { UserContext } from "../App";

/** Signed-in users only; guests are sent to the sign-in page. */
export const PrivateRoute = ({ children }) => {
    const { user, authReady } = useContext(UserContext);
    if (!authReady) return <p role="status">Checking your sign-in…</p>;
    return user ? children : <Navigate to="/sign" replace />;
}

/**
 * Admins only, based on the trusted `admin` custom claim (set with `npm run set-admin`).
 * This only hides the UI; Firestore rules and the server enforce the same claim on every operation.
 */
export const AdminRoute = ({ children }) => {
    const { user, isAdmin, authReady } = useContext(UserContext);
    if (!authReady) return <p role="status">Checking your access…</p>;
    if (!user) return <Navigate to="/sign" replace />;
    if (!isAdmin) {
        return (
            <div className="container">
                <div role="alert" className="empty-state">
                    <h1>Access denied</h1>
                    <p>You need administrator access to view this page.</p>
                    <Link to="/" className="btn btn-primary">Go to the home page</Link>
                </div>
            </div>
        );
    }
    return children;
}
