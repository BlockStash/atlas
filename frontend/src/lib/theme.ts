export type Theme = "dark" | "light";
export const THEME_KEY = "atlas_theme";

/**
 * Inlined in the root layout and run before first paint, so a saved light theme never flashes dark.
 * Dark stays the default; light applies only once chosen.
 */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem("${THEME_KEY}")==="light")document.documentElement.dataset.theme="light"}catch(e){}`;
