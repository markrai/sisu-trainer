# Fitbaus personalization baseline (code as of 2026-10-11)

Investigation only. No code was changed for this report except creating this file.
Read time: ~5–10 minutes. Claims are split into **code** (read from source),
**tests** (read, not run), **evidence** (real-session artifacts quoted in source),
and **inference** (explicitly labeled).

## 1. Repository state

`git status` could not run under the sandbox identity (repo owned by another
user; `--global` gitconfig not writable), so the state below comes from
`git -c safe.directory=...` invocations:

- Branch: `main...origin/main` (in sync; HEAD `2261517`).
- Recent log (newest first):
  - `2261517` Clarify personalization history candidate naming
  - `11f68d6` Tighten personalization-history contribution wording to require usable E2 evidence
  - `ec7692d` Support protocol v3 FitnessState promotion
  - `33fc3f3` Test explicit control-mode compatibility
  - `63424c9` Surface assessment-based workload advice
- Uncommitted changes: **7 staged (index) modifications, no unstaged diff**
  (`git diff --stat` empty; `git diff --cached --stat`):

| File | Note |
|---|---|
| `src/vo2AdaptivePlanner.ts` | Bootstrap + one-point-fallback behavior change (see §2) |
| `src/vo2AssessmentView.ts` | New user wording for adaptive refusal (see §2) |
| `dist/vo2AdaptivePlanner.js`, `dist/vo2AssessmentView.js` | Generated runtime for the above |
| `tests/vo2AdaptiveV3Invariants.test.mjs` | Large test update (+421/−~40 lines with planner file) |
| `tests/vo2AssessmentView.test.mjs` | Tests for the new wording |
| `tests/vo2ProtocolV3Start.test.mjs` | Start/bootstrap test update |

**Code** (staged diff read directly): the uncommitted changes **do alter
assessment behavior** — bootstrap step 25 W → 5 W, new runway-preservation rule
in the one-point path, and new assessment-view shortfall wording. Any session
started under the old policy keeps its own persisted policy
(`buildVo2ProtocolPlanV3` freezes policy in the plan), so old and new sessions
behave differently side by side.

## 2. VO₂ assessment (protocol v3)

**Code.** New assessments start **only v3**: [workoutLogic.ts](C:/dev/project/sisu-trainer/src/workoutLogic.ts)
calls `evaluateVo2PreflightV3ForUi()` then `createVo2ProtocolRuntimeV3()`.
The v1/v2 fixed ladders still exist (`src/vo2Protocol.ts`) and the runtime
dispatcher (`advanceVo2ProtocolRuntime`) can still advance them, but nothing
starts them for new tests. The module header states v3 is "explicit opt-in;
default writer stays v2" for *evidence writing*, while collection itself is v3.

| Topic | Current behavior (code) |
|---|---|
| Workload selection | Pure planner `planNextVo2Stage()` in `src/vo2AdaptivePlanner.ts`. Domains never mixed: planning regression/prediction use **calibrated watts** (controllable); `estimator_watts` recorded in provenance for audit only |
| Bootstrap (0 eligible) | Smallest distinguishable step above warmup: `max(min_increment, separation)` = **5 W** (staged change; committed HEAD has warmup + 25 W) |
| One-point fallback (<2 eligible, no anchor) | `fallback_watt_step` = **15 W**; **staged change:** with 1 eligible point and ≥1 more eligible stage still needed, take the minimum 5 W step to preserve runway ("ladder only ascends") |
| Multi-point (≥2 eligible) | OLS secant in calibrated domain; `planning_ceiling = hard_ceiling − 12 bpm`; target = min(base + 20 W normal, maxSafe, base + 25 W max); candidate must be ≥5 W above base, within 25 W, predicted strictly below planning and ≥110 bpm |
| Stages required | `VO2_TARGET_WORK_STAGES` = 3; planner `complete` at ≥3 eligible; `max_work_stages` = 4 (from the 30-min advertised bound: 5 warmup + 4×5 work + 5 cooldown) |
| HR floor | Estimator floor **110 bpm** (`VO2_ESTIMATOR_MIN_HR_BPM`); predictions below floor refused |
| HR ceiling | Hard ceiling = **85% of Tanaka HRmax** (208 − 0.7×age); any stage HR ≥ ceiling is rejected by the shared classifier; planning refuses predictions ≥ hard − 12 |
| Steady-state accept | `evaluateStageHr` at 180/240/300 s; each window needs ≥45 HR samples; steady if \|min2 − min3\| ≤ 5 bpm. Accepted at first steady checkpoint; otherwise +1 min extension (max 2); at 300 s non-steady → `unstable_hr` (coverage ok) or `insufficient_hr` |
| Measured vs calibrated | `summarizeVo2StageWorkload`: `measured_watts` (≥45 bike-watt samples → median) wins; else `calibrated_at_verified_cadence` (≥45 cadence samples, ≥75% within ±5 rpm of 70, median in band); else `prescribed_only` → estimator-ineligible |
| Early stop | User cancel, limit reached, early cooldown, **live fresh spot HR ≥ hard ceiling during work** (immediate `submax_hr_ceiling`), steady above-ceiling stage, planner `cannot` (no safe target / bounds exhausted / retry limit / stage limit), no unused calibrated levels |
| Retry | At most **1** lower retry after an above-ceiling stage (`retry_lower_after_above_ceiling`); second breach or no lower safe level → truthful stop |

### Reference case: R6/86 W/120.3 bpm → R7/97 W/137.32 bpm → `hr_safety_no_safe_target`

- **Evidence** (quoted in a planner source comment): age 46 → predicted HRmax
  175.8, hard ceiling 149.43, planning ceiling 137.43. The two eligible points
  fit slope ≈ 1.547 bpm/W, predicting ≈ 154.3 bpm at R8/108 W — above *both*
  planning and hard ceilings. No margin ≥ 0 admits R8, so the planner returns
  `hr_safety_no_safe_target` / `submax_hr_ceiling` with 2 eligible stages.
- **Inference:** current *refusal logic* is unchanged, so the same two points
  would still refuse. But current code would **not reproduce the sequence**:
  the staged 5 W bootstrap starts at the lowest calibrated level above warmup
  instead of warmup + 25 W, so the same athlete gets different early workloads
  (and the one-point path now steps minimally to preserve runway). The comment
  itself notes the old bootstrap "skipped the lower calibrated levels" the
  session later needed.

## 3. VO₂ estimator (`assessVo2`, `src/vo2Estimator.ts`)

Protocol collection and estimator math are separate: the classifier
(`classifyVo2ProtocolStage`) is shared, but the estimator only reads frozen
evidence + profile. Estimator v2 accepts protocols **v2 and v3 identically**
(no semantic change, no version bump).

| Check | Rule (code) |
|---|---|
| Minimum stages | ≥3 accepted **and** ≥3 eligible, else `too_few_accepted/eligible_stages` |
| Workload progression | Eligible `watts` strictly increasing, else `invalid_workload_progression` |
| HR progression | Eligible steady HR strictly increasing, else `invalid_hr_progression` |
| Per-stage eligibility | Protocol `accepted` + verified workload source + HR in [110, hard ceiling) |
| Regression domain | OLS HR-vs-**estimator watts**; needs ≥2 usable points, slope > 0, R² ≥ 0.7, else `unstable_regression` / `nonpositive_slope` |
| Estimate formula | `predictedMaxWatts = (HRmax − intercept) / slope`; `VO₂ = 10.8 × Wmax / kg + 7` (ACSM leg-cycle) |
| Extrapolation guards | HRmax within 120–220 and > last HR; Wmax > last watts and ≤ 800; estimate within 10–100 ml/kg/min, else `invalid_extrapolation` / `invalid_estimate` |
| `insufficient_evidence` | Any of: schema/protocol mismatch, missing/invalid age/weight, too few accepted/eligible, bad progression, bad fit, bad extrapolation/estimate |

## 4. Formal FitnessState promotion

**Code** (`src/fitnessState.ts` → `src/workoutSummary.ts`).

| Question | Answer (code) |
|---|---|
| Accepted pairs | `SUPPORTED_VO2_FORMAL_ASSESSMENT_CONTRACTS`: (est v1, proto v1), (est v2, proto v2), (**est v2, proto v3**) — so **v3 assessments can promote** (commit `ec7692d`) |
| Gate | `promoteVo2AssessmentToFitnessState` is pure/fail-closed: athlete match, `status == estimated`, zero reason codes, exact contract + schema match, R² recomputation equality, ACSM recomputation equality, calibration points cross-checked against `summary.vo2_evidence` stages (id, watts, HR, source), newer-than-current guard |
| Persisted | `schemaVersion`, `athleteId`, `vo2Max`, `predictedMaxWatts` (derivation `demographic_hrmax_extrapolation`), `hrWorkloadCalibration` (slope, intercept, R², observed min/max watts, per-stage points with source, protocol id+version, predicted HRmax + `demographic_estimate` source, age/kg snapshot); every metric carries `formal_assessment` source, conservative quality (high→moderate if any point is cadence-estimated), timestamps, algorithm id+version, `evidenceSessionIds` |
| Failure surface | Pure function returns `null` → wrapper `promoteVo2SummaryToStoredFitnessState` returns `"not_eligible"` (or `"persistence_failed"`); `workoutSummary` saves the summary first, then `console.warn`s "…promotion was not eligible" / "…could not be persisted". No UI error; history simply shows no calibration |
| Machine provenance | **Yes, persisted alongside** — as a separate sidecar record (`recordPromotedFormalCalibrationMachine` → `formal_calibration_machine_provenance_v1` store: machine id + profile version + calibration identity), **not** inside FitnessState |

