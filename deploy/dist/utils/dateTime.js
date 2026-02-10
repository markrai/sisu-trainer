export function todayName() {
    return new Date().toLocaleDateString("en-US", { weekday: "long" });
}
export function formatISO8601UTC(timestamp) {
    return new Date(timestamp).toISOString();
}
