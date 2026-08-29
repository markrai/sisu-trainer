# SISU Bike Submax Protocol v1

Standalone submaximal bike test used by the **VO2 Max Estimation** workout.

This document is the tracked protocol contract. `docs/` may contain an optional gitignored mirror; this root file is authoritative.

This is **not** a clinical CPET and is **not** an official YMCA or Astrand-Ryhming implementation.

SISU still does **not** calculate VO2. This protocol produces versioned evidence for a future estimator.

## Purpose

Run a reproducible, versioned submaximal staged bike test inside the existing SISU workout runtime, and persist enough protocol-specific evidence for a later estimator to validate.

The workout may complete even if a future estimator would reject the attempt.

## Protocol identity

```text
protocol_id: bike-submax-70rpm
protocol_version: 1
```

These constants are centralized in application code. The protocol version is **not** derived from the app version.

A future change to stage timing, workload-selection rules, acceptance rules, or cadence assumptions must become protocol version 2. Version-1 workouts must not be reinterpreted.

Selector identity:

```text
selector: VO2MaxEstimation
label: VO2 Max Estimation
activity: bike
intent: vo2_estimation
```

This is a dedicated workout definition, not a Monday/Friday weekly-plan day.

## Why 70 RPM

The current ProForm SMART Power 10.0 workload calibration is trustworthy at 70 RPM. Protocol v1 therefore **prescribes** 70 RPM.

## Why cadence is prescribed rather than measured

SISU does not have a measured cadence sensor in this phase. 70 RPM is a coaching/prescription target. Protocol evidence must not claim the rider maintained 70 RPM and must not invent measured cadence.

## Why watts are calibrated estimates rather than measured power

The bike does not provide trusted measured watts for estimator use. Protocol v1 resolves a nominal watt target through the existing calibrated 70-RPM machine profile to a discrete resistance and the canonical estimated watts for that resistance.

`calibrated_watts_at_70rpm` is an estimate from that table, not measured power.

## Architecture

The existing workout runtime remains authoritative:

```text
selector
  ->
preflight
  ->
beginWorkout / startSession
  ->
existing active clock
  ->
VO2 protocol runtime (feeds getPhase / machine hold)
  ->
existing machine guidance
  ->
Bike Bridge automatically, when enabled
  ->
manual resistance coaching otherwise
  ->
existing completion
  ->
vo2_evidence.protocol
  ->
IndexedDB
```

The protocol module does not own the workout clock, HR recorder, machine controller, BLE stack, Bike Bridge client, or persistence system.

## Preflight

Before the workout clock starts, verify:

1. Bike activity / calibrated 70-RPM machine profile is selected
2. Live BLE HR is present and recent (existing 3-second freshness policy)
3. At least three distinct increasing calibrated 70-RPM workloads can be resolved

Bike Bridge automatic control is **not** required. The test is runnable with manual resistance changes.

If preflight fails, the session does not start. The UI shows a specific reason, for example:

- Heart-rate strap required
- No calibrated 70 RPM bike profile selected
- Not enough calibrated workload levels for this test

## Warmup

- Duration: 5 active minutes
- Cadence: 70 RPM prescribed
- Intensity: easiest calibrated 70-RPM workload from the selected machine profile

Warmup is not estimator-grade workload evidence.

## Work stages

Each primary test stage:

- Nominal duration: 3 active minutes
- Maximum duration: 5 active minutes (at most two 1-minute extensions)
- Cadence prescription: 70 RPM
- Resistance: fixed for that stage
- Estimated workload: the resolved calibrated watts at 70 RPM for that resistance

Ordinary machine guidance may adapt resistance during a weekly-plan phase. Protocol stages must not. The protocol supplies a hold resistance; existing machine guidance is still the only command source.

A stage's workload stays stable so a later estimator can associate HR response with one known workload.

The normal test targets three usable work stages. A fourth stage may run when fewer than three stages have been accepted and another **commandable** resolved workload remains, without exceeding the protocol-v1 resistance ceiling or the calibrated table.

