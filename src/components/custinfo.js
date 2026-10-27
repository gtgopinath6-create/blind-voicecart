import { SHIPPING_FIELDS } from "../services/validation";
import { useHoverSpeech } from "../services/uiHooks";
import "./custrecinfo.css";

/** Contact details (from the profile) and the delivery form (controlled by the billing page). */
function CustInfo({ profile, shipping, errors, onChange, onBlur }){
    const hover = useHoverSpeech();

    return(
        <section className="checkout-card" aria-labelledby="customerHeader">
            <h2 id="customerHeader" className="checkout-card__title" {...hover("Contact and delivery details")}>Contact and delivery</h2>
            <dl className="contact-list">
                <div><dt>Name</dt><dd>{(profile && profile.name) || "—"}</dd></div>
                <div><dt>Email</dt><dd>{(profile && profile.email) || "—"}</dd></div>
            </dl>
            <form id="customerForm" className="delivery-form" noValidate onSubmit={(e) => e.preventDefault()}>
                {SHIPPING_FIELDS.map((rule) => {
                    const error = errors[rule.field];
                    const describedBy = [rule.hint ? `${rule.inputId}-hint` : null, error ? `${rule.inputId}-error` : null].filter(Boolean).join(" ") || undefined;
                    const common = {
                        id: rule.inputId,
                        value: shipping[rule.field],
                        onChange: (event) => onChange(rule.field, event.target.value),
                        onBlur: () => { if (onBlur) onBlur(rule.field); },
                        autoComplete: rule.autoComplete,
                        inputMode: rule.inputMode,
                        required: true,
                        "aria-required": true,
                        "aria-invalid": Boolean(error),
                        "aria-describedby": describedBy,
                    };
                    return (
                        <div className={`field field--${rule.field}`} key={rule.field}>
                            <label htmlFor={rule.inputId} {...hover(`${rule.label}, required`)}>
                                {rule.label}<span className="required-mark" aria-hidden="true"> *</span>
                            </label>
                            {rule.multiline ? <textarea className="textarea" rows={3} {...common}></textarea> : <input type="text" className="input" {...common}></input>}
                            {rule.hint ? <p id={`${rule.inputId}-hint`} className="field-hint">{rule.hint}</p> : null}
                            {error ? <p id={`${rule.inputId}-error`} className="form-error">{error}</p> : null}
                        </div>
                    );
                })}
            </form>
            <p className="field-hint">Fields marked * are required.</p>
        </section>
    )
}

export default CustInfo;
