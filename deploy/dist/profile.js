const defaultProfile = {
    weight: 150,
    height: 70,
    age: 25,
    sex: "male",
    vo2: "",
};
function getProfile() {
    try {
        const raw = localStorage.getItem("profile");
        if (!raw)
            return defaultProfile;
        return JSON.parse(raw);
    }
    catch {
        return defaultProfile;
    }
}
function saveProfile() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const feet = (_a = document.getElementById("heightFeet")) === null || _a === void 0 ? void 0 : _a.value;
    const inches = (_b = document.getElementById("heightInches")) === null || _b === void 0 ? void 0 : _b.value;
    const totalInches = feet && inches ? parseInt(feet) * 12 + parseInt(inches) : "";
    const p = {
        weight: (_d = (_c = document.getElementById("weight")) === null || _c === void 0 ? void 0 : _c.value) !== null && _d !== void 0 ? _d : "",
        height: totalInches,
        age: (_f = (_e = document.getElementById("age")) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "",
        sex: (_h = (_g = document.getElementById("sex")) === null || _g === void 0 ? void 0 : _g.value) !== null && _h !== void 0 ? _h : "",
        vo2: (_k = (_j = document.getElementById("vo2")) === null || _j === void 0 ? void 0 : _j.value) !== null && _k !== void 0 ? _k : "",
    };
    localStorage.setItem("profile", JSON.stringify(p));
    if (typeof window.closeModal === "function") {
        window.closeModal();
    }
}
function loadProfile() {
    var _a, _b, _c, _d, _e, _f, _g;
    const stored = getProfile();
    const weightEl = document.getElementById("weight");
    if (weightEl)
        weightEl.value = (_b = (_a = stored.weight) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : "";
    const totalInches = stored.height ? parseInt(stored.height) : 0;
    const feetEl = document.getElementById("heightFeet");
    const inchesEl = document.getElementById("heightInches");
    if (feetEl && inchesEl) {
        if (totalInches > 0) {
            const feet = Math.floor(totalInches / 12);
            const inches = totalInches % 12;
            feetEl.value = feet ? feet.toString() : "";
            inchesEl.value = inches ? inches.toString() : "";
        }
        else {
            feetEl.value = "";
            inchesEl.value = "";
        }
    }
    const ageEl = document.getElementById("age");
    if (ageEl)
        ageEl.value = (_d = (_c = stored.age) === null || _c === void 0 ? void 0 : _c.toString()) !== null && _d !== void 0 ? _d : "";
    const sexEl = document.getElementById("sex");
    if (sexEl)
        sexEl.value = (_e = stored.sex) !== null && _e !== void 0 ? _e : "";
    const vo2El = document.getElementById("vo2");
    if (vo2El)
        vo2El.value = (_g = (_f = stored.vo2) === null || _f === void 0 ? void 0 : _f.toString()) !== null && _g !== void 0 ? _g : "";
}
export function registerProfileGlobals() {
    window.saveProfile = saveProfile;
    window.loadProfile = loadProfile;
}
export { getProfile, saveProfile, loadProfile };
