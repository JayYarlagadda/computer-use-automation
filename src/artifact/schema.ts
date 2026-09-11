/**
 * The capability artifact.
 *
 * This is the contract between the thing that discovers a flow and the thing
 * that invokes it. Everything else in the system is downstream of the shape
 * chosen here, so the shape is chosen deliberately.
 *
 * Five commitments run through it:
 *
 * 1. It is a *callable capability*, not a recording. Typed inputs, typed
 *    outputs, declared outcomes, a success condition. A caller can tell what
 *    to pass, what comes back, and which non-success answers are legitimate
 *    without reading the steps at all. A step list expresses none of that.
 *
 * 2. Business outcomes are first-class schema, not replay-engine code.
 *    "No such member" is an answer, not a crash. Declaring outcomes here makes
 *    the taxonomy reviewable, versioned, and part of what the caller programs
 *    against -- rather than something rediscovered in an if-statement.
 *
 * 3. Targeting is a ranked ladder, never a selector. There is no CSS anywhere
 *    in this file. A step says "the textbox in the row labelled Member ID",
 *    in the same vocabulary a screen reader or a human operator would use,
 *    which is why the same artifact shape can describe a desktop surface.
 *
 * 4. Nothing environment-specific is baked in. No origin, no tenant hostname,
 *    no concrete record id. Locations are path templates and values come from
 *    declared parameters, so one artifact binds to many tenants instead of
 *    being re-recorded per tenant.
 *
 * 5. Every predicate is a closed, serialisable vocabulary. Checkpoints,
 *    extraction rules and recovery actions are data, evaluated by code that
 *    cannot call a model. That is what makes replay deterministic in the
 *    strong sense: given the same artifact and inputs, the decisions taken are
 *    a function of the observed screen and nothing else.
 */

import { z } from 'zod';

/**
 * Version of *this schema*, not of any capability described by it.
 * Bumped when the envelope changes shape; see `migrate()` in ./migrate.ts.
 */
export const SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** `meridian.member.read-savings-balance` -- dotted, lowercase, stable. */
export const CapabilityId = z
  .string()
  .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'dotted lowercase identifier, e.g. app.area.action');

export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/, 'semantic version, e.g. 1.2.0');

/** Stable within an artifact; referenced by recovery rules and step reports. */
export const StepId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i);

// ---------------------------------------------------------------------------
// The type vocabulary for inputs and outputs
// ---------------------------------------------------------------------------

/**
 * A deliberately small, closed set of value types rather than embedded JSON
 * Schema.
 *
 * JSON Schema was the obvious alternative and was rejected for two reasons.
 * It has no way to say "this value is regulated", which is the single most
 * important property an input can have in this domain -- and a property that
 * has to be declared, not inferred, because redaction can't pattern-match its
 * way to "this string is a member's legal name". And it is open-ended enough
 * that two artifacts could describe the same money amount three different
 * ways, which makes artifacts harder for a human to review side by side.
 *
 * A closed vocabulary also means we can *generate* JSON Schema from it for the
 * agent-facing catalog (see ./jsonSchema.ts) -- the machine-readable form is
 * derived, so it cannot drift from the reviewable form.
 */
export const ValueType = z.enum([
  'string',
  'integer',
  'number',
  'boolean',
  /** Fixed-point money. Carried as a string to avoid float drift. */
  'currency',
  /** ISO-8601 calendar date. */
  'date',
  /** One of an enumerated set; see `options`. */
  'enum',
]);
export type ValueType = z.infer<typeof ValueType>;

/**
 * How sensitive a value is. This drives redaction, logging and screenshots,
 * so it is a required property with no permissive default.
 */