## 5. Personalized workout advice (E1)

**Code** (`src/personalizedPrescription.ts`, wired in `src/workoutLogic.ts`,
rendered in `src/uiControls.ts`).

- **Inputs E1 requires:** legacy prescription (≤100 phases), `workoutIntent`,
  `activity`, `athleteId`, parsed profile (age + body mass), parsed
  FitnessState with formal calibration, `PHASE_E1_SHADOW_POLICY`
  (`aerobic_base` + `threshold` only, nearest-watt rounding, **no
  extrapolation**), ISO `resolvedAt`.
- **Phases that can get candidates:** `kind == work` **and**
  `intensityId ∈ {aerobic_base, threshold}` **and** workout intent ∈
  {`aerobic_base`, `aerobic_volume`, `threshold`} **and** bike activity, non-VO₂
  workout. Everything else → `fallback` with a named reason.
- **Candidate math:** `watts = (HR_target − intercept) / slope`, rounded to
  integer watts per HR bound; HR target must lie inside the observed HR range
  **and** the inverted watts inside the observed watt range.
- **Fallback causes:** unsupported activity/workout/phase, missing numeric HR
  target, missing profile/state, athlete mismatch, bad schema, non-formal or
  unsupported algorithm/protocol, **low-quality calibration** (E1 needs
  moderate/high — note: promotion can persist `low`), <3 points, mixed workload
  provenance, profile-input mismatch, stale (policy expiry is `null`, so
  freshness is recorded as not-evaluated, never a fallback today),
  outside-HR/workload-range, invalid candidate.
- **Control authority:** candidates are **read-only advice**. Evaluation is
  `mode: "shadow"`, `activationEligible: false`; module comment: "no
  runtime/controller path… legacy HR prescription remains live control
  authority."
- **What the athlete sees:** per eligible work phase, `#assessmentWorkloadAdvice`
  shows `Your assessment-based workload: X–Y W`; otherwise the element stays
  hidden. (Committed `63424c9` surfaced this.)

## 6. E2 validation

**Code** (`src/personalizedPrescriptionCharacterization.ts`,
`src/personalizationStatus.ts`).

- E2 runs **after** the workout: `characterizePersonalizedPrescription`
  compares each E1 candidate against observed stable in-band workload using the
  held-workload forward-response policy (120 s settling, ≥30 qualifying
  seconds, coverage thresholds). It never changes the workout; it writes
  `shadow_prescription_characterization` for later aggregation.
- Per-phase outcomes: `characterized` (usable comparison exists),
  `insufficient_evidence` (candidate but telemetry/coverage too weak, with an
  `exclusionReason`), `not_candidate` (E1 was fallback), plus
  `unsupported_observed_provenance`.
- **candidate existed** = E1 phase outcome was `candidate` (a target was
  proposed). **Characterized with usable evidence** = that candidate *plus*
  enough settled in-band telemetry to compute a comparison. A candidate with
  poor coverage stays `insufficient_evidence` and does not count as validation
  data.
- **History wording** (current, after `11f68d6`/`2261517`): title always
  `Personalization evaluation recorded`; body is `This workout contributed data
  toward validating individualized bike targets.` only when ≥1 phase is a
  *characterized* candidate, otherwise `No individualized workload target was
  available for this workout.`

## Current end-to-end path

```text
VO₂ assessment (v3 collects)
    ↓ PARTIAL — starts and steps correctly, but steep responders strand at 2 eligible stages (§2)
formal assessment (estimated)?
    ↓ BLOCKED — needs 3 eligible stages; the reference session ended insufficient_evidence
FitnessState (formal calibration)?
    ↓ NOT YET ACTIVE — v3 promotion code path exists and accepts v3 (ec7692d), but no successful v3 assessment has produced one in practice
E1 candidate watts?
    ↓ WORKING — shadow evaluation code is complete; simply has no real calibration to consume
athlete sees personalized Threshold watt advice?
    ↓ WORKING — read-only advice element renders from frozen E1 output; nothing real has reached it
E2 observes/validates afterward?
    ↓ WORKING — characterization + history wording complete; idle for lack of candidates
```

## Baseline conclusions

1. **Already working:** estimator math + gating; the v3→FitnessState promotion
   contract; E1 shadow candidates with strict no-extrapolation guards; read-only
   Threshold advice rendering; E2 characterization and history wording; machine
   provenance sidecar. Committed tests cover each layer (estimator, v3 start,
   adaptive invariants, promotion, E1, characterization, assessment view) —
   read but not executed here (the suite runs `tsc`, which rewrites `dist/`).
2. **Blocking the product goal:** no successful formal assessment is being
   produced, so nothing flows downstream. The observed failure mode is the
   planner stopping at 2 eligible stages with `hr_safety_no_safe_target`.
3. **The blocker is primarily VO₂ data acquisition** — collection policy
   (start level, step size, safety margin vs. band headroom on the actual
   machine table) interacting with steep individual HR response. It is not
   estimator math, promotion, E1, or UI: each of those is implemented and
   (per committed tests) behaves, but all are starved of input.
4. **Would a successful v3 assessment flow through today?** **Code says yes,
   with two conditions:** the assessment must reach `estimated` with ≥3
   eligible stages (promotion then accepts the v2-estimator/v3-protocol pair),
   **and** the persisted calibration must be moderate/high quality, single
   provenance, with the athlete's Threshold HR band inside the observed HR/watt
   domain (otherwise E1 falls back even after promotion — e.g. a `low`-quality
   success promotes but never yields candidates). No end-to-end run with real
   data has proven this in this investigation.
5. **Single next problem:** make a steep responder's v3 session actually collect
   **three eligible submaximal stages** instead of stranding at two — i.e.
   resolve the bootstrap/runway interaction on the real calibration table so
   the planner enters the 110 bpm–planning-ceiling band early enough to fit
   three increasing points below the ceiling. Everything downstream is built
   and waiting; nothing else should change until a real session proves this.

## Open questions / suspected gaps

- (Staged bootstrap) Starting at the lowest level above warmup spends the one
  spare stage (4 max − 3 required) on a possibly below-floor stage for flat
  responders; whether 5 W vs 15 W first steps maximize 3-stage completion
  across slopes is unproven — needs multi-session data, not tuning to one
  fixture (the planner comment itself warns against overfitting).
- (Margin) The fixed 12 bpm margin does not cover sharp convex steepening
  inside one large step; containment relies on estimator rejection + one retry.
  Residual overshoot risk on coarse tables is acknowledged in-source.
- (`low`-quality path) Promotion persists `low`-quality calibrations that E1
  will always refuse (`low_quality_calibration`). Is persisting an unusable
  calibration the right call, or should promotion stay silent? No behavior
  proposed here.
- (Freshness) E1 expiry is `null`/`not_configured` by design; any future
  lifetime value changes which old calibrations yield advice. Currently inert.
- (History wording edge) A workout with a candidate but zero characterized
  phases reads "No individualized workload target was available," which understates
  "target proposed, evidence too weak." Wording follows the two recent commits;
  flagged only as a possible future question.

## VO₂ v3 acquisition strategy investigation

Added 2026-10-11. Design only; no production code changed. Method: a throwaway
replay harness (kept outside the repo) drove the **real** staged
`planNextVo2Stage` (`dist/vo2AdaptivePlanner.js`) and the **real**
`classifyVo2ProtocolStage` (`dist/vo2Estimator.js`) through synthetic
HR-vs-measured-watts families. Modeled, not real: linear/convex HR curves,
assumed steady state with full sampling (sampling dynamics not simulated),
measured-watts path only. The committed arm emulates HEAD defaults
(`bootstrap_watt_step: 25`) on staged code with a recompute guard for the
one-point runway rule — the guard never fired, so committed trajectories here
are exact. New arms are **policy-override only**; no invariant was weakened.

### Current acquisition constraints

For the fixture athlete (age 46, hard ceiling 149.43, planning 137.43) the
usable band is 110 → 137.43 ≈ 27.4 bpm; at ≈1.55 bpm/W that is ≈17.7 W of
span. Three levels with 5 W gaps need ≥10 W inside the band — fits in
principle. The binding constraints interact as follows:

