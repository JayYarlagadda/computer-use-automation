# Report

A natural-language goal is given to a model once. The model drives a hostile
legacy UI. The successful run is compiled into a typed capability artifact, and
from then on that capability executes with no model in the decision loop. When
it cannot safely proceed, a person takes the same live session and hands it
back.

## Architecture

The system is a pipeline with a hard boundary in the middle.

```
goal + target
  -> discovery: LLM observe / decide / act over a Surface
  -> compiler:  trace -> typed capability artifact
  -> replay:    deterministic execution, no model reachable
  -> result:    success | business outcome | escalation | hard failure
  -> handoff:   a person takes the live session, then returns it
```

Everything above `Surface` is written against an accessibility-style node
graph: role, name, value, state, adjacency. There is no selector field on a
node and no HTML in a prompt. That is a portability property before it is an
ergonomic one. A desktop or mainframe surface becomes a new `Surface`
implementation, not a rewrite of the agent, the artifact, or the executor.

Two functions are choke points. Every action in both discovery and replay
passes through `Surface.act()`, which is where the allowlist and the risk
classification are enforced. Every byte the rest of the system sees of a
screen has passed through `Surface.observe()`, which is where redaction
happens. A guardrail in a prompt is a request; these two functions are
controls.

The model is an injected `LlmProvider`. Nothing in `src/replay/` imports
`src/llm/`. Replay cannot call a model without adding an import that review
would see. Discovery is the only command that is allowed to have a key.

The runtime is one Node process, CLI-driven, with artifacts and evidence as
files. That is a deliberate non-feature. The brief does not reward queues or
clusters; the seams that would have to survive that change are `Surface` and
the artifact contract, and those are the ones that were designed.

The operator console is a small HTTP API on the run's process. A run owns its
browser, so the session a person has to take lives where the run lives. The
operator is somebody else. What crosses the seam is list / attach / resolve --
the three transitions the control state machine defines. The console cannot
drive the page. The operator drives the real Chromium window the run left
open, which is what "the same live session" means.

## Artifact schema

The artifact is a callable contract, not a recording.

It declares typed inputs, typed outputs, a success checkpoint, and -- the part
the brief's glossary names as the most common mistake -- **business outcomes
as first-class schema**. "No such member" is an answer a caller switches on,
not an exception they parse out of a log. Declaring outcomes in the document
means the taxonomy is reviewable, versioned, and the same object that
`toCatalog()` publishes as a tool description, so the thing an agent is handed
and the thing a reviewer approved cannot drift apart.

Steps carry intent in English, a ranked locator ladder rather than a selector,
a closed predicate algebra for checkpoints, and a `ValueSpec` that is one of
`param`, `secret`, or `literal`. Credentials are named references resolved at
run time. That is what makes a sign-on flow safe to commit.

The compiler, not the model, produces this document. The model is allowed one
out-of-loop call afterwards, for prose: a title, descriptions, candidate
outcome names. Every locator rung is run through the real replay resolver
against the observation the model was looking at, and dropped unless it
uniquely resolves to the node that was acted on. Every proposed outcome is
checked so that it does *not* fire on the success screen. The model does not
get a vote on behaviour.

Predicates, extraction rules, transforms and recovery actions are a closed
vocabulary. An artifact is a document loaded from disk and executed against
banking software. An expression string inside it would turn "review this
capability" into "audit this program".

## Determinism & error handling

Given the same artifact and the same inputs, every replay decision is a
function of the observed screen. There is no temperature, no retry-with-a-
different-prompt, no hidden heuristic.

Targeting is a ranked ladder: role+name, then anchor-relative, then
structural, then coordinates. A unique match is required, so ambiguity is an
error rather than a silent wrong click. Which rung resolved is recorded on
every step, including successful ones. A step that used to resolve by
role+name and now only resolves structurally still succeeds, and is the
earliest available warning that a tenant's screen has moved.

Waiting is quiescence detection, not `waitForLoadState()`. On a frameset the
main frame never moves; a load-state wait returns instantly while a child
frame is still navigating. `observe()` then used to return nodes from one
screen and text from another. The surface waits for request and navigation
activity to go quiet, and nodes and text come from one evaluation per frame.

The result is a four-way discriminated union: `success`, `business-outcome`,
`escalated`, `failed`. A caller that handles `status` exhaustively has handled
the business cases by construction. The CLI preserves the distinction as exit
codes 0 / 2 / 3 / 1, so a shell is a caller too.

Discovery has its own four budgets -- turns, wall clock, consecutive
incoherent replies, consecutive actions that changed nothing -- each
terminating with a distinct code. Repeated policy refusals escalate rather
than fail: the honest reading is that the goal needs authority the agent does
not have.

On resume from a human, the executor re-evaluates the step's own checkpoint
against the screen they left behind. An operator who says "done" and changes
nothing produces `CHECKPOINT_FAILED`, not success. Declared business outcomes
are checked first, so a person who takes over and finds no such member
produces an answer rather than a broken capability.

## Heterogeneity & multi-tenant

