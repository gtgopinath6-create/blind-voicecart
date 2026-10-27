import ManageUsers from "./ManageUsers";
import { useEffect, useRef, useState } from "react";
import AdminSidebar from "./AdminSidebar";
import "./AdminPanel.css";
import ManageProducts from "./ManageProducts";
import AdminDashboard from "./AdminDashboard";
import { usePageTitle } from "../services/uiHooks";

const SECTIONS = [
    { label: "Dashboard", icon: "grid" },
    { label: "Users", icon: "users" },
    { label: "Products", icon: "bag" },
];

// Access is checked by AdminRoute (UI), and by the server and Firestore rules (enforcement).
function AdminPanel(){
    const [current, setCurrent] = useState(0);
    const contentRef = useRef(null);
    const first = useRef(true);
    usePageTitle(`Administration: ${SECTIONS[current].label}`);

    // Move focus to the new section's heading after switching sections.
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        const heading = contentRef.current && contentRef.current.querySelector("h1");
        if (heading) {
            heading.setAttribute("tabindex", "-1");
            heading.focus();
        }
    }, [current]);

    const components = [
        <AdminDashboard></AdminDashboard>,
        <ManageUsers></ManageUsers>,
        <ManageProducts></ManageProducts>
    ];
    return(
        <div className="admin">
            <AdminSidebar sections={SECTIONS} current={current} displayComponent={setCurrent}></AdminSidebar>
            <div className="admin__content" ref={contentRef}>
                {components[current]}
            </div>
        </div>
    )
}

export default AdminPanel;
