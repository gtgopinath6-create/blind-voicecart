import { getAllUsers } from "./firebaseservices";
import { useState, useEffect, useCallback } from "react";
import AddUser from "./AddUser";
import UserTable from "./UserTable";
import { apiRequest } from "../services/apiClient";
import { announce } from "../services/announcer";

// Account changes go through the server (Firebase Admin SDK) after it verifies the admin claim,
// so creating a user never signs the administrator out.
function ManageUsers(){
    const [allUsers, setAllUsers] = useState([]);
    const [status, setStatus] = useState({ text: "", error: false });

    const report = (text, error = false) => {
        setStatus({ text, error });
        announce(text);
    };

    const load = useCallback(async () => {
        try {
            setAllUsers(await getAllUsers());
        } catch (e) {
            report("Users could not be loaded. You may not have administrator access.", true);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    async function disableUser(user, disabled){
        try {
            await apiRequest(`/api/admin/users/${encodeURIComponent(user.uid)}/disable`, { body: { disabled } });
            report(`${user.name || user.email} was ${disabled ? "disabled and signed out" : "enabled"}.`);
        } catch (e) {
            report(`Could not update ${user.name || user.email}: ${e.message}`, true);
        }
    }

    async function deleteUser(user){
        try {
            await apiRequest(`/api/admin/users/${encodeURIComponent(user.uid)}`, { method: "DELETE" });
            setAllUsers((list) => list.filter((u) => u.uid !== user.uid));
            report(`${user.name || user.email} was deleted. Their orders are kept for records.`);
        } catch (e) {
            report(`Could not delete ${user.name || user.email}: ${e.message}`, true);
        }
    }

    async function addUser(info){
        try {
            const { user } = await apiRequest("/api/admin/users", { body: info });
            report(`Account created for ${user.email}.`);
            await load();
            return true;
        } catch (e) {
            report(`The account was not created: ${e.message}`, true);
            return false;
        }
    }

    return(
        <section className="admin-section" aria-labelledby="users-title">
            <header className="admin-header">
                <p className="eyebrow">Administration</p>
                <h1 id="users-title">Manage users</h1>
            </header>
            <p role={status.error ? "alert" : "status"} className={status.error ? "form-error" : "form-success"}>{status.text}</p>
            <UserTable users = {allUsers} deleteUser = {deleteUser} disableUser={disableUser}></UserTable>
            <AddUser addUser = {addUser}></AddUser>
        </section>
    )
}

export default ManageUsers;