- Entry must land the first stage at/above 110 bpm; every skipped low level is
  permanently lost (ladder only ascends) and only 1 spare stage exists (4 max,
  3 required).
- The 5 W minimum consumes span and, on this table, blocks the only viable
  low triplet (below).
- Post-fit, each step must predict strictly below planning; a correct refusal
  (R8 predicted ≈154) then ends the session if no levels remain.

Exhaustive check, proform R1–R10, noiseless steep-linear projection
(**inference**: R4/R5 HRs are back-projected, not observed): **no
5 W-compliant triplet is all-eligible**. The sole all-eligible triplet is
R5 → R6 → R7 (gaps 4 W, 11 W; HRs ≈114.1, 120.3, 137.3), admitted at R7 by
0.11 bpm (137.32 vs 137.43 planning). The 5 W rule alone blocks the only
working path — and even that path is razor-thin (see noise result below).

### Why the staged fix may or may not be sufficient

Replay traces for the fixture athlete (no measurement error):

```text
committed: R6/86 eligible -> R7/97 eligible -> STOP(hr_safety_no_safe_target) [2]
staged:    R4/78 INELIGIBLE[hr_below_estimator_range] -> R7/97 eligible -> STOP(hr_safety_no_safe_target) [1]
adjacent:  R3/70 INELIGIBLE[hr_below_estimator_range] -> R6 -> R7 -> STOP(hr_safety_no_safe_target) [2]
```

- The committed trace reproduces the real session exactly (validates the harness).
- The staged change moves this failure **earlier** (2 → 1 eligible): the 5 W
  bootstrap lands below the floor, spends the spare stage, and the 137.3 bpm
  point then trips the one-point headroom guard.
- Staged helps elsewhere (steep-convex completes under staged, fails under
  committed) but **regresses** one case: near-ceiling athlete with −5 W
  measurement bias completes under committed [3] and fails under staged [1].
- Verdict: the staged fix is not sufficient. It improves band entry on average
  but does not unlock the steep responder, and it can regress tight-band athletes.

### 5 W separation finding: planner heuristic, not scientific requirement

- **Code evidence (estimator):** `workloadsIncrease` requires only strict
  `next > prev` on estimator watts — no minimum anywhere in
  `src/vo2Estimator.ts`. R² ≥ 0.7, recomputation equality in promotion, and
  strict HR progression are the real regression guards, and all are retained
  regardless of acquisition spacing.
- **Code evidence (planner):** `VO2_ADAPTIVE_MIN_WATT_SEPARATION = 5` was
  introduced in `436a28d` with the one-line comment "Minimum useful workload
  separation in watts" — no derivation, no citation. Its stated purpose
  ("differ by at least this much to improve the regression") is a
  regression-leverage heuristic.
- **Replay evidence:** on a dense R1–R10 table (4 W steps) the staged arm stops
  with `insufficient_separation` [2] where the adjacency arm (1 W minimums,
  everything else identical) reaches COMPLETE [3]. Same safety envelope, same
  estimator gates — only the heuristic differs.
- Supporting point: calibrated separation does not even guarantee
  estimator-domain separation — the real session measured R7 5 W under its
  calibrated value. The estimator's strict-increase check on **measured**
  watts is the true guard; pre-fit acquisition can let measured evidence
  decide validity fail-closed (a non-increasing pair is rejected, spending at
  most the one spare stage).

### Candidate strategies (max 3)

All are policy-constant changes: no schema, version, estimator, or invariant change.

| | A: pre-fit adjacency (mins → 1 W) | B: A + bootstrap 15 W | C: runway-aware selection |
|---|---|---|---|
| Benefit | Unlocks 4 W-gap triplets (R5→R6) and dense tables; lets measured evidence decide | Also fixes band **entry**: lands R5 first, R5→R6→R7 completes steep in replay (no-error and bias modes) | Picks entry to maximize remaining viable levels; table-aware, no tuned constant |
| Risk | Extra below-floor burn for flat athletes (replay: lowstart [1]→[0]); noise can break strict measured increase (fail-closed, costs a stage) | 15 W entry is fixture-fitted (it lands R5 here by luck); overshoots on dense tables (replay: dense steep [3]→[1]); worse for near-ceiling (replay [2]→[1]) | Larger design change; does not solve steep by itself (runway exists — entry is the problem) |
| Steep responders | Enables, but does not complete alone (needs entry) | Completes in replay, margin 0.08–0.11 bpm — fragile | Neutral |
| Fit/flat responders | Slightly worse burn rate | Neutral | Neutral-to-positive (honest early stop on coarse tables) |
| Schema/version change | None (policy persisted per plan; old sessions unaffected) | None | None (policy-shaped), but needs new planner logic |

Noise caveat (all strategies): with ±3 W cyclic measurement error, even the
viable R5→R6→R7 path breaks (`nonpositive_slope` / progression violations).
Tight triplets near the ceiling are inherently fragile — a further reason not
to tune constants to this fixture.

### Recommended next experiment (one)

Run a **policy-only experiment combining A and B on the real bike**:
`min_watt_increment = min_watt_separation = 1 W`, `bootstrap_watt_step = 15 W`,
everything else identical — first session with the steep athlete. Neither half
suffices alone in replay (A without entry strands at 2; entry without A cannot
take the 4 W R5→R6 step), and policy-only means zero schema/estimator risk and
automatic per-plan isolation. Pre-register: success = 3 eligible stages and
`estimated`; watch flat-athlete below-floor burn rate, noise-induced
non-increasing measured pairs, and the R7 planning margin; revert to staged
defaults if a flat athlete burns the spare stage without entering the band.
Do **not** adopt the 15 W bootstrap as a permanent value from this — it is
fixture-fitted until multi-athlete data says otherwise.

### Stop condition

VO₂ acquisition is no longer the primary blocker when **three consecutive real
v3 sessions across at least two athletes (one steep responder) reach
`estimated`, promote (`promoted`), and render Threshold watt advice** — with
the safety envelope (hard ceiling, floor, 3-stage minimum, strict
progressions, steady-state and evidence rules, measured-watt authority)
unchanged. Until then, nothing downstream needs to change.

## Real-bike acquisition experiment

Added 2026-10-11. Implemented, pre-tested, **not yet run on the bike**.
No success claimed — the real session is still to come.

### Experimental policy

```text
min_watt_increment = 1 W
min_watt_separation = 1 W
bootstrap_watt_step = 15 W
```

Declared once as frozen `VO2_ACQUISITION_EXPERIMENT_POLICY_OVERRIDE`
(`src/vo2AdaptivePlanner.ts`). Everything else stays at current defaults
(margin 12 bpm, max increment 25 W, fallback step 15 W, 4 max stages,
1 above-ceiling retry). Expected ProForm trajectory: warmup R1/66 W →
target 81 W → **R5/82 W** first; if R5 eligible → R6/86 W (4 W step now
allowed); then the unchanged planner decides R7/97 W. No resistance, wattage,
athlete, or session values are hard-coded.

### Why it is isolated

Developer-only flag: `window.__VO2_ACQUISITION_EXPERIMENT__ === true`
(`VO2_ACQUISITION_EXPERIMENT_FLAG`), read by
`resolveVo2PreflightPolicyOverride()` and passed through the existing
`evaluateVo2PreflightV3ForUi(now, policy)` parameter into
`buildVo2ProtocolPlanV3`, which persists the values in the plan's
`adaptive_policy`. Flag absent (or anything but `true`): resolver returns
`undefined`, behavior identical to the currently staged worktree (5 W
bootstrap/runway experiment) — not to the main-branch behavior that produced
the original R6→R7 session. Removal = delete the constant and
its two references. No schema, contract, or estimator change.

### Pre-registered success criteria

```text
3 accepted stages, 3 eligible stages, assessment status = estimated
```

Record: R5 steady HR, R5 measured watts, R6 steady HR / measured watts,
R7 steady HR / measured watts if reached, planner reason codes, termination
reason. A clean failure (R5 below floor, non-increasing measured watts, R7
refused) still answers the question — do not force any stage to count.

### What remains unchanged

110 bpm floor, 85%-HRmax hard ceiling, 12 bpm planning margin, 3-stage
minimum, strict measured-watt and HR progression, steady-state and workload
evidence rules, measured-watt authority, fail-closed behavior, retry/stage
limits, promotion, E1/E2, UI. Pre-run proof (10 tests,
`tests/vo2AcquisitionExperiment.test.mjs`, real planner/estimator):
R5-first selection, 4 W step allowed, non-increasing measured watts still
rejected, planning ceiling still respected, unsafe higher stage still refused,
staged defaults byte-identical when the flag is off (join test deepEquals the
persisted plan policy), and the flag-on join produces 1 / 1 / 15 in the created
runtime.

### Validation status (honest)

