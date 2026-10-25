// A row or card that opens as a whole: its one name link's box stretches
// over it, so the link, its name and its one Tab stop stay as they were, and
// its keyboard ring is drawn around the row. `!` because styles.css rings
// every focused link outside any layer, which beats a plain utility. Anything
// else in the row that takes a click must sit above the link (`relative z-1`).
export const OPENS_ROW = "relative cursor-pointer hover:bg-hover";

export const ROW_LINK =
  "after:absolute after:inset-0 after:rounded-card focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-focus-ring focus-visible:after:outline-offset-2";

// A table's frame clips what lies outside its rows, so a row's ring is drawn
// inside it.
export const TABLE_ROW_LINK =
  "after:absolute after:inset-0 focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-focus-ring focus-visible:after:-outline-offset-2";
