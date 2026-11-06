export type Theme = "dark" | "light";
export const THEME_KEY = "atlas_theme";
/** Visual skin, independent of light/dark. "ethglobal" is the ETHGlobal Mumbai look. */
export type Skin = "atlas" | "ethglobal";
export const SKIN_KEY = "atlas_skin";

/**
 * Inlined in the root layout and run before first paint, so a saved light theme or skin never flashes.
 * Dark and the Atlas skin stay the defaults; the others apply only once chosen.
 */
export const THEME_BOOT_SCRIPT = `try{var d=document.documentElement;if(localStorage.getItem("${THEME_KEY}")==="light")d.dataset.theme="light";if(localStorage.getItem("${SKIN_KEY}")==="ethglobal")d.dataset.skin="ethglobal"}catch(e){}`;
