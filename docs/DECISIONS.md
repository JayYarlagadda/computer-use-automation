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

One narrowing fell out of building it. There is no "approved — now you do it"
disposition. An irreversible step that needed a person is performed *by* that
person, in the live session, and the executor then checks the step's
checkpoint. The alternative is a grant that `act()` honours, which reintroduces
the one thing the choke point exists to prevent: a path by which automation
performs an irreversible action with no human at the controls. A bypass that
exists can be reached by accident. Requiring the approver to also be the actor
costs a click and buys attribution — the money movement is traceable to a named
operator rather than to a run that was told it could proceed.

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

---

## D9 — The guardrail checks the consequence of an action, not only its intent

**Options considered**

1. Check the allowlist before acting, which is what D4 originally built.
2. Read link destinations at record time and pre-validate them.
3. Check before *and* after: re-evaluate where the action actually left us,
   and revert if it is somewhere the allowlist forbids.

**Choice** — (3).

**Why.** (1) has a hole, and it is not hypothetical — a test found it. A click
is authorised against the page it happens *on*, so clicking a link into an
off-allowlist screen passes the pre-check and lands somewhere the agent was
never permitted to be. On the target app, clicking "Administration" from the
nav frame reached `/admin` cleanly despite `/admin` being deliberately absent
from `allowedRoutes`.

(2) does not survive contact with this environment. An `href` is markup, which
perception deliberately does not expose (D1); it does not exist at all on a
desktop surface; and it would still miss form posts and scripted redirects,
which is how most navigation happens on these screens.

So containment is detective rather than preventive: notice, revert, and report
under a distinct code, `NAVIGATED_OFF_ALLOWLIST`, so a constrained run is
visible in evidence rather than quietly wrong. Every frame is checked, not just
the top-level page — on a frameset the whole point of a nav link is that it
retargets a child frame while the address bar never moves, so a
top-level-only check passes while the agent sits on a forbidden screen.

**What would invalidate this.** An action whose side effect is irreversible
before we can revert it. Reverting a *navigation* is cheap; reverting a posted
transaction is not. That case is handled one layer earlier, by refusing
irreversible actions outright rather than containing them afterwards — which
is why both mechanisms exist rather than either one alone.

---

## D10 — Redaction happens at the perception boundary, and marks only its own node

**Options considered**

1. Redact when writing evidence and prompts, at each call site.
2. Redact in `observe()`, the one function that produces every byte the rest
   of the system ever sees.
3. Classify fields in advance and redact by field identity.

**Choice** — (2), with (3) as the declared-sensitivity mechanism in the
artifact schema for values we are told about in advance.

**Why.** (1) is the same mistake as enforcing a policy in a prompt: it works
until someone adds a seventh place that serialises an observation. `observe()`
is to perception what `act()` is to action — the single function both discovery
and replay must pass through — so redacting there is unbypassable for the same
reason the policy check is.

A node whose *own* content had to be redacted is also marked `sensitive`, which
means the same value is masked in screenshots and refused by `read` without
anyone having enumerated "the SSN cell" in advance. Anchor text is redacted but
does **not** taint the node: tainting on ambient row text would spread from one
SSN cell across its whole row, masking the join date and the "SSN" label too.
Over-redaction is its own failure mode — a capability that cannot read a join
date because a neighbour was regulated is broken, and it teaches people to turn
redaction off.

One implementation note that is really a design point: the patterns use
digit-boundary lookarounds rather than `\b`. A word boundary needs a non-word
character on one side, and the text these patterns run against is concatenated
cell content — `SSN412-88-0173` out of a table row. There is no `\b` between
"N" and "4", so the `\b`-anchored version silently missed the one place the
value was most likely to leak.

**What would invalidate this.** Regulated data with no distinguishing shape —
a member's legal name is PII and matches nothing. Pattern redaction cannot
reach it, which is exactly why the artifact schema carries a declared
`sensitivity` on every input and output instead of relying on patterns alone.
The two mechanisms cover different halves of the problem and neither is
sufficient.

---

## D11 — The artifact is data. Predicates are a closed vocabulary, never expressions

