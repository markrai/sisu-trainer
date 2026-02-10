let wakeLock = null;
async function requestWakeLock() {
    try {
        if ("wakeLock" in navigator) {
            // @ts-ignore - Wake Lock types not universally available
            wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener("release", () => console.log("Wake lock released by system"));
            console.log("Wake lock activated");
            return true;
        }
        else {
            console.warn("Wake Lock API not supported");
            return false;
        }
    }
    catch (error) {
        console.error("Error requesting wake lock:", error);
        return false;
    }
}
async function releaseWakeLock() {
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log("Wake lock released");
        }
        catch (error) {
            console.error("Error releasing wake lock:", error);
        }
    }
}
export function registerWakeLockGlobals() {
    window.requestWakeLock = requestWakeLock;
    window.releaseWakeLock = releaseWakeLock;
    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible" && wakeLock === null) {
            if (typeof window.getSelectedDay === "function" && typeof window.getStartTime === "function") {
                const day = window.getSelectedDay();
                const startTime = window.getStartTime(day);
                if (startTime) {
                    await requestWakeLock();
                }
            }
        }
    });
}
export { requestWakeLock, releaseWakeLock };
