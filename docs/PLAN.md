# Plan and current status

Working document. Tracks what the assignment demands, what has been built,
what is verified, and what comes next, so work can resume cold without the
surrounding conversation.

This is scaffolding, not a deliverable. Decide before submission whether to
keep it (see "Before submitting" at the bottom).

**Repo**: `C:\Users\SKB\projects\computer-use-automation`
**Last updated**: after Phase 2

---

## 1. The assignment in one paragraph

Build the layer that gives an AI agent hands inside legacy back-office banking
software that has no API. A goal in natural language is handed to an LLM, which
drives a real UI to accomplish it. The successful run is compiled into a typed,
versioned *capability artifact*. That artifact then replays deterministically
with no model in the decision loop, returning typed outputs and distinguishing
legitimate business outcomes from recoverable conditions and hard failures.
When the system cannot safely proceed, it escalates to a human who takes
control of the *same live session* and hands control back.

Deliverables: public GitHub repo, `/README.md`, `/REPORT.md` (seven prescribed
headings), `/evidence/`. Emailed to assignments@interface.ai with the repo URL
on its own line.

## 2. Constraints taken directly from the brief

- **Only one thing is mandatory**: at least one genuine LLM-driven discovery run
  against a live surface, with evidence in `/evidence/`. Everything else may be
  stubbed at a clean, documented seam.
- Graded, roughly in order: system design (artifact schema and replay contract
  are called "central"), correctness of the core loop, robustness and error
  handling, human-in-the-loop escalation, generalization to heterogeneous
  surfaces and multiple tenants, safety and data handling, code quality,
  communication.
- Explicitly *not* rewarded: feature breadth, framework name-dropping, building
  scaling infrastructure (queues, clusters, multi-tenant plumbing).
- Prefer a thin-but-real version of every core requirement over a polished
  subset. Say what was cut and why.
- AI-assisted development is assumed and encouraged. The flip side: every line
  must be defensible in detail.
- No real bank systems, no real credentials, no real PII. Keep secrets out of
  the repo.
- The interesting replay failures are *runtime conditions*, not layout drift:
  validation errors, record-not-found, permission denials, unexpected dialogs,
  session expiry, transient slowness, app errors.

## 3. Shape of the solution

Chosen stack: TypeScript, Node 24, Playwright, Zod, Express. Single process,
CLI-driven, file-backed stores. Rationale for each choice is in
`docs/DECISIONS.md`.

Pipeline:

```
goal + target
   -> discovery: LLM observe/decide/act loop over a Surface
   -> compiler: trace -> typed capability artifact (NOT a transcript dump)
   -> replay: deterministic execution, no model in the decision loop
   -> result: success+outputs | business outcome | escalation | hard failure
   -> escalation: human takes the live session, then hands it back
```

Module layout under `src/`:

| Module     | Responsibility                                                        | Status |
|------------|-----------------------------------------------------------------------|--------|
| `surface/` | Perceive and act on a surface. The seam to desktop/legacy.            | done   |
| `policy/`  | Allowlist, risk classification, redaction. Enforced inside `act()`.   | done   |
| `artifact/`| Zod schema, versioning, canonicalization, tenant overlays.            | done   |
| `agent/`   | Discovery loop and the trace-to-artifact compiler.                    | next   |
| `replay/`  | Locator ladder, checkpoints, error taxonomy, result contract.         | todo   |
| `hitl/`    | Session broker, control token, interventions, operator console.       | todo   |
| `evidence/`| Structured JSONL logging, screenshots, redaction at the boundary.     | todo   |
| `llm/`     | Provider interface (Anthropic / OpenAI / Gemini / mock).              | todo   |
| `cli/`     | `discover`, `replay`, `catalog`, `operator`.                          | todo   |

`targets/meridian/` is the mock target app. It is a stand-in, not part of what
is graded, and is intentionally unpolished.

### The three ideas the submission rests on

1. **Perception is an accessibility-style UI graph, never markup.** The model
   and the artifact see role, accessible name, value, state and adjacency
   evidence. There is no `selector` field anywhere in `UiNode`. This is what
   makes a desktop surface a new `Surface` implementation rather than a
   rewrite, and it is the honest answer to "bias toward an approach that works
   with no clean DOM".