- `npm run check` (tsc --noEmit): clean.
- Focused 10/10 pass against freshly compiled output.
- Full suite: 874/876 pass in a scratch harness (fresh emit + relocated
  tests); the 2 failures (`nativeBleConnect`, `personalizationScientificAssessment`)
  are missing bare packages outside the package tree and fail identically at
  pristine HEAD — zero regressions attributable to this change.
- `npm run build` / `npm test` could **not** run in place here: this sandbox
  identity cannot overwrite user-owned `dist/` files (EPERM; user processes
  running, left untouched) and `git diff --check` is clean. Before the bike
  session the owner must rebuild `dist/` (see run instructions) so the
  experiment seam reaches the running app.

## Threshold personalization model investigation

Added 2026-10-11. Investigation only; no production code changed.
Concepts kept separate: generic HR workout target ≠ formal submax
HR/workload calibration ≠ predicted maximal workload ≠ physiological
threshold ≠ training workload prescription ≠ runtime HR control.

### Proven current state

Real protocol-v3 assessment promoted on-device into `fitness_state_v1`
(athlete `afa677b3-9682-4fb9-8f7d-af77375975d7`): VO₂ ≈ 37.09, predicted
max watts ≈ 145.35, three measured calibration points
(78 W@118.53, 87 W@126.25, 96 W@133.83), slope ≈ 0.85 bpm/W,
intercept ≈ 52.26, R² ≈ 0.99997, protocol `bike-submax-70rpm` v3, quality
`high`. Machine provenance `proform-smart-power-10` v1 also persisted.
Thursday Threshold template remains `155–162` bpm. E1
(`extrapolationPolicy: "none"`) falls back with
`outside_observed_hr_range` because observed HR domain is only
≈118.5–133.8 bpm.

### Semantic problem

| Concept | What code actually says |
|---|---|
| Thursday `155–162` | Legacy template string in `data.json`, resolved by `resolveWorkoutPrescription` as `source: "legacy_fallback"`, `quality: "unverified"`, `explanationCode: "legacy_target_hr_bpm"`. Live runtime HR control authority. |
| `intensity_id: "threshold"` | Semantic phase label only — **not** lactate/ventilatory/FTP evidence. E4A names the E1 modality `legacy_hr_region_workload` and states it is not a personal physiological threshold. |
| E1 candidate watts | Read-only shadow: invert formal HR/workload line at the legacy HR band; “athlete-specific watts associated with that physiological region” for shadow evaluation — **not** active prescription. |
| Why in-domain only | Policy + docs: no extrapolation/clamping; assessment does not support equal confidence outside observed stages; estimator itself is submax-only. |
| `predictedMaxWatts` | Formal metric with derivation `demographic_hrmax_extrapolation`. Used for FitnessState/display; **not** consumed by E1 or ordinary-workout prescription. |
| Closest athlete-relative intensity | Phase D `descriptive_workload_trend_in_fixed_hr_window` (ordinary `aerobic_base`/`threshold` work) — explicitly descriptive, not prescription. |

Structural mismatch for this athlete: Tanaka 85% hard ceiling ≈ **149.4 bpm**,
so the formal assessment **cannot observe** the 155–162 band by design.
`outside_observed_hr_range` is therefore not a temporary acquisition gap; it
is the correct refusal of joining a submax calibration to a supra-ceiling
legacy HR band. Architecture review already separates these: use calibration
**inside its defensible range**; for hard intervals, resolve workload from an
**approved training-intensity policy** with HR as response/guardrail — and
explicitly lists “mapping `intensity_id` → % of predicted max” and “whether
predicted max watts is valid for prescription” as **unresolved open
questions** (must not be hidden in code).

Illustrative unrestricted linear inversion of the real fit (label only;
not a recommendation): 155 bpm → ≈121 W; 162 bpm → ≈129 W
(≈21–28 bpm / ≈25–33 W beyond observed max; >1× the observed HR span;
≈83–89% of predictedMaxWatts). Same arithmetic family as
`predictedMaxWatts` itself (line to demographic HRmax).

E1 model soundness:

1. **Aerobic-base:** conceptually sound **when** the legacy HR band lies
   inside the observed formal domain (local interpolation of measured
   steady-state points). Even Tuesday `115–130` slightly misses this
   athlete’s domain (115 < 118.5), so template/domain overlap is not
   automatic.
2. **Threshold:** not conceptually sound as “invert submax line at
   155–162.” That claims steady HR↔watt behavior above the protocol’s own
   validity ceiling and above all observed stages.
3. **Refusal:** protecting against an invalid extrapolation, not merely
   blocking a useful estimate.
4. **Defensibility of extrapolating to 155–162:** **No** under current
   evidence and repo policy. High R² on three submax points does not
   authorize supra-ceiling prescription.

### Candidate models

| | A. HR-calibration extrapolation | B. Predicted-max-relative intensity | C. Separate Threshold calibration / learning |
|---|---|---|---|
| Claim | Watts at legacy Threshold HR via formal line beyond observed domain | Ordinary workloads as fractions of `predictedMaxWatts` | Threshold watts learned/validated from ordinary Threshold work (or a dedicated threshold-oriented assessment), not derived from VO₂ submax inversion |
| Benefit | Reuses E1 math; would immediately fill the UI for Thursday | Anchors to existing athlete-relative max-power metric | Matches architecture hierarchy for hard work; uses Phase C/E2 held-workload evidence where the athlete actually trains; keeps submax calibration honest |
| Risk | Silent physiological overclaim; same family as demographic HRmax extrapolation; no open-loop Threshold evidence | Repo has **no** approved `% of predictedMaxWatts` mapping; docs call this an open physiology question; metric already marked `demographic_hrmax_extrapolation` | Advice unavailable until ordinary Threshold sessions accumulate; needs new provenance/resolver identity so it is not mislabeled as formal-calibration inversion |
| Scientific support in repo | Explicitly refused (`extrapolationPolicy: "none"`; assessment “does not support extrapolation with equal confidence”) | Explicitly unresolved; E1 docs say predicted max watts do **not** drive candidate math | Phase D already observes workload in fixed HR windows for `threshold`; E2/E3/E4A validate transfer of candidates but currently starve without E1 candidates; held-workload forward-response exists for descriptive open-loop-ish evidence |

If A or B shipped as “E1,” that would be a **materially different scientific
claim** and would need a **new resolver version**, **new provenance**,
**new quality/policy identifier** — not a silent flip of
`extrapolationPolicy`.

### Recommendation

**Choose model C for the next engineering experiment.**

Smallest defensible next step (not “allow extrapolation”): run ordinary
Thursday Threshold workouts under current legacy HR control, capture settled
measured watts while HR is in the legacy Threshold region (Phase C response +
held-workload / E2-style coverage gates), and design a **new** shadow advice
path — distinct resolver/provenance from E1 formal-calibration inversion —
that surfaces provisional athlete-specific Threshold watt advice only from
that ordinary-workout evidence. Keep formal VO₂ calibration for in-domain
interpolation (when template bands overlap) and for VO₂ / predicted-max
display. Treat initial advice / validated advice / active control as separate
gates (E4A remains scientific-only; no runtime authority).

### Non-goals (do not change yet)

- Do not enable E1 HR-line extrapolation or weaken `extrapolationPolicy`.
- Do not invent `% of predictedMaxWatts` intensity tables.
- Do not redefine `155–162` as a measured physiological threshold.
- Do not give shadow advice runtime/controller authority.
- Do not relax formal-assessment provenance, athlete/machine matching,
  measured-watt authority, quality gating, or fail-closed readers.
- Do not retarget the VO₂ protocol to reach Threshold HR (would abandon
  submax validity).

## Real Threshold evidence probe

Added 2026-10-11. Feasibility/evidence probe only; no resolver, E1, or
workout-control changes. On-device read via ADB WebView CDP into IndexedDB
`vo2_workout_db` + `fitness_state_v1` localStorage (read-only).

### Existing capture path

Ordinary Thursday Threshold finalization already persists enough structure
for Model C **if** a session reaches the legacy HR region:

| Need | Where stored today |
|---|---|
| workout intent `threshold` | `WorkoutSummary.intent` (+ day `Thursday`) |
| phase intensity `threshold` | `workout_response.phases[].intensityId` / `kind: work` |
| expected HR 155–162 | `phases[].expectedHeartRate` from legacy resolver |
| phase duration / coverage | `plannedDurationSec`, `completedDurationSec`, `hr`/`watts`/`cadenceRpm` summaries |
| measured watts | phase `watts.provenance: measured_watts` + raw `ordinary_bike_telemetry` |
| per-second HR | `hr_samples` |
| cadence quality | phase cadence summary + telemetry `cadenceRpm` |
| athlete / session | `athlete_id`, `external_session_id` |
| machine id + profile | `machine_id`, `machine_profile_version`; newer rows also `execution_provenance.machine` |
| E1/E2 shadow | optional; E1 Threshold was `fallback` / `missing_fitness_state` on historical rows |