export const Sensitivity = z.enum([
  /** Safe to log and persist. Account types, statuses, branch names. */
  'public',
  /** Business data: log it, but never leave it in a public artifact. */
  'internal',
  /** Regulated PII. Redacted from logs, evidence and prompts. */
  'restricted',
  /** Credentials and tokens. Never captured anywhere, ever. */
  'secret',
]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'camelCase identifier'),
  type: ValueType,
  /** Written for the *calling agent*, which reads it to decide what to pass. */
  description: z.string().min(1),
  required: z.boolean().default(true),
  sensitivity: Sensitivity.default('internal'),
  /** Required when `type` is `enum`. */
  options: z.array(z.string()).optional(),
  /** Validated before replay starts, so bad input fails as input, not as UI. */
  pattern: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  /** A safe, fabricated example. Never a real value seen during discovery. */
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

// ---------------------------------------------------------------------------
// Where a value comes from
// ---------------------------------------------------------------------------

/**
 * The source of a value a step needs.
 *
 * Modelled as a tagged union rather than `"{{memberId}}"` string templating.
 * Templating conflates "text that happens to contain braces" with "a
 * substitution", which is an injection question nobody should have to think
 * about on a system that types into bank software. Being explicit also makes
 * the artifact statically checkable: every `param` reference is verified
 * against the declared inputs at load time.
 */
export const ValueSpec = z.discriminatedUnion('from', [
  z.object({ from: z.literal('literal'), value: z.string() }),
  z.object({ from: z.literal('param'), param: z.string() }),
  /**
   * Resolved at replay time from the runtime's secret source, by name. The
   * artifact records only the name. This is how a sign-on flow is replayable
   * without a credential ever having been written to disk.
   */
  z.object({ from: z.literal('secret'), ref: z.string() }),
]);
export type ValueSpec = z.infer<typeof ValueSpec>;

// ---------------------------------------------------------------------------
// Targeting: the ranked ladder
// ---------------------------------------------------------------------------

export const TextMatch = z.enum(['exact', 'contains', 'regex']);

/**
 * One way to find a control. Strategies are ordered strongest-first inside a
 * TargetDescriptor, and replay records *which* one resolved.
 *
 * That recording is the point. A fallback chain that silently succeeds tells
 * you nothing; a ladder that reports it had to drop from `role-name` to
 * `structural` is drift detection. Aggregated across tenants it is how you
 * learn that one institution upgraded their vendor product, before the
 * automation breaks rather than after.
 */
export const TargetStrategy = z.discriminatedUnion('kind', [
  /**
   * Strongest. What a screen reader announces, and what a human would say.
   * Survives markup changes entirely because it does not reference markup.
   */
  z.object({
    kind: z.literal('role-name'),
    role: z.string(),
    name: z.string(),
    match: TextMatch.default('exact'),
  }),

  /**
   * For controls with no accessible name at all -- the norm on table-laid-out
   * legacy screens, where a field's "label" is just the cell to its left.
   * Without this rung, every input on the target app is unaddressable.
   */
  z.object({
    kind: z.literal('anchor'),
    role: z.string(),
    precedingText: z.string().optional(),
    rowText: z.string().optional(),
    sectionText: z.string().optional(),
    match: TextMatch.default('exact'),
    /**
     * A constraint on the control's *own* text, applied on top of the anchors.
     *
     * This exists because writing the real flow proved the anchors alone are
     * not always enough. "The cell in the Savings row" matches four cells --
     * the type, the account number, the balance and the status all share a row
     * -- so the row identifies the region and something else has to identify
     * the cell within it. A shape constraint is the right something: the
     * balance is the currency-shaped cell in that row, which stays true when
     * the amount changes, when a column is reordered, and when a different
     * member has a different number of accounts. An ordinal would not.
     */
    namePattern: z.string().optional(),
  }),

  /**
   * Position within a named region. Weak -- it depends on ordering -- but it
   * is the last rung that still degrades predictably, and resolving here is a
   * strong signal that the screen has changed.
   */
  z.object({
    kind: z.literal('structural'),
    role: z.string(),
    sectionText: z.string().optional(),
    ordinalInRole: z.number().int().nonnegative(),
  }),

  /**
   * Last resort, and present mainly so that a surface with no accessibility
   * peer at all (canvas-rendered, or a desktop app with no automation
   * interface) is describable by the same schema. Records the viewport it was
   * captured at, because a bounding box means nothing without one.
   */
  z.object({
    kind: z.literal('coordinates'),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    viewportWidth: z.number().int().positive(),
    viewportHeight: z.number().int().positive(),
  }),
]);
export type TargetStrategy = z.infer<typeof TargetStrategy>;

