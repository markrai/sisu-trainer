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
