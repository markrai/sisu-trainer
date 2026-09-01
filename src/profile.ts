import { Profile } from "./types.js";
import type { Vo2ProfileInputs } from "./vo2Estimator.js";

/** Unset physiological fields. Placeholders must not become VO2 estimator inputs. */
export const BLANK_PROFILE: Profile = {
  weight: "",
  height: "",
  age: "",
  sex: "",
  vo2: "",
};

/** Profile weight is entered in pounds. Estimator snapshots kilograms. */
export const PROFILE_WEIGHT_LBS_TO_KG = 0.45359237;

export interface ProfileStorage {
  getItem(key: string): string | null;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Explicit stored age/weight only. Does not use unsaved profile defaults.
 * Weight in the profile form is pounds; returned weight is kilograms.
 */
export function parseExplicitVo2ProfileInputs(profile: unknown): Vo2ProfileInputs {
  if (!profile || typeof profile !== "object") return {};
  const row = profile as Profile;
  const inputs: Vo2ProfileInputs = {};
  const age = parseFiniteNumber(row.age);
  if (age != null && age > 0) inputs.age_years = age;
  const weightLbs = parseFiniteNumber(row.weight);
  if (weightLbs != null && weightLbs > 0) {
    inputs.weight_kg = weightLbs * PROFILE_WEIGHT_LBS_TO_KG;
  }
  return inputs;
}

export function readExplicitVo2ProfileInputs(storage?: ProfileStorage): Vo2ProfileInputs {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return {};
  const raw = store.getItem("profile");
  if (!raw) return {};
  try {
    return parseExplicitVo2ProfileInputs(JSON.parse(raw));
  } catch {
    return {};
  }
}

function getProfile(): Profile {
  try {
    const raw = localStorage.getItem("profile");
    if (!raw) return { ...BLANK_PROFILE };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...BLANK_PROFILE };
    return {
      weight: parsed.weight ?? "",
      height: parsed.height ?? "",
      age: parsed.age ?? "",
      sex: parsed.sex ?? "",
      vo2: parsed.vo2 ?? "",
    };
  } catch {
    return { ...BLANK_PROFILE };
  }
}

function saveProfile() {
  const feet = (document.getElementById("heightFeet") as HTMLSelectElement | null)?.value;
  const inches = (document.getElementById("heightInches") as HTMLSelectElement | null)?.value;
  const totalInches = feet && inches ? parseInt(feet) * 12 + parseInt(inches) : "";

  const p: Profile = {
    weight: (document.getElementById("weight") as HTMLInputElement | null)?.value ?? "",
    height: totalInches,
    age: (document.getElementById("age") as HTMLInputElement | null)?.value ?? "",
    sex: (document.getElementById("sex") as HTMLSelectElement | null)?.value ?? "",
    vo2: (document.getElementById("vo2") as HTMLInputElement | null)?.value ?? "",
  };
  localStorage.setItem("profile", JSON.stringify(p));
  if (typeof (window as any).closeModal === "function") {
    (window as any).closeModal();
  }
}

function loadProfile() {
  const stored = getProfile();
  const weightEl = document.getElementById("weight") as HTMLInputElement | null;
  if (weightEl) weightEl.value = stored.weight?.toString() ?? "";

  const totalInches = stored.height ? parseInt(stored.height as any) : 0;
  const feetEl = document.getElementById("heightFeet") as HTMLSelectElement | null;
  const inchesEl = document.getElementById("heightInches") as HTMLSelectElement | null;
  if (feetEl && inchesEl) {
    if (totalInches > 0) {
      const feet = Math.floor(totalInches / 12);
      const inches = totalInches % 12;
      feetEl.value = feet ? feet.toString() : "";
      inchesEl.value = inches ? inches.toString() : "";
    } else {
      feetEl.value = "";
      inchesEl.value = "";
    }
  }

  const ageEl = document.getElementById("age") as HTMLInputElement | null;
  if (ageEl) ageEl.value = stored.age?.toString() ?? "";
  const sexEl = document.getElementById("sex") as HTMLSelectElement | null;
  if (sexEl) sexEl.value = stored.sex ?? "";
  const vo2El = document.getElementById("vo2") as HTMLInputElement | null;
  if (vo2El) vo2El.value = stored.vo2?.toString() ?? "";
}

export function registerProfileGlobals() {
  (window as any).saveProfile = saveProfile;
  (window as any).loadProfile = loadProfile;
}

export { getProfile, saveProfile, loadProfile };
