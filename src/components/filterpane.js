import React from "react";
import "./filterpane.css"
import { useHoverSpeech } from "../services/uiHooks";

const label = (value) => value[0].toUpperCase() + value.slice(1);

/** One row of toggle chips; the selected chip has aria-pressed="true". */
function ChipGroup({ title, id, allLabel, values, selected, onSelect, hover, note }) {
    return (
        <div className="filter-group" role="group" aria-labelledby={id} aria-describedby={note ? `${id}-note` : undefined}>
            <h3 id={id} className="filter-group__title">{title}</h3>
            {note ? <p id={`${id}-note`} className="filter-group__note">{note}</p> : null}
            <ul className="chip-list">
                <li>
                    <button type="button" className="chip" aria-pressed={!selected} onClick={() => onSelect(null)} {...hover(allLabel)}>
                        {allLabel}
                    </button>
                </li>
                {values.map((value) => (
                    <li key={value}>
                        <button type="button" className="chip" aria-pressed={selected === value} onClick={() => onSelect(value)} {...hover(label(value))}>
                            {label(value)}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Category (optional) and brand filters for product listings. */
function FilterPane({ brands, selectedBrand, filterBrand, categories, selectedCategory, filterCategory, brandNote = null }){
    const hover = useHoverSpeech();
    return(
        <nav className="filters" aria-labelledby="filter-heading">
            <h2 id="filter-heading" className="visually-hidden">Filters</h2>
            {categories && categories.length ? (
                <ChipGroup title="Category" id="filter-category" allLabel="All categories" values={categories} selected={selectedCategory} onSelect={filterCategory} hover={hover} />
            ) : null}
            {brands.length ? (
                <ChipGroup title="Brand" id="filter-brand" allLabel="All brands" values={brands} selected={selectedBrand} onSelect={filterBrand} hover={hover} note={brandNote} />
            ) : null}
        </nav>
    );
}

export default FilterPane;