## Workload resolution

Warmup uses the easiest valid calibrated 70-RPM workload.

Work-stage targets then step from that resolved floor:

```text
stage 1 target = warmup calibrated watts + 25 W
stage N target = previous resolved stage watts + 25 W
```

Each target is resolved through the canonical calibrated 70-RPM accessor:

```text
target watts
  ->
nearest valid calibrated 70-RPM pair strictly above the previous resolved workload
  ->
prescribed resistance
  ->
calibrated watts at 70 RPM
```

`requested_watts` is that actual target fed to the resolver, not a global 25/50/75/100 sequence from zero.

Requirements:

- The first work stage is a greater workload than warmup
- Resolved workloads strictly increase
- Duplicate resistance levels are not emitted twice
- No extrapolation beyond the calibrated table
- No fabricated power
- No unsupported resistance

The protocol records the **resolved** workload together with the requested target that produced it.

Protocol v1 is bound to the ProForm SMART Power 10.0 calibration (`proform-smart-power-10` / `getEstimatedWattsAt70Rpm`). Another bike profile cannot pass preflight and silently inherit that table.

## Commandable resistance range

Machine calibration exists through resistance **1..15**. Ordinary weekly-workout machine guidance still uses that full range.

Protocol v1 currently restricts resolved workloads to resistance **1..10**. That is the current end-to-end commandable ceiling (`VO2_PROTOCOL_MAX_RESISTANCE`), not a claim that the ProForm itself only has levels 1–10.

This restriction exists so protocol evidence remains truthful in both manual operation and current automatic Bike Bridge control. SISU must not record a prescribed resistance that the existing automatic-control transport would silently change.

A future validated Bike Bridge range expansion may permit a later protocol version, or an explicitly reviewed protocol-v1 change, to use resistances 11–15. Until then, protocol v1 does not fabricate a fourth stage merely to fill a four-stage target if the commandable table cannot support it.

The future estimator may reject an attempt that accepts fewer than three stages.

## Steady-state HR

HR is collected on the existing active workout clock from raw ~1 Hz samples.

At the end of nominal minute 3:

- minute-2 HR = mean valid HR from active seconds 60..119 of that stage
- minute-3 HR = mean valid HR from active seconds 120..179 of that stage

A stage is HR-steady when `abs(mean_minute_3 - mean_minute_2) <= 5 bpm`.

Missing samples are not interpolated. Each evaluated 60-second window needs at least 45 valid samples.

If either window lacks coverage, the stage is not yet steady/usable.

## Extension behavior

If the stage is not steady after minute 3, extend the same workload for one additional active minute and re-evaluate the latest two complete 60-second windows.

At most two extension minutes are allowed (maximum stage duration 5 active minutes).

If HR is still not steady after five minutes:

- mark the stage `unstable_hr` when both final windows had coverage
- mark the stage `insufficient_hr` when a final window lacked coverage
- do not fabricate a steady-state value
- keep the stage in evidence and continue according to remaining-stage rules

## Termination reasons

```text
protocol_complete
submax_hr_ceiling
early_cooldown
user_cancelled
hr_lost
insufficient_calibrated_workloads
other
```

Protocol completion and estimator eligibility are separate. Counts of `accepted`, `unstable_hr`, and `insufficient_hr` stages are recorded so a later estimator can require three accepted increasing workloads.

## Physiological ceiling

SISU currently has **no authoritative HRmax**. Profile stores weight/height/age/sex, not HRmax. HR zones are absolute BPM bands, not %HRmax.

Protocol v1 therefore does **not** invent `220 - age` or any other HRmax formula.

Automatic 85% HRmax enforcement is unavailable. Completion evidence sets `automatic_submax_hr_ceiling_available: false`. Early Cooldown and Cancel remain the user safety exits. This is not medical test safety validation.

If an authoritative HRmax is added later, protocol v1's `submax_hr_ceiling` reason exists for that future policy and must not be back-applied by guessing.

## Early Cooldown

