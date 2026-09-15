# Computer-use automation for legacy back-office software

An AI agent is given a goal in English. It drives a legacy banking UI that has
no API, working from what a screen reader would perceive rather than from
markup. The successful run is compiled into a **typed, versioned capability
artifact**, and from then on that capability replays **deterministically with no
model in the decision loop** — returning typed outputs, distinguishing
legitimate business outcomes from recoverable conditions and hard failures, and
handing control to a human when it should not proceed alone.

The target is a deliberately hostile mock: a 2003-era frameset with table
layout, no ids, no test hooks, and not a single `<label for>` on the whole
sign-on form.

---

## Setup

Requires **Node 22 or newer**.

```bash
npm install
npx playwright install chromium
```

> If `npx playwright install` times out, its downloader enforces a hard 30
> second limit that some connections cannot meet. Fetch the two Chromium
> bundles by hand into your Playwright browsers directory instead — headless
> runs need `chromium_headless_shell` as well as `chromium`.

## Running it without any live services

**No API key is needed for anything below.** The target application is a local
mock, and replay never calls a model — that is the point of the artifact. A key
is only required for a live `discover` run.

```bash
npm run verify
```

That typechecks, scans for secrets, and runs the full suite: **175 tests
across ten files**. The mock bank boots in-process on an OS-assigned port, so
there is no second terminal to start and nothing to collide with.

What those tests actually demonstrate, against a real browser and a real server:

| Area | What is proven |
| --- | --- |
| Perception | Controls found across two frames; **every input on the sign-on form has no accessible name** and is reachable only via its adjacent label cell |
| Safety | Off-allowlist navigation refused; a nav link into an excluded screen contained and reverted; irreversible actions denied unattended and escalated when attended |
| Data handling | SSNs redacted out of screen text, node names and anchors before anything sees them; sensitive regions masked in the *first* screenshot of a screen; a typed password never captured |
| Prompt injection | A hostile member record instructs the agent to exfiltrate an SSN, open the admin screen and move money. Every step is refused at the choke point |
| Artifact | The reference capability validates; undeclared parameters, secret outputs and PII examples are rejected; tenant binding remaps labels and reports version drift |
| Replay | Happy path with typed outputs; two business outcomes; two recovery paths; a hard failure with a screenshot; the same artifact run against a second institution |
| Discovery | A scripted model drives the live target; the compiler emits an artifact; that artifact replays for a **different member** with no model in the loop. Budgets, refusals, stalls and `type_secret` are pinned without a provider |
| Escalation | The automation cannot act while a person holds the session; the person works on the page the run stopped on; the run does not take their word that they finished |
| CLI | Unknown flags rejected; catalog refuses to publish an invalid artifact; the operator console requires a name to attach and has no "approved, you do it" disposition |

### Looking at the target application yourself

```bash
npm run target          # institution A, http://127.0.0.1:4173
npm run target:b        # institution B, http://127.0.0.1:4174
```

Sign on with `operator` / `demo1234` — printed on the sign-on screen, because it
is a fake bank with fabricated members. Member `100245` is the happy path,
`999999` does not exist, `100247` is entitlement-restricted, and `100250`
carries the prompt-injection payload.

Both ports run the *same vendor product* with different branding, wording and
version. That is the multi-tenant story: one artifact, two institutions, no
re-recording.

Faults can be injected to exercise the error paths:

```bash
curl -X POST http://127.0.0.1:4173/_admin/faults \
  -H 'content-type: application/json' \
  -d '{"kind":"session_expired","count":1,"onPath":"/member/"}'
```

`session_expired`, `app_error`, `slow`, `interstitial` and `permission_denied`
are available, each with a consumption budget so a fault can be genuinely
transient.

## The four commands

Start the target first (`npm run target`). Replay and catalog need no key.
Discovery needs one.

