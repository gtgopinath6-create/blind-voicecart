import { useState, useMemo } from "react";

function UserTable({ users, deleteUser, disableUser }){
    const [userToBeSearched, setUserToBeSearched] = useState("");

    // Always filter the full list, so clearing or shortening the search restores every match.
    const currentUsers = useMemo(() => {
        const q = userToBeSearched.trim().toLowerCase();
        if (!q) return users;
        return users.filter((u) => `${u.name || ""} ${u.email || ""}`.toLowerCase().includes(q));
    }, [users, userToBeSearched]);

    function confirmDelete(user) {
        const who = user.name || user.email || user.uid;
        if (window.confirm(`Permanently delete the account of ${who}? Their login, cart and wishlist will be removed. Orders are kept.`)) {
            deleteUser(user);
        }
    }

    return(
        <div className="panel admin-table">
            <div className="admin-table__top">
                <h2 className="panel__title">Users</h2>
                <div className="admin-search" role="search">
                    <label htmlFor="user-search" className="field-label">Search users by name or email</label>
                    <div className="admin-search__row">
                        <input id="user-search" className="input" type="search" value={userToBeSearched} onChange={(event) => setUserToBeSearched(event.target.value)}></input>
                        {userToBeSearched ? <button type="button" className="btn btn-secondary" onClick={() => setUserToBeSearched("")}>Clear</button> : null}
                    </div>
                </div>
            </div>
            <p role="status" className="muted small admin-table__count">{currentUsers.length} {currentUsers.length === 1 ? "user" : "users"} shown</p>
            <div className="table-scroll">
                <table className="data-table">
                    <caption className="visually-hidden">Customer accounts</caption>
                    <thead>
                        <tr>
                            <th scope="col">Name</th>
                            <th scope="col">UID</th>
                            <th scope="col">Email</th>
                            <th scope="col"><span className="visually-hidden">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {currentUsers.map((user) => (
                            <tr key={user.uid || user.id}>
                                <th scope="row">{user.name || "—"}</th>
                                <td className="admin-table__mono">{user.uid}</td>
                                <td>{user.email}</td>
                                <td className="admin-table__actions">
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => disableUser(user, true)}>
                                        Disable<span className="visually-hidden"> {user.name || user.email}</span>
                                    </button>
                                    <button type="button" className="btn btn-danger btn-sm" onClick={() => confirmDelete(user)}>
                                        Delete<span className="visually-hidden"> {user.name || user.email}</span>
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

export default UserTable;