2. **The artifact is a callable contract, not a step list.** Typed inputs,
   typed outputs, a success checkpoint, and — the part that matters most —
   declared *business outcomes* modelled as first-class results rather than
   errors. The brief's glossary names conflating those two as the most common
   design mistake on this project.

3. **Targeting is a ranked ladder that reports degradation.** role+name, then
   anchor-relative, then structural, then coordinates. A unique match is
   required, so ambiguity becomes an explicit error instead of a silent wrong
   click. Recording *which* rung resolved turns the ladder into drift detection,
   which is the multi-tenant story.

## 4. Phase status

- [x] **Phase 0 — Toolchain, skeleton, decision log.** Commit `2cfb9ec`.
- [x] **Phase 1 — Target app.** Commit `88c2cb5`.
- [x] **Phase 2 — Surface + policy choke point.** Commit `39a13c7`.
- [x] **Phase 2.5 — Hardening pass.** Commit `64a7d49`. Six defects found by
      writing tests against the claims in `DECISIONS.md`; see D9, D10 and D13.
      `npm test` is now a real vitest suite over an in-process target.
- [x] **Phase 3 — Artifact schema.** Commit `d662652`. Designed *before* the
      agent loop, so the loop targets the contract rather than the contract
      being reverse-engineered from whatever the loop emitted.
- [ ] **Phase 4 — Discovery loop + compiler + real LLM run.** Needs an API key.
- [ ] **Phase 5 — Replay engine + error taxonomy.** Produces three evidence
      runs: success, business outcome, injected failure.
- [ ] **Phase 6 — Human-in-the-loop control transfer.**
- [ ] **Phase 7 — Stretch goals, README, REPORT, defend pass.**

Stretch goals selected (at most two, per the brief): the **agent-facing
capability catalog** (artifacts exposed as callable typed tools) and
**cross-tenant reuse** (one artifact replayed against tenant B via overrides).
Possibly a multi-run stability score feeding a `draft -> approved` gate, which
is roughly thirty lines.

## 5. What is verified working

`npm test` — 71 tests, four files, no second terminal and no fixed ports. The
target app runs in-process on an OS-assigned port, so a developer's own
`npm run target` on :4173 cannot collide with a test run.

- **Perception** (`tests/perception.test.ts`): controls discovered across
  `navFrame` and `contentFrame`; buttons and links resolve by role+name;
  **every input has `name=""` and is reachable only via its adjacent label
  cell**; the savings balance is read back by locating the cell via its row
  context; stale node ids are rejected rather than silently addressing a
  detached element.
- **Safety** (`tests/safety.test.ts`): off-allowlist navigation refused as a
  typed value; a nav-frame link to an off-allowlist route is contained and
  reverted; irreversible actions denied unattended and escalated when attended;
  SSNs redacted out of observation text, node names and anchors before anything
  can see them; the redacted cell marked sensitive and refused by `read`;
  sensitive regions masked in the *first* screenshot of a screen; a typed
  password never captured.
- **Policy** (`tests/policy.unit.test.ts`): route-pattern boundaries, the
  mode matrix for irreversible actions, and the redaction patterns — including
  the concatenated-text case that a `\b`-anchored pattern misses.
- **Artifact** (`tests/artifact.test.ts`): the reference capability validates;
  referential integrity rejects undeclared params, absent overlay steps,
  self-recovering capabilities, secret outputs and PII examples; path
  canonicalisation round-trips; tenant binding remaps labels without mutating
  the base and reports version drift; the catalog tells a calling agent which
  outcomes are legitimate.

Target app behaviour, exercised through the above: happy path returns Dana
Whitfield's `$4,182.55`; unknown ID gives "no member found"; malformed ID gives
a *distinct* validation error; restricted member returns 403; injected
session-expiry fires and then self-heals on the next request (faults carry a
consumption budget, so "transient" is genuinely expressible).

## 6. Next actions, in order

