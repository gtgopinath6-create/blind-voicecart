import { useState } from "react";

const EMPTY = { name: "", email: "", password: "", confirmedPassword: "" };

function AddUser({ addUser }){
    const [values, setValues] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const field = (key, label, type, autoComplete) => (
        <div className="field">
            <label htmlFor={`AddUser-${key}`}>{label}</label>
            <input
                type={type}
                className="input"
                id={`AddUser-${key}`}
                autoComplete={autoComplete}
                value={values[key]}
                aria-invalid={Boolean(errors[key])}
                aria-describedby={errors[key] ? `AddUser-${key}-error` : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            />
            {errors[key] ? <p id={`AddUser-${key}-error`} className="form-error">{errors[key]}</p> : null}
        </div>
    );

    async function submit(event) {
        event.preventDefault();
        const found = {};
        if (!values.name.trim()) found.name = "Enter a name.";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) found.email = "Enter a valid email address.";
        if (values.password.length < 8) found.password = "Use at least 8 characters.";
        if (values.password !== values.confirmedPassword) found.confirmedPassword = "The passwords do not match.";
        setErrors(found);
        if (Object.keys(found).length) return;
        setBusy(true);
        const ok = await addUser({ name: values.name.trim(), email: values.email.trim(), password: values.password });
        setBusy(false);
        if (ok) setValues(EMPTY);
    }

    return(
        <div className="panel">
            <h2 className="panel__title">Add a user</h2>
            <form className="admin-form" onSubmit={submit} noValidate>
                {field("name", "Name", "text", "off")}
                {field("email", "Email", "email", "off")}
                {field("password", "Password", "password", "new-password")}
                {field("confirmedPassword", "Confirm Password", "password", "new-password")}
                <div className="admin-form__submit"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Add user"}</button></div>
            </form>
        </div>
    )
}

export default AddUser;
