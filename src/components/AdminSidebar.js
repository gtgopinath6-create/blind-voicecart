import { Link, useNavigate } from 'react-router-dom'
import React, { useContext } from 'react';
import { getAuth, signOut } from "firebase/auth";
import { UserContext } from '../App';
import Icon from "./Icon";

function AdminSidebar({ sections, current, displayComponent }){
    const {setUser} = useContext(UserContext);
    const navigate = useNavigate();

    const emailSignOut = async () => {
        await signOut(getAuth());
        setUser(null);
        navigate('/sign');
    };

    return(
        <aside className="admin-sidebar">
            <Link to="/" className="wordmark admin-sidebar__wordmark"><span className="wordmark__text">VoiceCart</span><span className="visually-hidden"> home</span></Link>
            <h2 className="admin-sidebar__label">Admin Panel</h2>
            <nav aria-label="Admin">
                <ul className="admin-sidebar__list">
                    {sections.map((section, i) => (
                        <li key={section.label}>
                            <button
                                type="button"
                                className="admin-sidebar__item"
                                aria-current={i === current ? "page" : undefined}
                                onClick={() => displayComponent(i)}
                            >
                                <Icon name={section.icon} size={18} /> {section.label}
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>
            <div className="admin-sidebar__footer">
                <Link to="/" className="admin-sidebar__item"><Icon name="home" size={18} /> Back to the store</Link>
                <button type="button" className="admin-sidebar__item" onClick={emailSignOut}><Icon name="logout" size={18} /> Sign out</button>
            </div>
        </aside>
    )
}

export default AdminSidebar;