Settled-window / held-workload math exists in E2 v3, but only for E1
**candidate** phases — historical Threshold E1 was fallback, so no usable
held-workload Threshold transfer evidence. Phase D
(`descriptive_workload_trend_in_fixed_hr_window`) can accept `threshold`
work after its gates (≥480 s planned/completed, ≥90% phase completion,
session completion ≥80%, HR/bike coverage, measured-watt coverage ≥80%,
cadence/stability, ≥4 measured sessions / ≥4 dates, and **after** the
formal FitnessState anchor). It is descriptive-only
(`eligibleForPrescription: false`); profile UI may show it; no runtime
prescription/control path consumes it.

**Verdict on capture:** telemetry/evidence capture is already sufficient to
*design* a new shadow resolver later. The gap is real-world Threshold HR
occupancy, not missing stores.

### Real device evidence

Athlete `afa677b3-9682-4fb9-8f7d-af77375975d7`, machine
`proform-smart-power-10` v1. Formal anchor
`2026-10-11T18:18:38.106Z`. `passiveAerobicObservation` / trend: **absent**.

**3** ordinary Thursday `intent=threshold` bike sessions (plus other workouts
that only touch `threshold` as Friday warmup subsections — not counted here):

| Session | Date | Outcome | Threshold work | HR in work | 155–162 occupancy | Phase D-style blockers |
|---|---|---|---|---|---|---|
| `d04a6bda-…` | 2026-09-28 | cancelled (~1 min) | 0 s | n/a | 0 s | cancelled, too short, no watts |
| `472d05fa-…` | 2026-10-01 | early cooldown (~19 min) | 25 s | median 117 (116–118) | **0 s** | low completion, fresh bike 0.68, phase_too_short |
| `4da2628c-…` | 2026-10-09 | early cooldown (~20 min) | 319 s | median 136 (119–157), end 155 | **23 s**; 15 fresh measured-watt samples in band (median **139 W**, 136–146) | low completion (0.58), phase_too_short (<480 s), watts coverage 0.77, unstable_workload |

All three ended **before** the formal VO₂ anchor, so Phase D would also
reject them with `not_after_formal_anchor` even if gates otherwise passed.
No session has phase-median HR inside 155–162. No defensible descriptive
Threshold workload aggregate exists.

### Sufficiency verdict

**Insufficient** to design/populate a new Model C shadow-advice resolver from
existing sessions. Capture path is ready; usable settled 155–162
measured-watt evidence is not. The Oct 9 fragment (≈23 s / 15 watt samples
@ ~139 W median) is illustrative only — not a prescription and not enough
for Phase D or a fail-closed shadow signal.

Next step is **not** “existing evidence → new resolver”; it is **one more
real Threshold workout that actually occupies the legacy HR band**.

### Next experiment

Run **one normal Thursday Threshold workout** under existing legacy HR
control, current telemetry unchanged (no E1/control/resolver changes).

Count as **usable evidence** only if all of the following hold (repo
thresholds, not new inventions):

1. Same athlete; bike; `intent=threshold`; ProForm machine identity recorded.
2. Session not cancelled; completion fraction ≥ **0.8**
   (`FITNESS_REFINEMENT_ALGORITHM_V2.minimumSessionCompletionFraction`).
3. Session HR coverage ≥ **0.75**; fresh bike coverage ≥ **0.75**.
4. Threshold **work** phase: planned and completed duration ≥ **480 s**,
   completion ≥ **0.9**, HR coverage ≥ **0.8**, measured-watt coverage ≥ **0.8**,
   cadence coverage ≥ **0.75**, and Phase D stability checks pass
   (or document the exact failing reason).
5. Phase median HR lands in/near the legacy band so a Phase D 2-bpm window
   can represent Threshold (target: median ∈ **155–162**), **and** raw
   join shows sustained time-in-band with fresh `measured_watts` (not
   calibrated-only) — avoid early cooldown before the band is reached.
6. Session ends **after** the current formal anchor so Phase D will not
   discard it as `not_after_formal_anchor`.

Record: session id, completed work seconds, time in 155–162, in-band
measured-watt median/min/max, cadence, coverage ratios, whether
`passiveAerobicObservation` appears after rebuild. Do **not** treat a single
qualifying session as multi-session Phase D readiness (still needs ≥4
sessions/dates for the aggregate). One good session is enough to prove the
evidence shape for designing the separate shadow resolver.

## First post-anchor Threshold evidence session

Added 2026-10-11; updated after the real post-anchor workout. Evidence
experiment only; no production code changed.

### Session identity

| Field | Value |
|---|---|
| Session | `85c5b25f-da21-43a5-9b02-592d9a3d8140` |
| Start / end | `2026-10-11T18:56:53.341Z` → `2026-10-11T19:17:01.295Z` |
| Athlete | `afa677b3-9682-4fb9-8f7d-af77375975d7` |
| Day / intent / activity | Thursday / `threshold` / bike |
| Machine | `proform-smart-power-10` profile v1 (execution provenance selected, unchanged) |
| vs formal anchor | after `2026-10-11T18:18:38.106Z` ✓ |
| Outcome | early cooldown; not cancelled; ~20 min wall |

### Qualification metrics

| Gate | Observed | Pass? |
|---|---|---|
| Session completion ≥ 0.80 | **0.572** (1202 / 2100 s) | no → `low_completion` |
| Session HR coverage ≥ 0.75 | 1.0 | yes |
| Fresh bike coverage ≥ 0.75 | 0.779 | yes |
| Work planned / completed ≥ 480 s | **302 / 302** | no → `phase_too_short` |
| Phase completion ≥ 0.90 | 1.0 | yes |
| Phase HR coverage ≥ 0.80 | 1.0 | yes |
| Measured-watt coverage ≥ 0.80 | **0.798** | no → `low_phase_workload_coverage` |
| Cadence coverage ≥ 0.75 | 0.798 | yes |
| Workload stability | (max−min)/mean = 0.577 | no → `unstable_workload` |
| Cadence stability | median 70, span 64–77 | yes |
| Phase median HR in 155–162 | **median 147** (128–159, end 159) | no |

E1 Threshold phase: `fallback` / `outside_observed_hr_range` (unchanged policy).

### 155–162 occupancy (work window)

- Seconds in band: **41** (longest consecutive **29**)
- Fresh measured watts in band: **n=39**, median **137 W**, range 127–153
- In-band cadence: n=39, median 71 rpm

### Phase D eligibility

Individually **not eligible** (`low_completion`, `phase_too_short`,
`low_phase_workload_coverage`, `unstable_workload`).
`passiveAerobicObservation` still **absent** (no aggregate change; ≥4
sessions would still be required even after one success).

### Conclusion: B — Capture succeeded, physiological occupancy insufficient

Telemetry/identity/provenance are healthy (athlete, ProForm, measured watts,
HR + fresh bike coverage). The athlete did not sustain the legacy Threshold
HR region long enough: early cooldown cut work to ~5 min, phase median stayed
at 147 bpm, and only ~41 s occupied 155–162. Do **not** treat the 137 W
in-band fragment as a descriptive Threshold workload signal or design input
for a shadow resolver yet.

### Next action

Repeat one normal Thursday Threshold under legacy HR control, avoid early
cooldown if safe/comfortable, and stay in 155–162 long enough to clear the
existing ≥480 s work + ≥0.80 completion gates with phase-median HR in band.

## Oct 16 Threshold evidence result

Added 2026-10-16. Analysis only; no production code changed.

### Session

| Field | Value |
|---|---|
| Session | `6f4612a2-fe0e-4976-9444-8dc1df81c141` |
| Start / end | `2026-10-16T14:29:48.416Z` → `2026-10-16T14:59:14.030Z` |
| Athlete | `afa677b3-9682-4fb9-8f7d-af77375975d7` |
| Day / intent / activity | Thursday / `threshold` / bike |
| Machine | `proform-smart-power-10` v1 (execution provenance selected) |
| vs formal anchor | after `2026-10-11T18:18:38.106Z` ✓ |
| Outcome | early cooldown; not cancelled; completion **0.818** |

### Work phase & 155–162 occupancy

Work window `sustain@600–1417` = **817 s** planned/completed (phase completion 1.0).

| Occupancy (per-second HR) | Value |
|---|---|
| Seconds HR ∈ [155,162] | **359** (44% of work) |
| Longest continuous streak | **189 s** |
| First / last in-band | 730 / 1410 |
| Phase HR median / min–max | **157** / 109–168 |

### In-band measured watts

Fresh `measured_watts` joined on in-band seconds only:

| Metric | Value |
|---|---|
| Sample count | **293** |
| Coverage of in-band seconds | **0.816** |
| Median / mean | **114 W** / 116 W |
| Min–max / MAD | 57–153 / 6 |
| In-band cadence median | 67 rpm (45–76) |
| In-band observed R | mostly R10 (251), some R12 (40) |

