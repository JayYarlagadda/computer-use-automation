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

> **Status.** Work in progress. The perception layer, the safety guardrails, the
> artifact contract and the replay engine are complete and tested end to end
> against the live target. The discovery loop, the human-in-the-loop console and
> the CLI are not built yet, so the demo path below covers replay rather than
> the full round trip. See [`docs/PLAN.md`](docs/PLAN.md) for exactly what is
> done and what is next.

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
is only required for a discovery run, which is not yet wired up.

```bash
npm run verify
```

That typechecks and runs the full suite: **101 tests across five files**. The
mock bank boots in-process on an OS-assigned port, so there is no second
terminal to start and nothing to collide with.

What those tests actually demonstrate, against a real browser and a real server:

| Area | What is proven |
| --- | --- |
| Perception | Controls found across two frames; **every input on the sign-on form has no accessible name** and is reachable only via its adjacent label cell |
| Safety | Off-allowlist navigation refused; a nav link into an excluded screen contained and reverted; irreversible actions denied unattended and escalated when attended |
| Data handling | SSNs redacted out of screen text, node names and anchors before anything sees them; sensitive regions masked in the *first* screenshot of a screen; a typed password never captured |
| Prompt injection | A hostile member record instructs the agent to exfiltrate an SSN, open the admin screen and move money. Every step is refused at the choke point |
| Artifact | The reference capability validates; undeclared parameters, secret outputs and PII examples are rejected; tenant binding remaps labels and reports version drift |
| Replay | Happy path with typed outputs; two business outcomes; two recovery paths; a hard failure with a screenshot; escalation; the same artifact run against a second institution |

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

## Keys

Copy `.env.example` to `.env` and fill in **one** provider key. `.env` is
gitignored and no credential is ever written into an artifact, a log or the
evidence directory — a capability records the *name* of a secret and resolves
it at run time, which is what makes a sign-on flow safe to commit.

```bash
cp .env.example .env
```

## How it is put together

```
src/surface/     perceive and act on a surface. The seam to desktop/mainframe.
src/policy/      allowlist, risk classification, redaction. Enforced in act().
src/artifact/    the capability contract: schema, validation, tenant binding.
src/replay/      deterministic execution. Imports nothing from src/llm/.
targets/meridian a hostile mock back-office, in two tenant configurations.
docs/            design decisions, and the working plan.
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

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — thirteen design decisions, each
  with the options considered, the choice, why, and what would invalidate it.
- [`docs/PLAN.md`](docs/PLAN.md) — current status and next steps. Working notes
  rather than a deliverable.
