# Machine-aware workout guidance

Workout definitions use normalized `activities` values (`bike`, `elliptical`, or `strength`). A workout with more than one allowed activity does not receive machine guidance until the application has an explicit runtime activity choice.

Equipment selection is stored separately from the physiological profile under the local-storage key `sisu_trainer_equipment_selection`. The current shape is:

```json
{
  "bike": "proform-smart-power-10"
}
```

The machine registry currently contains only ProForm SMART Power 10.0 profile version 1. Its resistance-to-watts table is an empirical approximation measured near 70 RPM, not manufacturer watt data. Automatic guidance is limited to resistance 1–15. Working guidance targets 70 RPM; recovery uses approximately 60–65 RPM and omits estimated watts.

Machine policy is isolated in `src/machines/proformSmartPower10.ts`. The generic runtime maintains a bounded 15-second HR buffer, transient controller state, duplicate-free voice events, and a trace that appends only when resistance, cadence, or estimated watts changes. Transient state resets when a workout starts or restarts.

Local workout summaries can include `machine_id`, `machine_profile_version`, and `machine_guidance_trace`. This repository contains no SISU server schema or evidence that `/workout/ingest` accepts arbitrary summary fields. The SISU client therefore removes those three local-only fields before sending the existing network payload.