**Options considered**

1. Checkpoints as expression strings evaluated at replay (`text.includes(...)`).
2. Checkpoints as embedded JavaScript or a small scripting language.
3. A closed, serialisable predicate algebra: four leaf kinds plus
   `all` / `any` / `not`.

**Choice** — (3), and the same treatment for extraction rules, transforms and
recovery actions.

**Why.** Security first: an artifact is a document loaded from disk and
executed against banking software. (1) and (2) put arbitrary logic inside that
document, which turns "review this capability" into "audit this program" and
turns a compromised artifact store into remote code execution. A closed
vocabulary cannot express anything the executor does not already implement.

It is also what makes the other requirements reachable. Data can be diffed
between versions, rendered in an operator console, remapped by a tenant
overlay, and — the reason it matters most — evaluated by code that has no way
to call a model. That is determinism in the strong sense: given the same
artifact and inputs, every decision is a function of the observed screen and
nothing else.

**What would invalidate this.** A flow needing a predicate the vocabulary
cannot express. The answer is to extend the vocabulary, in a versioned schema
change that gets reviewed — which is slower than an escape hatch, and is
supposed to be.

---

## D12 — The reusable unit is (vendor, product); the tenant is a binding on top

**Options considered**

1. One artifact per tenant, re-recorded.
2. One artifact per tenant, generated from a shared template.
3. One artifact per (vendor, product), with per-tenant overlays applied at
   bind time.

**Choice** — (3).

**Why.** The environment is hundreds of institutions running ~20 apps each,
where many tenants run the *same vendor product* configured and branded
differently. (1) means thousands of near-identical artifacts, each needing its
own review and its own maintenance, and it is how a fix gets applied to 400 of
the 500 places it was needed.

The bet the overlay makes is specific and falsifiable: across tenants on one
product, the *flow* is identical and the *wording* differs. If that holds, a
tenant costs a few lines of label mapping. Step-level overrides exist for where
it does not hold — and a tenant accumulating many overrides is a signal worth
acting on, not a cost to absorb quietly.

Two supporting details. Label remapping is whole-string only: substring
replacement would rewrite a checkpoint "Member Search" into "Member Find
Member" under a `Search -> Find Member` mapping, which is nonsense that still
parses and still reads like an honest label. And binding reports
`versionDrift` when the tenant's product version differs from the recorded one
— not fatal, since these products change slowly, but it is the single most
useful piece of context to have attached to a replay that later fails, so it
travels with the result rather than being logged and lost.

**What would invalidate this.** A vendor product whose tenants customise
screen *flow*, not just wording — a tenant with an extra approval screen in the
middle. Optional steps absorb the small version of that; the large version
genuinely needs a separate artifact, and the honest answer is to detect it (via
override count) rather than pretend one artifact covers it.

---

## D13 — Waiting is quiescence detection, not a load-state check

**Options considered**

1. Fixed sleeps.
2. `page.waitForLoadState()`.
3. Wait for observed page activity to stop, bounded by a timeout.

**Choice** — (3).

**Why.** (1) is simultaneously too long on a fast run and too short on a slow
one, and "transient slowness" is a runtime condition replay is explicitly
required to absorb. (2) looks correct and is not: load state is a property of
the *main* frame, and on a frameset the main frame never moves. Submitting the
search form navigates a child frame while the address bar sits on `/app`
throughout, so a main-frame wait returns instantly.

That produced the worst class of bug in this system: `observe()` returned a
node graph from the search screen alongside page text from the member detail
screen, and an agent reasoning over a screen it was not on. The fix has two
halves — nodes and text now come from one evaluation per frame rather than two
passes, so an observation is internally consistent by construction; and
`settle()` waits for request and navigation events to go quiet, then confirms
every frame has a document.

**What would invalidate this.** A screen that polls on a timer, where activity
never goes quiet. The bounded timeout keeps that from hanging, but the
observation taken afterwards is a snapshot of a moving target — which is a real
limitation, and the reason the locator ladder requires a *unique* match rather
than trusting any single observation to be complete.