export const TargetDescriptor = z.object({
  /** Human-readable, for review: "the Search button". Never used to resolve. */
  description: z.string().min(1),
  /**
   * Frames the control lives inside. Part of identity, not an afterthought:
   * framesets are everywhere in this environment and "the Search button" is
   * ambiguous across two frames that both have one.
   */
  framePath: z.array(z.string()).default([]),
  /** Ordered, strongest first. At least one. */
  strategies: z.array(TargetStrategy).min(1),
  /**
   * Why the compiler ranked them this way. Exists because the brief asks for
   * the reasoning about robustness to be part of the artifact, and because a
   * reviewer approving a capability deserves to see it.
   */
  notes: z.string().optional(),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;

// ---------------------------------------------------------------------------
// Checkpoints: a closed predicate language
// ---------------------------------------------------------------------------

/**
 * A condition asserted against an observation.
 *
 * Deliberately a tiny boolean algebra over four leaf predicates rather than an
 * expression string or a callback. Data can be reviewed by a human, diffed
 * between versions, rendered in an operator console, and -- most importantly
 * -- evaluated by code that has no way to call a model. An artifact that
 * carried executable predicates would put arbitrary logic inside a document we
 * load from disk and run against banking software, which is a different and
 * much worse security posture.
 */
export type Checkpoint =
  | { kind: 'text-present'; text: string; match?: 'contains' | 'regex' }
  | { kind: 'text-absent'; text: string; match?: 'contains' | 'regex' }
  | { kind: 'node-present'; target: TargetDescriptor }
  | { kind: 'node-absent'; target: TargetDescriptor }
  | { kind: 'location-matches'; pathTemplate: string }
  | { kind: 'all'; of: Checkpoint[] }
  | { kind: 'any'; of: Checkpoint[] }
  | { kind: 'not'; of: Checkpoint };

export const Checkpoint: z.ZodType<Checkpoint> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('text-present'),
      text: z.string().min(1),
      match: z.enum(['contains', 'regex']).optional(),
    }),
    z.object({
      kind: z.literal('text-absent'),
      text: z.string().min(1),
      match: z.enum(['contains', 'regex']).optional(),
    }),
    z.object({ kind: z.literal('node-present'), target: TargetDescriptor }),
    z.object({ kind: z.literal('node-absent'), target: TargetDescriptor }),
    /** Matched against the canonical path, e.g. `/member/{memberId}`. */
    z.object({ kind: z.literal('location-matches'), pathTemplate: z.string().min(1) }),
    z.object({ kind: z.literal('all'), of: z.array(Checkpoint).min(1) }),
    z.object({ kind: z.literal('any'), of: z.array(Checkpoint).min(1) }),
    z.object({ kind: z.literal('not'), of: Checkpoint }),
  ]),
);

// ---------------------------------------------------------------------------
// Extraction: how outputs are produced
// ---------------------------------------------------------------------------

/**
 * Post-processing applied to an extracted string. A closed set, for the same
 * reason checkpoints are: it keeps extraction deterministic and reviewable.
 */
export const Transform = z.enum([
  'trim',
  'collapse-whitespace',
  /** "$4,182.55" -> "4182.55". Currency outputs are strings, so no float. */
  'strip-currency',
  'digits-only',
  'uppercase',
  'lowercase',
]);
export type Transform = z.infer<typeof Transform>;