1. `src/replay/` — build this *before* discovery. The reference artifact in
   `tests/fixtures/readSavingsBalance.ts` is a complete, validated capability,
   so replay can be built and tested end to end against it with no model and no
   API key. Doing it in this order also means the discovery compiler has a
   working consumer to target rather than a guess.
   - `resolve.ts` — walk the `TargetDescriptor` ladder against an observation,
     require a unique match, report which rank resolved.
   - `checkpoint.ts` — evaluate the predicate algebra.
   - `extract.ts` — apply `ExtractionRule` and transforms.
   - `execute.ts` — the loop: bind tenant, validate inputs against `ParamSpec`,
     step, checkpoint, recover, detect outcomes, assert success, emit
     `ReplayResult`.
2. `src/evidence/` — JSONL run log, screenshots, observation dumps, written
   through the redaction boundary. Needed by both replay and discovery.
3. `src/llm/` — provider interface plus a `mock` provider that replays a
   recorded transcript, so a reviewer with no key can still exercise discovery.
4. `src/agent/loop.ts` — observe, compact for the model, decide via tool
   calling, policy-check, act, append to trace. Stop on success, max steps,
   timeout, or dead-end.
5. `src/agent/compile.ts` — trace to artifact. Drops exploratory dead ends,
   promotes goal values to typed params, canonicalizes routes (the helpers in
   `src/artifact/canonical.ts` already exist), builds target ladders, and makes
   **one** out-of-loop model call to propose intents, parameter names, output
   schema and candidate outcomes, validated against the Zod schema. Authoring
   metadata with a model is fine; deciding at replay time is not.
6. `src/hitl/` — control state machine and operator console.
7. `src/cli/` — `discover`, `replay`, `catalog`, `operator`. Note that
   `package.json` already references these; they do not exist yet.
8. README, REPORT, evidence, recording.

## 7. Environment notes (this machine)

These cost real time; they are recorded so they are not rediscovered.

- **Node is portable, not installed.** `%LOCALAPPDATA%\Programs\node-v24.21.0-win-x64`,
  added to the *user* PATH. A `winget` MSI install hung for 12 minutes on an
  invisible elevation prompt and was abandoned. Open a fresh terminal for
  `node` to resolve.
- **Playwright browsers were installed by hand.** Its downloader enforces a
  hard 30s timeout and this connection needs ~2 minutes for the bundles. Both
  were fetched with `Invoke-WebRequest -TimeoutSec 0` and extracted into
  `%LOCALAPPDATA%\ms-playwright\`, each with an `INSTALLATION_COMPLETE` marker:
  `chromium-1243` (205 MB) and `chromium_headless_shell-1243` (120 MB).
  Headless needs the second one; a plain `npx playwright install` will fail.
- **`frame.evaluate(fn)` cannot take the collector directly.** The TypeScript
  loader compiles named inner functions with esbuild's `keepNames` helper, so
  the serialised source calls `__name`, which does not exist in the page.
  `uiGraphExpression()` wraps the source in an IIFE declaring its own `__name`.
  Symptom if this regresses: `ReferenceError: __name is not defined`.
- **npm 11 blocks postinstall scripts.** `esbuild` (and so `tsx`) needs
  `npm install-scripts approve esbuild`.
- **PowerShell here is old enough to reject `&&`.** Chain with `;` instead.
  This is why `npm run target:b` passes `--tenant b --port 4174` as flags
  rather than using a `VAR=x cmd` prefix, which would not be portable anyway.
- **Zod is on v4** (upgraded from the 3.25 line, which ships both). Nothing
  depended on v3 at the time, so this was free, and it gets us `z.toJSONSchema`
  if the artifact envelope ever needs to publish its own schema.

## 8. Before submitting

- [ ] Decide whether `docs/PLAN.md` stays. It is honest working material, but
      it is not a requested deliverable and partially duplicates `REPORT.md`.
- [ ] `REPORT.md` must use the seven prescribed headings verbatim: Architecture;
      Artifact schema; Determinism & error handling; Heterogeneity &
      multi-tenant; Escalation & handoff; Safety; Cuts.
- [ ] `/evidence/` contains the artifact, a discovery run, a successful replay,
      a business-outcome replay, and a failure replay.
- [ ] README documents setup, keys, the exact demo commands, and how to run
      without live services.
- [ ] No `.env`, no keys, no real PII anywhere in history.
- [ ] Public repo. Email from the address used to apply. URL on its own line.
      No zip.