### Stable R10 interval

Controller path confirmed via decision audit: climb to R12 → decrease →
**six consecutive R10 `hold` evaluations** at 1110, 1170, 1230, 1290, 1350,
1410 (rep HR 162→157). Raw contiguous observed-R10 runs are short (**34 s**)
because bike telemetry has gaps, not because resistance left 10.

Audit-defined R10 hold region **1110–1417 (307 s)** with desired/commanded/
observed = 10 when present:

| Metric | Value |
|---|---|
| HR median / range | **159** / 148–164 (94% in-band) |
| Fresh measured watts | n=253, coverage 0.824, median **114 W**, 57–140 |
| Cadence median | 67 rpm |
| HR drift early→late | 160 → 157 (−3 bpm) |
| Whole-region watt stability ratio | 0.74 (fails Phase D ≤0.35) |

This is a **sustained settled Threshold-region response at R10**, not a brief
pass-through — HR occupancy and audit holds prove it; watt outliers still
spoil whole-window Phase D stability.

### Evidence gates (Phase D v2 / pre-registered)

| Gate | Observed | Pass |
|---|---|---|
| Athlete / bike / threshold intent | match | ✓ |
| Machine provenance | proform-smart-power-10@v1 | ✓ |
| Post-formal-anchor | ended 2026-10-16 | ✓ |
| Session completion ≥ 0.80 | 0.818 | ✓ |
| Session HR coverage ≥ 0.75 | 1.0 | ✓ |
| Fresh bike coverage ≥ 0.75 | **0.745** | ✗ `low_fresh_workload_coverage` |
| Work planned/completed ≥ 480 s | 817 / 817 | ✓ |
| Phase completion ≥ 0.90 | 1.0 | ✓ |
| Phase HR coverage ≥ 0.80 | 1.0 | ✓ |
| Phase measured-watt coverage ≥ 0.80 | **0.787** | ✗ `low_phase_workload_coverage` |
| Phase cadence coverage ≥ 0.75 | 0.787 | ✓ |
| Workload stability ≤ 0.35 | **0.829** | ✗ `unstable_workload` |
| Cadence span ≤ 25 | **34** (42–76) | ✗ `missing_or_unstable_cadence` |
| HR span ≤ 45 / \|end−median\|≤20 | span **59** | ✗ `unstable_hr` |
| Not cancelled | false | ✓ |

E1 Threshold: still `fallback` / `outside_observed_hr_range` (unchanged).

### Phase D eligibility

Individually **not eligible**. Exclusion reasons:
`low_fresh_workload_coverage`, `low_phase_workload_coverage`,
`unstable_hr`, `unstable_workload`, `missing_or_unstable_cadence`.

If it were eligible, Phase D would place phase median 157 into fixed window
**[156, 158)** with session watts median 116 — but no observation is written.
`passiveAerobicObservation` remains **absent** (this session rejected; aggregate
still needs ≥4 qualifying sessions/dates anyway).

### Conclusion: B — Occupancy proven, evidence quality still insufficient

Raw HR now establishes sustained 155–162 occupancy (359 s, streak 189,
median 157) with substantial in-band measured watts (~114 W). Existing
**whole-phase** Phase D quality gates still fail (fresh bike slightly under
0.75; phase watt coverage 0.787; ramp+settle inflates HR/watt/cadence spans).

### Resolver-design implication

**Yes — enough evidence *shape* to design** the separate Threshold shadow
resolver. This session proves ordinary Threshold workouts can occupy the
legacy HR band with measured watts under legacy control. Do **not** treat
Phase D whole-phase eligibility as the acceptance function for that resolver;
design settled in-band / R10-hold window provenance instead. Still only
one-session descriptive shape — not multi-session aggregate, not advice, not
control.

### Single next engineering step

Draft the Threshold shadow-advice evidence contract around **settled
in-band / post-overshoot R10-hold windows** (using this session as the
occupancy reference), separate from Phase D and from E1 inversion — without
implementing production advice yet.

## Threshold shadow-advice evidence contract

Added 2026-10-16; hardened 2026-10-16 against real session replay.
Contract design + pure admission module + tests only.
No workout-control, E1, Phase D, or advice-emission wiring.

Executable contract: `src/thresholdRegionSettledWorkload.ts`
Tests: `tests/thresholdRegionSettledWorkload.test.mjs` (focused contract suite).

### Evidence-window definition

A qualifying window is **not** “resistance == 10” and **not** the whole
Threshold work phase.

It is:

1. Ordinary bike `intent=threshold` / `intensityId=threshold` work phase;
2. same athlete; known machine id + profile version; session ended **after**
   the formal FitnessState anchor (malformed timestamps fail closed as
   `invalid_session_or_anchor_timestamp`);
3. legacy numeric HR target present;
4. a **controller-held resistance window** from the authoritative transition
   timeline (accepted actuation events + resistance-changing audit decisions;
   telemetry commanded/desired only as fallback when no transitions are known),
   trimmed by **fresh** contradictory `observedResistance`;
5. **post-settling** elapsed active seconds after
   `settlingSeconds=120` (reused from `PHASE_E2_HELD_WORKLOAD_POLICY_V1` —
   HR steady-state lag under held load);
6. controller corroboration: ≥1 machine audit `decision=hold` +
   `decisionReason=within_target_policy` in the post-settling span that
   **matches the window’s held resistance** (`resistanceBefore ==
   resistanceAfter == held`), `phaseKind=work`, and matching HR target
   bounds when present on the audit;
7. independent telemetry evidence on post-settling seconds: fresh
   **measured** watts + HR + **fresh measured** cadence coverage ratios, plus
   E2-style joint HR+measured-watt qualifying sample count.

Ramp / overshoot / correction segments either fail settling / qualifying
duration, lack matching target-hold corroboration, or are separate shorter
held-resistance windows — they are not merged into the settled hold window.

### Continuity correction

**Controller/load continuity** and **telemetry sampling continuity** are
separate:

| Concept | Meaning | Splits hold? |
|---|---|---|
| Controller hold | Same held resistance on the transition timeline | Only when a known controller transition changes resistance |
| Observed contradiction | Fresh `observedResistance ≠ held` | Yes — trim/split that span (fail-closed) |
| Telemetry gaps | Missing bike rows inside a hold | **No** — reduces coverage only |

Fail-closed join used by the contract:

```text
actuation/audit sustained hold interval
+ no fresh contradictory observed-resistance samples
+ sufficient fresh measured-watt coverage
+ sufficient fresh measured cadence coverage
+ sufficient HR coverage
+ matching resistance-scoped target-hold audit
```

`maxObservationGapSec=2` remains on the policy for E2 identity/compatibility
and `observationsAreContinuousForPolicy`, but it is **not** the hold-window
splitter. Do not widen the 2 s gap to “make Oct 16 pass.”

### Final continuity / freshness semantics

Added in the integrity harden pass (still design/shadow-only). Scientific
admission thresholds were selected later in v1 (see subsection below).

**Controller continuity source (authoritative order):**

1. Actuation events at a second (any outcome) own that second. Last event by
   ascending `commandId` decides the mark:
   - `accepted` → known held resistance
   - `failed` | `unavailable` | `timeout` | `pending` → **uncertain**
     (physical effect not established; aligns with PhaseActuationMode
     `unknown` for rejected/ambiguous commands)
2. Machine decision audit fills only seconds with **no** actuation event of
   any outcome (`work_phase_started` + `resistanceBefore !== resistanceAfter`).
3. Fallback only when the timeline has no known marks: sparse telemetry
   `commandedResistance` else `desiredResistance` (still cannot bridge
   uncertain marks).

Accepted actuation wins same-second disagreement with audit. Audit must not
manufacture a known transition at a second where execution provenance records
a non-accepted actuation attempt. Numeric resistance never decides provenance
precedence.

**Complete vs incomplete actuation capture:**

- Provenance **absent** (historical): audit/telemetry fallback allowed.
- `coverage=complete`: actuation timeline is authoritative.
- `coverage=incomplete`: identity fail-closed as
  `incomplete_actuation_provenance` (missing events possible; not the same
  claim as provenance absent).

**Uncertainty / re-establishment (Option C):**

- Uncertain marks are hard boundaries — R10 continuity cannot bridge through
  them (`ambiguous_actuation_provenance` when that prevents constructing any
  trustworthy candidate).
- After a non-accepted actuation makes controller state uncertain, telemetry
  and audit do not re-establish physical held state; a later accepted
  actuation does.
- Evidence entirely before the ambiguity, or after accepted re-establishment,
  may still qualify; a truncated pre-ambiguity window is not failed merely
  because ambiguity occurs later.

**Known transitions vs telemetry gaps:**