```bash
# What a calling agent is handed: typed tools, declared outcomes, approval state.
npm run catalog
npm run catalog -- --json

# Deterministic replay. No model is reachable from this path.
npm run replay -- --capability meridian.member.read-savings-balance --input memberId=100245
npm run replay -- --capability meridian.member.read-savings-balance --input memberId=999999
npm run replay -- --capability meridian.member.read-savings-balance --input memberId=100245 --fault session_expired:1:/member/

# A person takes a session an attended replay has stopped on.
# In a second terminal, once the run prints the console URL:
npm run operator

# A live model drives the UI and the run is compiled into an artifact.
# Requires a key in .env (npm run set-key).
npm run discover -- --capability meridian.member.read-savings-balance \
  --goal "Look up member {memberId} and read their current savings balance" \
  --input memberId=100245
```

Replay exit codes preserve the four-way result: `0` success, `2` a declared
business outcome, `3` escalated and not resumed, `1` failed. Collapsing outcome
into failure at the command line would undo the distinction the result type
exists to make.

Attended replay (the default) starts an operator console. When the run stops,
it prints `npm run operator -- --url ...` and waits. Unattended replay
(`--unattended`) records the intervention and expires it immediately — a run
that needed a human and could not have one, rather than a silent failure with
a different name.

## Evidence

Recorded runs live in [`evidence/`](evidence/). The one the brief makes
mandatory is the Groq discovery run against the live target, compiled into a
capability:

- `evidence/2026-09-15T05-12-16-443-discovery-meridian.member.read-savings-balance-79287c94/`

Replay evidence next to it covers success, a `MEMBER_NOT_FOUND` business
outcome, a hard failure, and a session-expiry escalation that a person signed
back on. The callable copy of the reference artifact is
`artifacts/meridian.member.read-savings-balance.json`.

## Keys

Copy `.env.example` to `.env` and fill in **one** provider key. Put it in
`.env`, never in `.env.example` — the example file is tracked, the real one is
not. `npm run set-key` is the safer way: it writes `.env` without echoing.

```bash
cp .env.example .env
npm run set-key
npm run env -- --ping
```

No credential is ever written into an artifact, a log or the evidence
directory. A capability records the *name* of a secret and resolves it at run
time, which is what makes a sign-on flow safe to commit to a public repository.

That is enforced rather than promised. A pre-commit hook, installed
automatically by `npm install`, scans every tracked and staged file for
credential shapes and refuses the commit if it finds one. The same scan runs
inside `npm run verify`, and inside `evidence/` it also looks for regulated
values — SSN shapes and card-length digit runs — which are allowed in the mock
bank's fixtures, because redaction needs something to redact, but never in a
recorded run.

```bash
npm run check:secrets
```

## How it is put together

```
src/surface/     perceive and act on a surface. The seam to desktop/mainframe.
src/policy/      allowlist, risk classification, redaction. Enforced in act().
src/artifact/    the capability contract: schema, validation, tenant binding.
src/agent/       discovery loop and the trace-to-artifact compiler.
src/replay/      deterministic execution. Imports nothing from src/llm/.
src/hitl/        control state machine. One holder, one token, act() checks it.
src/llm/         provider interface. Discovery only.
src/evidence/    JSONL run log, screenshots, observations. Redacted at the door.
src/cli/         discover, replay, catalog, operator.
targets/meridian a hostile mock back-office, in two tenant configurations.
docs/            design decisions.
```

Three ideas carry the whole design, each argued with its alternatives in
[`docs/DECISIONS.md`](docs/DECISIONS.md):

**Perception is an accessibility-style graph, never markup.** The model only
ever sees `(nodeId, role, name, value, state)` plus adjacency evidence. There is
no selector anywhere in the artifact schema. That is what makes a desktop
application a new `Surface` implementation rather than a rewrite.

**The artifact is a callable contract, not a step list.** Typed inputs, typed
outputs, a success checkpoint, and declared *business outcomes* as first-class
schema — so "no such member" comes back as an answer with a code, not as an
exception a caller has to parse.

**One choke point.** Every action from both discovery and replay passes through
`Surface.act()`, and that is where the allowlist and the risk classification are
enforced. A guardrail written into a prompt is a request; this one is a control,
which is why the injection tests assume the model is fully persuaded and check
that it makes no difference.

## Documents

- [`REPORT.md`](REPORT.md) — architecture, schema, determinism, multi-tenant,
  escalation, safety, and what was cut. The seven headings the brief asks for.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — the long form of those choices,
  each with the options considered, the choice, why, and what would invalidate
  it.