Early Cooldown remains available. The current work stage ends as `incomplete` unless already closed, protocol termination is `early_cooldown`, and the existing Early Cooldown transition starts cooldown. No VO2 estimate is produced. Evidence remains valid as an attempted/incomplete test.

## Cancel

Existing cancellation remains authoritative. Termination reason is `user_cancelled`. Open stages close as `incomplete`. No phantom accepted stage continues beyond cancellation.

## Manual vs automatic resistance

Existing machine guidance remains the only resistance policy/command source. The protocol supplies the desired fixed resistance for the current stage/warmup/cooldown. When Bike Bridge automatic control is enabled, that guidance is forwarded by the existing Bike Bridge session. Otherwise SISU issues the normal manual resistance instruction.

The protocol module does not POST to Bike Bridge.

## Evidence contract

Protocol evidence is an optional field on the existing local `vo2_evidence` object. Schema version remains **1**; the addition is backward compatible.

Ordinary workouts may have `vo2_evidence` without `protocol`. Historical workouts without evidence still load. Historical evidence is not rewritten. SISU server ingest still strips `vo2_evidence` entirely.

Shape (application field names):

```text
protocol?: {
  protocol_id: "bike-submax-70rpm"
  protocol_version: 1
  prescribed_cadence_rpm: 70
  stages: [{
    stage_id
    active_start_sec
    active_end_sec
    requested_watts?
    prescribed_resistance
    calibrated_watts_at_70rpm
    status: accepted | unstable_hr | insufficient_hr | incomplete
    nominal_duration_sec
    actual_duration_sec
    hr?: { sample_count, minute_2_mean_bpm?, minute_3_mean_bpm?, final_two_window_delta_bpm?, steady_state_bpm? }
  }]
  termination: { reason }
  automatic_submax_hr_ceiling_available: boolean
}
```

Invariants:

- `calibrated_watts_at_70rpm` is a calibration estimate, not measured power
- `prescribed_resistance` is a command/prescription, not necessarily observed resistance
- 70 RPM is prescribed cadence, not measured cadence
- cadence coaching is not an HR prescription
- raw HR remains in `hr_samples`; protocol evidence does not duplicate the full HR trace
- no measured cadence or measured watts are invented
- prescribed resistance is never above the protocol-v1 commandable ceiling of 10

## Reproducibility / snapshot behavior

When the test begins, the resolved protocol plan is frozen on `vo2ProtocolRuntime.plan`. That object is the single authority for this attempt.

- protocol_id / protocol_version
- prescribed cadence
- warmup resistance and calibrated watts
- resolved stage resistances and calibrated watts
- requested watts for each resolved stage (the +25 W target actually fed to the resolver)

A later machine-profile change must not rewrite what this workout prescribed. The entire global machine profile is not snapshotted.

Stage HR evaluation reads the canonical IndexedDB `hr_samples` store. The protocol does not keep a second raw HR trace.

## Limitations

- Not a clinical CPET
- Not an official YMCA, Astrand-Ryhming, ACSM, or clinical exercise test
- Cadence is prescribed, not measured
- 70 RPM is coaching text and machine-guidance cadence, not an HR target
- Watts are calibrated 70-RPM estimates, not measured power
- No authoritative HRmax / automatic 85% ceiling
- Automatic Bike Bridge control is optional
- Manual resistance remains supported
- No VO2 estimate exists yet
- Pause-safe timing uses the existing active workout clock; resistance-command time is not proof the bike physically reached that resistance
- machine calibration: resistance 1..15
- current VO2 protocol v1 commandable range: resistance 1..10

## Deferred estimator

This phase does not implement VO2max formulas, regression, extrapolation to HRmax, Astrand nomogram, YMCA equations, ml/kg/min or L/min results, confidence scores, percentiles, fitness categories, or generalized/passive VO2 inference.

No VO2 score, percentile, trend chart, history page, or recommendation engine is shown. Successful completion may toast that evidence was recorded and estimation is not enabled yet.