- Missing bike rows alone do **not** split a hold.
- A known R10→R11 (or R10→R11→R10) inside a gap **does** split/invalidate
  R10 continuity — sparse telemetry must not erase known controller changes.
- Same-resistance reconciliation resends are not transitions.

### Scientific admission thresholds v1

Selected and activated in `THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1`
(2026-10-16 selection pass). Completeness means single-session descriptive
observation emission is structurally allowed
(`thresholdRegionSettledPolicyIsProductionReady === true`). It does **not**
enable the shadow-advice resolver, UI advice, multi-session aggregation, or
active control.

| Field | v1 value | Denominator / statistic |
|---|---|---|
| `minInBandFraction` | **0.90** | `inBandCount / hrSampleCount` (valid post-settling HR samples only — not elapsed seconds, not joint watt seconds) |
| `maxMeasuredWattsMadRatio` | **0.10** | `MAD(fresh measured watts) / median(fresh measured watts)`; fail-closed if median ≤ 0 or ratio non-finite |
| `minAdviceGradeDurationSec` | **120** | Elapsed post-settling active seconds (`postSettlingDurationSec`); distinct from joint sample-count floor `minQualifyingSeconds=30` |

**Effective minimum hold:** ≈ `settlingSeconds` (120) + `minAdviceGradeDurationSec` (120) = **~240 s** of continuous controller-held resistance, plus coverage / joint / hold-corroboration gates.

#### Rationale (per gate)

**`minInBandFraction = 0.90`**

- *Scientific:* Requires a strong majority of measured HR evidence inside the
  legacy product control band before calling the held workload representative
  of that region. Rejects brief crossings, mostly-below / mostly-above holds,
  and oscillation through the band, while tolerating ordinary second-to-second
  HR noise. Does **not** treat 155–162 as measured lactate threshold or FTP.
- *Existing-system:* Complements resistance-matched `within_target_policy`
  hold corroboration (decision presence) with quantitative occupancy of the
  same band. Analogous in spirit to E2 `minSettledInBandSeconds`, but as a
  fraction of HR samples rather than a raw second count.
- *Empirical:* Oct 16 accepted window ~0.967 passes with margin. Oct 13
  resolved-gate window ~0.42 (HR median 163, mostly above band) fails
  occupancy — correctly classified *clearly poor* before thresholds.
- *Conservatism:* Intentionally rejects 0.80–0.89 occupancy that could still
  clear a looser majority.
- *Limitation:* Band width is product-specific; literature supports steady-state
  HR concepts, not this exact fraction.
- *Support class:* product-policy judgment, analogically constrained by
  submaximal steady-state HR practice (ACSM/YMCA: HR reaches steady state in
  ~2–3 min; consecutive-minute agreement ≤5 bpm is a different metric).

**`maxMeasuredWattsMadRatio = 0.10`**

- *Scientific:* Caps robust relative workload dispersion so the held interval
  is a stable workload observation. MAD/median resists isolated spikes better
  than (max−min)/mean.
- *Existing-system:* Reuses the same MAD/baseline ≤0.10 boundary used as
  **moderate** quality in `FITNESS_REFINEMENT_ALGORITHM_V2.projectionQuality`.
  Preferable here to Phase D’s whole-phase span gate (`(max−min)/mean > 0.35`).
- *Empirical:* Oct 16 MAD/median ≈ 0.053 (median 114 W, MAD 6 W) passes.
  Fresh measured-watt distribution (n=205): IQR 11, p10–p90 ≈ 100–122, min 57 /
  max 140; MAD remained representative despite low/high outliers
  (13 below median−3·MAD, 1 above median+3·MAD). Statistic retained.
  Oct 13 had very stable watts (MAD ratio ≈ 0.026) but fails occupancy — gates
  separate correctly.
- *Conservatism:* Rejects MAD/median > 0.10 (e.g. alternating 0.5×/1.5× median).
- *Limitation:* Indoor constant-load CV literature (~3% feedback-controlled
  pacing) is analogical; 0.10 is deliberately looser than “high” refinement
  quality (0.05) for ordinary-workout controller holds.
- *Support class:* existing-system reuse + analogically supported robust CV
  (MAD/median as robust relative dispersion).

**`minAdviceGradeDurationSec = 120`**

- *Scientific:* After the existing 120 s settling (HR/VO₂ kinetics to
  near-steady under constant load in ~2–3 min per ACSM-style guidance), require
  two additional minutes of elapsed settled evidence before the observation is
  sustained enough for future shadow-advice candidacy.
- *Existing-system:* Distinct from E2 `minQualifyingSeconds=30` (joint sample
  **count**) and from characterization-phase `minSettledInBandSeconds=15`.
  Symmetric with `settlingSeconds=120`.
- *Empirical:* Oct 16 post-settling 246 s passes. Oct 13’s 119 s would fail
  duration, but that window is already *clearly poor* on occupancy (~0.42) —
  duration was **not** chosen to reject Oct 13’s 119. Oct 11 sustain ≈ 302 s
  with ~60 s resistance steps never cleared settling on any hold (structurally
  no advice-grade window) — hunting workouts correctly fail closed.
- *Conservatism:* Rejects 30–119 s post-settling windows that may clear the
  joint-sample floor but are too brief for advice-grade sustainment.
- *Limitation:* Ordinary Threshold sustains that never hold one resistance for
  ≥~4 min cannot qualify; that matches the intended evidence class.
- *Support class:* analogically supported (ACSM/YMCA 3-min stages + 2–3 min
  steady-state onset) with product-policy judgment for the post-settling floor.

#### Real-session sensitivity (chosen combo 0.90 / 0.10 / 120)

| Session / case | Occupancy | MAD ratio | Duration | Result |
|---|---|---|---|---|
| Oct 16 `6f4612a2-…` | ~0.967 | ~0.053 | 246 s | **PASS** → observation emitted (descriptive only) |
| Oct 13 `01cbd92a-…` | ~0.42 | ~0.026 | 119 s | **FAIL occupancy** (also duration) |
| Oct 11 `85c5b25f-…` | n/a | n/a | 0 post-settle | no settled candidate (short stepped holds) |
| Brief pass-through | 0.55 | 0.04 | 200 s | FAIL occupancy |
| Mostly-outside stable | 0.72 | 0.05 | 200 s | FAIL occupancy |
| Stable HR, unstable watts | 0.95 | 0.22 | 200 s | FAIL workload stability |
| Stable watts, short duration | 0.95 | 0.05 | 45 s | FAIL duration |

#### Still unresolved (out of scope for this pass)

- Multi-session aggregation threshold
- Shadow-advice resolver behavior / UI wording
- Active-control authority

**Cadence freshness:** admission counts only
`availability === "fresh"` + `cadenceRpm.source === "measured"`.
(Producer/parser already forbid cadence metrics on stale/unavailable rows;
the evaluator now fail-closes against malformed rows that still carry them.)
Previously the contract could count cadence whenever `cadenceRpm` existed.

**Observed-resistance freshness (rule B):** only **fresh**
`observedResistance` may contradict the controller-held state. Stale/
unavailable observed values are ignored (producer never emits metrics on
those rows).

**Field naming:** output/evaluation field renamed
`observedResistance` → `heldResistance` (controller-held claim;
observed resistance is corroboration/contradiction only). Unshipped design
schema — no version bump.

**Oct 16 start at 1051 not 1050:** commanded/actuated R10 at 1050, but fresh
observed resistance was still R11 that second; first non-contradictory R10
evidence begins 1051. Locked by regression.

**Integrity-harden Oct 16 replay** (with actuation transitions): unchanged
under resolved gates — window 1051–1417, held R10, settledFrom 1171,
post 246 s, joint 205, HR med 158 / in-band ~0.967, watts 114/MAD 6,
watt cov 0.833, cadence 67 / 0.833, holds 1230/1290/1350/1410.

### Contract corrections

- **Hold-audit resistance matching:** a hold at resistance X cannot
  corroborate a window held at Y. Also require `phaseKind=work` and
  matching `targetHeartRateMin/Max` when present. `phaseId` is not required
  (work-phase ids vary; `phaseKind` already scopes to work).
- **Timestamps:** invalid `sessionEndedAt` / `formalAnchorObservedAt` fail
  closed via `invalid_session_or_anchor_timestamp` (previously `Date.parse`
  → `NaN` could silently skip `pre_formal_anchor`).
- **`minQualifyingSeconds`:** matches E2 held-workload meaning — minimum
  **count of joint HR + fresh measured-watt seconds** in the post-settling
  window (≥30), not merely elapsed span length. Elapsed post-settling
  duration remains the coverage denominator and the
  `minAdviceGradeDurationSec` basis.

### Required evidence