The reusable unit is (vendor, product). A tenant is a binding on top: label
maps, applied whole-string only so a `Search -> Find Member` mapping cannot
rewrite a checkpoint into "Member Find Member". Step-level overrides exist for
where the flow itself differs, and a tenant accumulating many of them is a
signal, not a cost to absorb quietly. Binding reports `versionDrift` when the
tenant's product version differs from the recorded one -- not fatal, but it
travels with the result.

The target app exists in two tenant configurations of the same vendor
product, with different branding, wording and version. One artifact replays
against both. That is the multi-tenant claim as evidence rather than as
prose.

A desktop surface is not implemented. The `Surface` interface is the seam,
and perception being an accessibility graph is what makes the seam honest:
Windows UIA / macOS AX / AT-SPI expose the same role+name shape. Coordinates
remain last on the locator ladder for surfaces that genuinely have nothing
better.

## Escalation & handoff

Control is a typed state machine with one holder at a time, and the holder
carries a token that `act()` requires. While a person has the session, the
automation's token is not the live grant, so an executor that resumed early
is refused rather than racing them for the keyboard.

Control is surrendered when the escalation is *raised*, not when the operator
arrives. The gap between those two is exactly when a stray retry would act on
a screen the system has already admitted it cannot read. Observation is
deliberately never gated: watching changes nothing, and the handover is
precisely what the evidence log should capture.

There is no "approved, now you do it" disposition. An irreversible step is
performed *by* the person who authorised it. A grant that `act()` honoured
would reintroduce the one thing the choke point exists to prevent, and a
bypass that exists can be reached by accident. The cost is a click; the
benefit is that the money movement is attributable to a named operator.

The operator console is the CLI command `operator`. It polls the run's
console, asks a person whether to take the session, and records a named
disposition. It does not drive the page. An intervention cannot be resolved
anonymously.

The end-to-end path that is worth pointing at: the session expires mid-flow,
the declared re-authentication capability is not wired, the run asks for a
person; the operator signs the browser back on by hand and returns it; the
run resumes and produces the savings balance it was asked for. A second test
has the operator say "done" and change nothing; the run refuses to report
success.

## Safety

Policy is evaluated inside `act()`, for both discovery and replay, as a typed
result rather than an exception. Off-allowlist navigation is refused; a nav
link that *lands* off-allowlist is contained and reverted, because a click is
authorised against the page it happens on and frameset navigation does not
move the address bar. Irreversible actions are denied unattended and
escalated when attended.

Redaction happens in `observe()`. A node whose own content had to be redacted
is marked `sensitive`, so the same value is masked in the first screenshot of
a screen and refused by `read`, without anyone enumerating "the SSN cell" in
advance. Anchor text is redacted but does not taint its neighbour: over-
redaction is its own failure mode.

The model cannot express an off-origin URL: `navigate` takes a path, and the
runtime supplies the origin from the allowlist. It cannot express a password
as a tool argument: `type_secret` takes a credential *name*, the runtime
substitutes the value on the way to the surface, and the trace stores the
reference. The first live discovery run typed the demo password because it
was printed on the sign-on screen; a prompt rule saying "never type a
password" did not prevent it. Removing the value from the vocabulary did.
The committed transcript of that run has the typed value replaced with
`[secret:MERIDIAN_OPERATOR_PASSWORD]` — what the model actually did, without
putting the value in a public repository.

Prompt injection is treated as a policy problem, not a prompt-wording
problem. A hostile member record instructs the agent to exfiltrate an SSN,
open admin, and move money. Every step is refused at the choke point. The
tests assume the model is fully persuaded.

Secrets stay out of the repository by a pre-commit hook and by `npm run
verify`, which scan tracked files for credential shapes and evidence for
regulated values. Artifacts record the name of a secret. `.env` is gitignored;
`.env.example` is tracked and empty of keys.

## Cuts

**No remote co-browse.** A human on another machine needs a transport (CDP
screencast or WebRTC) under the same control-state machine. The console is
local to the headed browser the run left open. Building the transport would
have been a second product.

**No "approved, now you do it".** Documented in D5. The alternative is a
grant that bypasses the choke point.

**No Anthropic / Gemini providers in the factory.** Discovery speaks
OpenAI-compatible (Groq, OpenAI). The other SDKs were an earlier plan; the
recorded evidence run used Groq. A mock/scripted provider exists for tests
and does not need a key.

**No desktop surface implementation.** The seam is there; the implementation
is not. A second Playwright-shaped backend without a second target would
have been theatre.

**No draft-to-approved gate driven by a stability score.** Cheap, useful,
not load-bearing for the brief. Artifacts ship as `draft`; unattended replay
refuses them until a person changes that field.

**No keystroke-level capture of the operator.** Their work is the pair of
screenshots at handover and return, plus their named note. That is the
honest version of "their actions are captured" given that we do not have a
remote transport.

**The target app is a mock.** Deliberately hostile, two tenants, injectable
faults. It is how runtime conditions become evidence. It is not a bank, and
it is not what is being graded.
