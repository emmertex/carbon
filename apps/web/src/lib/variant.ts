/**
 * Build-variant flags.
 *
 * The Google Play build is bundled with VITE_PLAY_STORE=1 (see
 * apps/mobile/build-android.sh). Play restricts background location, so the
 * Play variant omits background GPS tracks; the sideload/desktop build keeps
 * the full feature set. Code that needs to hide a Play-incompatible feature
 * checks {@link IS_PLAY_STORE}.
 */
export const IS_PLAY_STORE: boolean = import.meta.env.VITE_PLAY_STORE === "1";