export const ExtractionRule = z.discriminatedUnion('kind', [
  /** Read the accessible name or value of a targeted control. */
  z.object({
    kind: z.literal('node-text'),
    target: TargetDescriptor,
    transforms: z.array(Transform).default([]),
  }),
  /**
   * A capture group over the screen's text. The escape hatch for values that
   * are rendered as prose rather than in an addressable control, which legacy
   * screens do constantly.
   */
  z.object({
    kind: z.literal('text-pattern'),
    pattern: z.string().min(1),
    group: z.number().int().nonnegative().default(1),
    transforms: z.array(Transform).default([]),
  }),
  /**
   * Pull a value back out of the canonicalised location, e.g. the id in
   * `/member/{memberId}`. Cheap, exact, and independent of rendering.
   */
  z.object({
    kind: z.literal('location-param'),
    param: z.string(),
    transforms: z.array(Transform).default([]),
  }),
]);
export type ExtractionRule = z.infer<typeof ExtractionRule>;

export const OutputSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  type: ValueType,
  description: z.string().min(1),
  sensitivity: Sensitivity.default('internal'),
  /**
   * A required output that cannot be extracted is a hard failure, not a null.
   * Returning a partial success to an agent that will act on the number is the
   * kind of quiet wrongness this system exists to avoid.
   */
  required: z.boolean().default(true),
  extract: ExtractionRule,
});
export type OutputSpec = z.infer<typeof OutputSpec>;

// ---------------------------------------------------------------------------
// Recovery: the middle category
// ---------------------------------------------------------------------------

/**
 * What to do about a condition that is neither success nor a business answer.
 *
 * `escalate` being in this vocabulary is intentional: it makes handing a run
 * to a human an ordinary, declared outcome of a recovery rule rather than a
 * special case bolted onto the executor.
 */
export const RecoveryAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry-step'), delayMs: z.number().int().nonnegative().default(500) }),
  /** Dismiss a known interstitial by clicking through it. */
  z.object({ kind: z.literal('click'), target: TargetDescriptor }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive() }),
  /**
   * Run another capability and then retry the step. This is how session expiry
   * is handled: the sign-on flow is itself a capability, so re-authenticating
   * is composition rather than a hardcoded branch in the replay engine.
   */
  z.object({
    kind: z.literal('run-capability'),
    capabilityId: CapabilityId,
    version: SemVer.optional(),
  }),
  /** Give up safely and ask for a person. */
  z.object({ kind: z.literal('escalate'), reason: z.string().min(1) }),
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const RecoveryRule = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * Evaluated against the current screen whenever a step cannot proceed --
   * either its target did not resolve or its checkpoint did not hold. Both
   * matter: a surprise interstitial and an expired session usually announce
   * themselves as "the control I wanted is not there", not as a failed
   * assertion, so a rule that only fired on checkpoint failure would miss the
   * conditions it was written for.
   */
  when: Checkpoint,
  then: RecoveryAction,
  maxAttempts: z.number().int().positive().default(1),
  /**
   * Resume from this step rather than retrying the one that failed.
   *
   * Needed because some recoveries destroy work already done. Re-authenticating
   * after a session expiry returns a *fresh* application: the member number
   * typed three steps ago is gone, so retrying just the failed step submits an
   * empty form and the caller is told the member number was invalid -- a wrong
   * answer produced by a successful recovery, which is the worst kind.
   * Declaring the restart point keeps that decision in the reviewed artifact
   * instead of hardcoded in the executor.
   */
  restartFrom: StepId.optional(),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

// ---------------------------------------------------------------------------
// Business outcomes
// ---------------------------------------------------------------------------

/**
 * A legitimate non-success answer the caller needs.
 *
 * The glossary names conflating this with failure as the most common design
 * mistake on this project, so it gets its own top-level array rather than
 * living inside error handling. An outcome is detected the same way success
 * is -- by a checkpoint -- which keeps the two symmetric and means neither is
 * privileged in the executor.
 */
