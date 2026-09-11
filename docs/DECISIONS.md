# Decision log

One entry per load-bearing decision: the options, the choice, the reason, and
what would invalidate it. `REPORT.md` is the distilled version of this file;
this is the long form, kept so every choice in the repo has a traceable
rationale.

---

## D1 — Perception is an accessibility-tree "UI graph", not a DOM/CSS selector

**Options considered**

1. Playwright CSS/XPath selectors against the DOM.
2. Screenshot + coordinates only (pure vision, set-of-marks).
3. A normalized node graph derived from the accessibility tree, with the
   screenshot as a secondary signal.

**Choice** — (3).

**Why.** The brief's target environment is legacy back-office banking software:
framesets, table-based layout, non-semantic markup, and no test IDs. CSS
selectors are a property of *markup*, and markup is exactly the thing that is
absent or meaningless in that environment. They also do not exist at all on a
native desktop app, which the brief names as an in-scope surface.

The accessibility tree is the one representation that survives all three cases:
browsers expose it, and Windows UIA / macOS AX / AT-SPI expose the same
role+name shape for desktop applications. Building perception on roles and
accessible names means the agent loop, the artifact schema, and the replay
engine are all surface-agnostic by construction rather than by aspiration — the
desktop surface becomes a new `Surface` implementation, not a rewrite.

It also constrains the LLM usefully. The model only ever sees
`(nodeId, role, name, value, state)` — never HTML, never a selector. It cannot
invent a brittle CSS path because it is never shown one. What it references is
the same thing a human operator or a screen reader would reference.

Coordinates are still recorded per node, but ranked last in the locator ladder
(see D3) and used only by surfaces that genuinely have nothing better.

**What would invalidate this.** A target whose accessibility tree is empty or
actively wrong — e.g. a canvas-rendered or Flash-style application, or a
desktop app that ships no automation peer. That is the case the
screenshot+coordinates surface exists for, which is why it stays in the
`Surface` interface as a documented seam rather than being designed out.

---

## D2 — The artifact is a *capability contract*, not a step recording

**Options considered**

1. Serialize the model transcript / action trace directly.
2. Emit a step list with selectors.
3. Emit a typed, versioned capability: typed inputs, typed outputs, declared
   business outcomes, a success checkpoint, and steps carrying intent.

**Choice** — (3).

**Why.** The brief frames the artifact as something "an AI agent can call", and
says explicitly it "needs a clear contract, not just a step list". A caller
needs to know what to pass, what it gets back, and which non-success answers
are legitimate — none of which a step list expresses.

The decisive part is modelling **business outcomes in the schema itself**.
"No such member" is an answer the caller needs, not a crash; the glossary calls
conflating the two the most common design mistake on this project. Declaring
outcomes in the artifact (rather than discovering them in replay code) means
the taxonomy is reviewable, versioned, and part of the contract the calling
agent programs against.

Steps also carry a human-readable `intent`, because the brief requires the
artifact be reviewable by a human, and "click node 14" is not reviewable.

**What would invalidate this.** If flows turned out to be so short-lived that
maintaining a contract cost more than re-discovering the flow each time. The
brief rules this out directly: these UIs "change slowly", which is precisely
what makes record-once/replay-many viable.

---

## D3 — Targeting is a ranked ladder of strategies with degradation telemetry

**Options considered**

1. One selector per step.
2. One selector plus a blind fallback chain.
3. A ranked ladder of independent strategies, requiring a unique match, that
   reports *which* rank resolved.

**Choice** — (3). Ranking, strongest first: accessible `role+name`;
anchor-relative ("the textbox in the row whose label cell reads 'Savings'");
structural path within a labelled region; and finally bounding-box coordinates.

**Why.** Robustness here is not about guessing better, it is about knowing when
you guessed. Requiring a *unique* match turns an ambiguous page into an
explicit error instead of a silent wrong click — the failure mode that makes
UI automation untrustworthy in a financial context.

Recording which rank resolved is what makes the ladder more than a fallback
chain. If a step that used to resolve by `role+name` now only resolves
structurally, the run still succeeds but emits a `degraded` signal. Aggregated,
that signal is drift detection: it is how you find out a tenant upgraded their
vendor product *before* the automation breaks, which is the multi-tenant
problem in section 3.7.

**What would invalidate this.** A surface where accessible names are
duplicated everywhere (e.g. twenty buttons all named "Select"), which would
push resolution down the ladder constantly. Anchor-relative targeting is the
mitigation, and it is ranked second for exactly that reason.

---

## D4 — Single policy choke point shared by discovery and replay

**Options considered**

1. Check the allowlist in the agent loop's prompt/tool layer.
2. Check it in the replay executor.
3. Enforce it in `Surface.act()`, the one function both paths must call.

**Choice** — (3).

