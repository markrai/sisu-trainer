# Machine-aware workout guidance

Workout definitions use normalized `activities` values (`bike`, `elliptical`, or `strength`). Allowed activities belong to the workout definition. The active activity belongs to the workout session.

A workout with exactly one allowed activity resolves that activity automatically when the session starts. A workout with more than one allowed activity does not start until the user explicitly chooses one of the allowed activities. Cancel and Restart currently clear session state, so the next Start requires a new choice. Pause, resume, and reloading an in-progress session keep the stored session activity. The choice is not a profile or equipment preference and does not alter `data.json`.

Equipment selection is stored separately from the physiological profile under the local-storage key `sisu_trainer_equipment_selection`. The current shape is:

```json
{
  "bike": "proform-smart-power-10"
}
```

The machine registry currently contains only ProForm SMART Power 10.0 profile version 1. Its resistance-to-watts table is an empirical approximation measured near 70 RPM, not manufacturer watt data. Automatic guidance is limited to resistance 1–15. Working guidance targets 70 RPM; recovery uses 63 RPM and omits estimated watts.

Machine policy is isolated in `src/machines/proformSmartPower10.ts`. Heart-rate adaptation uses a rolling median and requires at least five distinct valid samples spanning at least four seconds. Short work intervals (≤75s) adapt the next repetition only; if the final in-phase tick is missed, the runtime finalizes from the completed work window at the phase boundary without speaking or tracing the internal next-resistance decision. The generic runtime maintains a bounded 15-second HR buffer, transient controller state, duplicate-free voice events, and a trace that appends only when the active recommendation’s resistance, cadence, or estimated watts changes. Transient state resets when a workout starts or restarts.

Local workout summaries can include `activity`, `machine_id`, `machine_profile_version`, and `machine_guidance_trace`. This repository contains no SISU server schema or evidence that `/workout/ingest` accepts arbitrary summary fields. The SISU client therefore removes those local-only fields before sending the existing network payload.

Learned starting resistance is a local historical personalization of work-phase starts. It is keyed by machine, machine profile version, activity, workout intent, and work-duration class (`short` ≤75s, `medium` 76–150s, `long` >150s), not by weekday. The existing ProForm defaults remain the fallback when no trustworthy learned value exists. Learning uses only qualifying completed bike sessions on the current machine profile; cancelled workouts and sessions without a plausible late-work heart-rate response do not train it. The first qualifying session stores the derived candidate directly; later updates move by at most one resistance level. Learned resistance only initializes the first applicable work recommendation. After that, the existing HR-adaptive controller remains authoritative. Learned state can be reset from Settings → Equipment without deleting workout history.