export const BusinessOutcome = z.object({
  /** Stable, screaming-snake. The caller switches on this. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  detect: Checkpoint,
  /**
   * Whether reaching this outcome ends the run. A non-terminal outcome is one
   * the flow can continue past while still reporting that it happened.
   */
  terminal: z.boolean().default(true),
  /** Outputs that are meaningful specifically for this outcome. */
  outputs: z.array(OutputSpec).default([]),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcome>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Locations are templates, never URLs. The origin is supplied by the tenant
 * binding at replay time, so an artifact recorded against one institution
 * carries nothing that ties it to that institution's hostname.
 */
export const LocationSpec = z.object({
  pathTemplate: z.string().regex(/^\//, 'must start with /'),
  /** Values for the `{placeholders}` in the template. */
  params: z.record(z.string(), ValueSpec).default({}),
});
export type LocationSpec = z.infer<typeof LocationSpec>;

export const StepAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click') }),
  z.object({ type: z.literal('type'), value: ValueSpec }),
  z.object({ type: z.literal('select'), option: ValueSpec }),
  z.object({ type: z.literal('press'), key: z.string().min(1) }),
  z.object({ type: z.literal('navigate'), location: LocationSpec }),
  z.object({ type: z.literal('read') }),
  z.object({ type: z.literal('wait'), ms: z.number().int().positive() }),
]);
export type StepAction = z.infer<typeof StepAction>;

export const Step = z.object({
  id: StepId,
  /**
   * What this step is for, in a sentence a person can review. Required, not
   * optional: the brief asks that the artifact be reviewable by a human, and
   * "click node 14" is not reviewable. It is also what the operator console
   * shows when a run escalates mid-flow.
   */
  intent: z.string().min(1),
  action: StepAction,
  /** Required for click/type/select/read; meaningless for navigate/press/wait. */
  target: TargetDescriptor.optional(),
  /**
   * Asserted after the action. A step with no checkpoint is a step that
   * assumes its click worked, which is the failure mode checkpoints exist to
   * prevent -- so the compiler emits one wherever it can.
   */
  checkpoint: Checkpoint.optional(),
  /** Tried in order when the checkpoint fails. */
  recovery: z.array(RecoveryRule).default([]),
  /**
   * A step that may legitimately not apply -- a notice screen one tenant shows
   * and another does not. If the target does not resolve, the step is skipped
   * rather than failing.
   */
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Multi-tenant binding and overlays
// ---------------------------------------------------------------------------

/**
 * What the artifact was recorded against.
 *
 * Vendor and product are separate from tenant on purpose: that split is the
 * whole multi-tenant story. Hundreds of institutions run the same vendor
 * product, so the reusable unit is (vendor, product), and the tenant is a
 * binding applied on top rather than part of the capability's identity.
 */
export const AppIdentity = z.object({
  vendor: z.string().min(1),
  product: z.string().min(1),
  /** The version discovery actually saw. Compared at replay for drift. */
  productVersion: z.string().min(1),
  surfaceKind: z.enum(['browser', 'desktop', 'screenshot']),
  /** Tenant the recording was made against. Not part of capability identity. */
  recordedOnTenant: z.string().min(1),
});
export type AppIdentity = z.infer<typeof AppIdentity>;

/**
 * A per-tenant specialisation of one artifact.
 *
 * The design bet: across tenants running the same vendor product, the flow is
 * the same and the *wording* differs. So the common case is a label remap --
 * "Search" becomes "Find Member" -- which is a few lines of data, not a
 * re-recording. Step-level overrides exist for the cases that bet is wrong
 * about, and `extraSteps` covers a tenant with a genuinely extra screen.
 *
 * An overlay can only narrow behaviour, never add an action outside the
 * allowlist: overlays are data, and everything they produce still goes through
 * the same policy choke point at execution.
 */
export const TenantOverlay = z.object({
  tenantId: z.string().min(1),
  /** Product version this overlay was validated against, if known. */
  productVersion: z.string().optional(),
  /**
   * Applied to every `name` and anchor text in every target and checkpoint.
   * The cheap 90% case.
   */
  labels: z.record(z.string(), z.string()).default({}),
  /** Wholesale replacement of a step's target or checkpoint, by step id. */
  steps: z
    .record(
      StepId,
      z.object({
        target: TargetDescriptor.optional(),
        checkpoint: Checkpoint.optional(),
        skip: z.boolean().optional(),
      }),
    )
    .default({}),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

// ---------------------------------------------------------------------------
// Provenance and approval
// ---------------------------------------------------------------------------

export const Provenance = z.object({
  /** The natural-language goal the discovery run was given. */
  goal: z.string().min(1),
  recordedAt: z.string().datetime(),
  discoveryRunId: z.string().min(1),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    /** Which prompt produced this, so a bad artifact is traceable to a cause. */
    promptVersion: z.string().min(1),
  }),
  /** Exploration cost, and how much of it survived compilation. */
  stepsExplored: z.number().int().nonnegative(),
  stepsKept: z.number().int().nonnegative(),
  /** Where the discovery evidence for this artifact lives. */
  evidencePath: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * Approval state, and the stability signal that informs it.
 *
 * The rule this exists to support: unattended replay requires `approved`.
 * A freshly discovered artifact is a draft -- something a model wrote by
 * poking at a UI -- and letting that run unsupervised against bank software
 * because it happened to work once is not a defensible default.
 */
export const Approval = z.object({
  state: z.enum(['draft', 'approved', 'deprecated']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  /** Populated by repeated replays; the input to a human approval decision. */
  stability: z
    .object({
      runs: z.number().int().nonnegative().default(0),
      successes: z.number().int().nonnegative().default(0),
      /** Runs that succeeded but had to drop down the locator ladder. */
      degraded: z.number().int().nonnegative().default(0),
      lastRunAt: z.string().datetime().optional(),
    })
    .optional(),
});
export type Approval = z.infer<typeof Approval>;

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export const CapabilityArtifact = z.object({
  schemaVersion: z.string(),

  /** Identity and the human/agent-facing description of what this does. */
  capability: z.object({
    id: CapabilityId,
    version: SemVer,
    /** One line, imperative: "Read a member's savings balance". */
    title: z.string().min(1),
    /**
     * What a calling agent reads to decide whether this is the right tool.
     * Written for that reader specifically -- it is the tool description in
     * the generated catalog.
     */
    description: z.string().min(1),
  }),

  app: AppIdentity,

  /** The call signature. */
  inputs: z.array(ParamSpec).default([]),
  outputs: z.array(OutputSpec).default([]),
  outcomes: z.array(BusinessOutcome).default([]),

  /**
   * The highest risk class any step reaches. Replay refuses to start in a mode
   * the risk class forbids, so a caller learns "this needs a human" before the
   * browser opens rather than three steps in.
   */
  risk: z.enum(['safe', 'reversible', 'irreversible']),

  approval: Approval.default({ state: 'draft' }),

  /** The flow itself. */
  steps: z.array(Step).min(1),

  /**
   * Asserted at the end. Separate from the last step's checkpoint because
   * "the last click landed" and "the capability achieved its purpose" are
   * different claims, and only the second one is what the caller asked for.
   */
  successCheckpoint: Checkpoint,

  /**
   * Recovery rules that apply at *any* step. Session expiry and app errors are
   * not properties of a particular step -- they can happen anywhere -- so
   * modelling them per-step would mean repeating them on every step and
   * forgetting one.
   */
  recovery: z.array(RecoveryRule).default([]),

  tenantOverlays: z.array(TenantOverlay).default([]),

  provenance: Provenance,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/** Input shape before Zod applies defaults; what a compiler or author writes. */
export type CapabilityArtifactInput = z.input<typeof CapabilityArtifact>;
