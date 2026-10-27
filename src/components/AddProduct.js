import { useState } from "react";
import manifest from "../imageManifest.json";

const EMPTY = { name: "", description: "", price: "", rating: "", category: "", subcategory: "", brand: "", images: "" };

const FIELDS = [
    { key: "name", label: "Name", placeholder: "Enter product name" },
    { key: "description", label: "Description", placeholder: "Enter product description" },
    { key: "price", label: "Price (₹)", placeholder: "Enter product price", inputMode: "decimal" },
    { key: "rating", label: "Rating (0 to 5)", placeholder: "Enter product rating", inputMode: "decimal" },
    { key: "category", label: "Category", placeholder: "shoes, electronics, food or clothes" },
    { key: "subcategory", label: "Subcategory", placeholder: "Enter product subcategory" },
    { key: "brand", label: "Brand", placeholder: "Enter product brand" },
    { key: "images", label: "Image file names", placeholder: "e.g. vans1.PNG, vans2.PNG (files in public/images)" },
];

function validate(v) {
    const errors = {};
    if (!v.name.trim()) errors.name = "Enter a name.";
    if (!v.description.trim()) errors.description = "Enter a description.";
    if (!/^\d+(\.\d{1,2})?$/.test(v.price.trim())) errors.price = "Enter a price, for example 499 or 499.50.";
    if (v.rating.trim() && !(Number(v.rating) >= 0 && Number(v.rating) <= 5)) errors.rating = "Enter a rating from 0 to 5.";
    if (!["shoes", "electronics", "food", "clothes"].includes(v.category.trim().toLowerCase())) errors.category = "Use shoes, electronics, food or clothes.";
    if (!v.subcategory.trim()) errors.subcategory = "Enter a subcategory.";
    if (!v.brand.trim()) errors.brand = "Enter a brand.";
    const files = v.images.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = files.filter((f) => !manifest[f.toLowerCase()]);
    if (files.length === 0) errors.images = "Enter at least one image file name.";
    else if (missing.length) errors.images = `No such file in public/images: ${missing.join(", ")}.`;
    return errors;
}

function AddProduct({ addProduct }){
    const [values, setValues] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    async function submit(event) {
        event.preventDefault();
        const found = validate(values);
        setErrors(found);
        if (Object.keys(found).length) {
            const first = document.getElementById(`AddProduct-${Object.keys(found)[0]}`);
            if (first) first.focus();
            return;
        }
        setBusy(true);
        const ok = await addProduct({
            name: values.name.trim(),
            description: values.description.trim(),
            price: Number(values.price),
            rating: values.rating.trim() ? Number(values.rating) : 0,
            category: [values.category.trim().toLowerCase(), values.subcategory.trim().toLowerCase(), values.brand.trim().toLowerCase()],
            image: values.images.split(",").map((s) => s.trim()).filter(Boolean).map((f) => `/images/${manifest[f.toLowerCase()]}`),
        });
        setBusy(false);
        if (ok) setValues(EMPTY);
    }

    return(
        <div className="panel">
            <h2 className="panel__title">Add a product</h2>
            <form className="admin-form" onSubmit={submit} noValidate>
                {FIELDS.map((f) => (
                    <div key={f.key} className={`field field--${f.key}`}>
                        <label htmlFor={`AddProduct-${f.key}`}>{f.label}</label>
                        <input
                            type="text"
                            className="input"
                            id={`AddProduct-${f.key}`}
                            placeholder={f.placeholder}
                            inputMode={f.inputMode}
                            value={values[f.key]}
                            aria-invalid={Boolean(errors[f.key])}
                            aria-describedby={errors[f.key] ? `AddProduct-${f.key}-error` : undefined}
                            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        />
                        {errors[f.key] ? <p id={`AddProduct-${f.key}-error`} className="form-error">{errors[f.key]}</p> : null}
                    </div>
                ))}
                <div className="admin-form__submit"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Adding…" : "Add product"}</button></div>
            </form>
        </div>
    )
}

export default AddProduct;