| Requirement | Source / threshold | Failure code |
|---|---|---|
| Athlete match | identity | `athlete_mismatch` |
| Activity bike | summary | `activity_not_bike` |
| Intent/intensity threshold | summary / phase | `intent_not_threshold` / `intensity_not_threshold` |
| Machine id + profile version | summary / execution provenance | `missing_machine_provenance` |
| Valid timestamps | `Date.parse` finite | `invalid_session_or_anchor_timestamp` |
| Post-formal-anchor | `endedAt` > formal `observedAt` | `pre_formal_anchor` |
| Numeric legacy HR target | resolved prescription | `missing_numeric_hr_target` |
| Controller-held resistance window | actuation/audit transitions (else commanded/desired) + fresh non-contradictory observed | `no_stable_resistance_window` |
| Settling 120 s | E2 held-workload policy | (consumed into duration) |
| Min joint HR+watt qualifying samples ≥30 | E2 `minQualifyingSeconds` (sample count) | `insufficient_post_settling_duration` |
| HR coverage ≥0.80 | E2 / Phase D | `insufficient_hr_coverage` |
| Measured-watt coverage ≥0.80 | E2 / Phase D measured | `insufficient_measured_watt_coverage` |
| Measured watts only | telemetry `source` | `non_measured_watt_provenance` |
| Fresh measured cadence coverage ≥0.75 | Phase D + fresh/measured gate | `insufficient_cadence_coverage` |
| Resistance-matched target-hold audit | machine decision audit | `missing_target_hold_corroboration` |
| Min in-band HR fraction ≥0.90 | scientific admission v1 | `insufficient_in_band_occupancy` |
| Max MAD(watts)/median ≤0.10 | scientific admission v1 (refinement moderate MAD) | `unstable_measured_workload` |
| Advice-grade elapsed duration ≥120 s | scientific admission v1 (post-settling elapsed) | `insufficient_post_settling_duration` |

With all three scientific thresholds set, `policyProductionReady=true` and a
qualifying window may emit a **descriptive** observation
(`eligibleForPrescription=false`, `quality=unverified`).

### Robust workload statistic

Primary descriptive workload: **median fresh measured watts** in the
post-settling window (`canonicalMedian`).
Dispersion: **MAD** (`medianAbsoluteDeviation` from `performedLoad`) — already
used descriptively in Phase D aggregates. Prefer MAD/median over Phase D’s
whole-phase (max−min)/mean span, which punishes ramp+settle phases and rare
outliers (Oct 16 lesson).

### Output semantics (single qualifying session)

Schema: `threshold-region-settled-workload-observation@1`
Provenance: `ordinary_workout_settled_threshold_region`
Resolver id (future): `threshold-region-ordinary-workout-shadow-resolver@1`
(not `personalized-prescription-resolver`).

One accepted window may become a **descriptive** observation:

- `interpretation: "descriptive_observation_only"`
- `eligibleForPrescription: false`
- `quality: "unverified"` until multi-session policy exists
- records window bounds, `heldResistance` (controller-held fact, not a
  constant), HR median / in-band fraction, measured-watt median+MAD, cadence,
  machine, formal anchor

This is **not** a physiological Threshold / FTP / lactate claim and **not**
active control.

### Single-session vs multi-session

| Stage | Allowed now? |
|---|---|
| Single qualifying settled window | yes |
| Single-session descriptive observation | yes (descriptive only; thresholds v1 set) |
| Provisional shadow **candidate advice** in UI | **not yet** — needs product decision |
| Multi-session aggregate | **UNRESOLVED** — do **not** auto-reuse Phase D’s 4 sessions/dates |
| Validated advice / active control | no (E4+) |

One session establishes evidence **shape**, not multi-session confidence.

### Resolver boundary

| Path | Claim |
|---|---|
| E1 | Invert formal submax HR/watt calibration at legacy HR (in-domain only) |
| Phase D | Whole-phase descriptive trend in a fixed 2-bpm HR window |
| This contract | Settled ordinary-workout measured watts while controller holds in Threshold HR region |

### Real-session replay

First implementation (observed-resistance `segmentStableResistance` +
`maxObservationGapSec=2`) was replayed against real on-device session
`6f4612a2-fe0e-4976-9444-8dc1df81c141` via read-only ADB/WebView CDP.

**Result: rejected.** Identity passed, but the sustained R10 controller hold
(~1051–1417) fragmented into many short observed-resistance runs (largest
contiguous observed-R10 fragment ≪ 120 s), so every window had
`postSettlingDurationSec=0` and failed
`insufficient_post_settling_duration` (and related coverage / hold gates).
Synthetic dense fixtures had falsely suggested acceptance.

### Real Oct 16 result

After the continuity correction and scientific-threshold activation, the same
real session accepts **one** window and emits a descriptive observation:

| Field | Value |
|---|---|
| Window | 1051–1417 (exclusive end) |
| Held resistance | 10 |
| Settled from | 1171 |
| Post-settle elapsed | 246 s |
| Qualifying joint HR+watt samples | 205 |
| HR median / in-band | 158 bpm / ~0.967 (≥ 0.90) |
| Measured watts median / MAD | 114 W / 6 (MAD/median ≈ 0.053 ≤ 0.10) |
| Measured-watt coverage | 0.833 |
| Cadence median / coverage | 67 / 0.833 |
| Matching controller holds | 1230, 1290, 1350, 1410 |
| Admission vs scientific v1 | **PASS** (all three gates) |
| Observation | emitted; `descriptive_observation_only`; `eligibleForPrescription=false`; `quality=unverified` |

(Hold audits at 1110 and 1170 are correctly excluded: 1170 is before
settledFrom 1171; 1110 is inside settling.)

### Fixtures

- **Synthetic dense fixture:** every-second telemetry; labeled synthetic —
  useful for gate logic, not an Oct 16 replay.
- **Real-gap-shaped fixture:** sustained controller hold + intermittent
  2–4 s bike gaps + consistent observed resistance when present; preserves
  the fragmentation bug pattern without dumping every raw session row.

### Non-goals

- No E1 extrapolation / `% predictedMaxWatts` / VO₂-line to 155–162
- No Phase D gate reuse as acceptance function
- No hardcoded resistance/watt/athlete/machine-table constants
- No runtime controller authority
- No physiological Threshold naming
- No resolver / UI advice / active-control wiring (thresholds enable
  descriptive observation emission only)

## Provenance of claims

- **Code:** all module behaviors above were read from `src/` this session
  (paths cited inline).
- **Tests:** file inventory + staged test diffs read; suite **not executed**
  (it rebuilds `dist/`, which this task forbids changing beyond the report).
- **Real evidence:** the R6/R7/hr_safety session as quoted in
  `src/vo2AdaptivePlanner.ts` comments; no live workout was run.
- **Inference:** anything labeled "Inference" above, plus the end-to-end
  verdict for a hypothetical successful v3 session (no such session observed).
- **Replay (2026-10-11 section):** real staged planner + real classifier via
  `dist/` imports; synthetic HR curves and session loop modeled as described.
  Harness was throwaway, kept outside the repo; no production code executed
  beyond the planner/classifier pure functions.
- **On-device (2026-10-11 Threshold model section):** live WebView
  `localStorage` read of promoted `fitness_state_v1` / machine provenance
  after the successful v3 session; Threshold model conclusions are from
  code + that persisted calibration, not from a Thursday workout run.
- **On-device (2026-10-11 Threshold evidence probe):** read-only CDP into
  IndexedDB `vo2_workout_db` (`workouts`, `hr_samples`,
  `ordinary_bike_telemetry`) for the three Thursday Threshold sessions
  above; app was restarted once only to restore a wedged WebView DevTools
  socket (no data writes).
- **On-device (2026-10-16 Threshold session):** read-only CDP into the same
  IndexedDB stores + `machine_decision_audit` for session
  `6f4612a2-fe0e-4976-9444-8dc1df81c141`; app restarted only to restore a
  wedged DevTools socket (no data writes).
- **Contract (2026-10-16):** pure module
  `src/thresholdRegionSettledWorkload.ts` + focused tests; reuses E2
  held-workload settling and existing median/MAD helpers; no
  resolver wiring into workout start/UI/control.
- **Contract harden (2026-10-16):** read-only CDP replay of session
  `6f4612a2-…` against the evaluator before/after continuity correction;
  hold-resistance matching, timestamp fail-closed, and E2 joint-sample
  `minQualifyingSeconds` semantics verified.
- **Integrity pass (2026-10-16):** cadence/observed freshness aligned with
  ordinary telemetry producer; actuation+audit transitions fail-closed across
  telemetry gaps; `heldResistance` rename; Oct 16 CDP replay unchanged.
- **Scientific admission thresholds v1 (2026-10-16):** read-only CDP analysis
  of Oct 11 / Oct 13 / Oct 16 Threshold sessions + Oct 16 watt distribution;
  ACSM/YMCA steady-state timing and fitness-refinement MAD quality analogs;
  activated `0.90` / `0.10` / `120`; Oct 16 admits descriptive observation.
