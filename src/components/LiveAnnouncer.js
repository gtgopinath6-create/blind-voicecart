import React, { useEffect, useState } from "react";

/**
 * Visually hidden polite live region. Messages sent with announce() appear here when the
 * custom screen reader is off, so native screen readers read them exactly once.
 */
function LiveAnnouncer() {
    const [message, setMessage] = useState("");

    useEffect(() => {
        let clearTimer = null;
        const onAnnounce = (event) => {
            if (event.detail.spoken) return; // already spoken by the custom screen reader
            // Clear first so the same text announced twice is still read again.
            setMessage("");
            setTimeout(() => setMessage(event.detail.text), 50);
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => setMessage(""), 8000);
        };
        window.addEventListener("ANNOUNCE", onAnnounce);
        return () => {
            window.removeEventListener("ANNOUNCE", onAnnounce);
            clearTimeout(clearTimer);
        };
    }, []);

    return (
        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {message}
        </div>
    );
}

export default LiveAnnouncer;