**Why.** A guardrail enforced in the prompt is a request, not a control; a
model that ignores it faces no mechanism. Putting the check at the single
function through which *every* action in *both* code paths must pass means
there is no bypass to find. Policy denial is a typed result, not an exception,
so the agent can be told "that was refused, choose differently" and continue.

The same choke point classifies actions as reversible or irreversible, and an
irreversible action under unattended replay does not fail — it routes into the
*same* escalation primitive as "stuck" (D5). Safety and human-in-the-loop
sharing one mechanism is deliberate: it means there is exactly one way for the
system to stop and ask a person, rather than two half-built ones.

**What would invalidate this.** Nothing structural; the cost is that
`Surface.act()` needs the policy context threaded into it, which is a small
price for an unbypassable check.

---

## D5 — Control transfer is an explicit state machine guarded by a token

**Options considered**

1. Pause automation, let a human use the browser, resume on a keypress.
2. Full real-time co-browsing operator console (explicitly out of scope).
3. A `SessionBroker` owning the live session, with control as a typed state
   machine and a `ControlToken` the executor must hold to act.

**Choice** — (3), with a deliberately minimal operator surface.

**Why.** The brief asks us to "think about the seam this implies" and to have
a way "to know who is (or should be) in control". A convention — "the
automation promises not to act while paused" — does not answer that. Making
the token a precondition of `act()` turns control into something the system
enforces and can report on, and makes the automation/human race condition
structurally impossible rather than merely unlikely.

Because the browser is real and headed, the human operates the genuine session
rather than a copy, satisfying "the same live session — not a fresh one". Their
actions are captured by page-level instrumentation into the same evidence
stream. On resume the executor re-verifies the step's precondition rather than
trusting that the human did what was asked.

**What would invalidate this.** Nothing here; the acknowledged gap is remote
operation. A human on another machine needs a co-browse transport (CDP
screencast or WebRTC). That is a transport swap beneath the same control-state
machine, and is documented as such rather than built.

---

## D6 — Local, deliberately hostile target app instead of a public demo site

**Options considered**

1. A public demo site (saucedemo, the-internet).
2. A public bank/credit-union sandbox.
3. A local server-rendered mock back-office, built hostile on purpose.

**Choice** — (3): "Meridian", a fake credit-union back-office using a frameset,
table-based layout, non-semantic markup and no test IDs.

**Why.** Three things the brief grades heavily are only reachable with a target
we control. Runtime error states — validation failure, record-not-found,
permission denial, surprise confirmation dialog, session expiry, transient
slowness — have to be *injectable* on demand to be demonstrated; you cannot ask
someone else's site to deny you permission. A second tenant variant of the same
"vendor product" is what turns the multi-tenant section from prose into
evidence. And a hostile DOM is the only honest test of D1: if the perception
layer works on table soup with no test IDs, the claim that it generalises to
legacy surfaces has been demonstrated rather than asserted.

Secondary but real: the whole submission runs offline with no external
dependency, no terms-of-service question, and no possibility of touching real
credentials or real PII — all of which the ground rules call out.

**Cost.** We have to build the app. It is server-rendered HTML and a few
hundred lines, and it is not part of what is being graded — so it stays
deliberately unpolished.

---

## D7 — TypeScript, single process, file-backed stores

**Options considered.** TypeScript/Node vs Python; single process vs services.

**Choice** — TypeScript, one process, CLI-driven, artifacts and evidence on
disk.

**Why.** Playwright is first-class in TypeScript, and Zod lets one schema
definition serve as runtime validation *and* as the JSON Schema published to a
calling agent — so the artifact contract and the agent-facing tool definition
cannot drift apart, because they are the same object.

Single process is a deliberate non-feature. The brief states plainly that
building scaling infrastructure — queues, clusters, multi-tenant plumbing — is
not rewarded, and that designing abstractions that *could* scale is. The
seam that matters for scale is `Surface` and the artifact schema, not the
process topology.

**What would invalidate this.** Real production load, where discovery runs are
long-lived and need to be queued and distributed. The artifact and replay
contract are unaffected by that change, which is the point.

---

## D8 — LLM access behind a provider interface; replay needs no key

**Options considered.** Hard-code one vendor SDK; or a thin `LlmProvider`
interface with several implementations plus a mock.

**Choice** — the interface, defaulting to Anthropic, with a `mock` provider
that replays a recorded transcript.

**Why.** Two practical reasons and one architectural one. Architecturally, the
model is a *component of discovery only* — making it an injected dependency
makes that boundary visible in the type system: nothing in `src/replay/` can
import it. Practically, cheap models can be used for iteration and a strong one
for the recorded evidence run; and the `mock` provider means a reviewer with no
API key can still exercise the discovery path, which the deliverables section
asks for ("how to run without live services").
