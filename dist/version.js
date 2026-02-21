export const APP_VERSION = "0.9.9";
export function setVersionOnDom() {
    const versionEl = document.getElementById("appVersion");
    if (versionEl) {
        versionEl.textContent = "v" + APP_VERSION;
    }
    window.APP_VERSION = APP_VERSION;
}
