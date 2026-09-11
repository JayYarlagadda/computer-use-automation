import type { Action, ActionType, UiNode } from '../surface/types.js';

/**
 * Execution modes. The same capability is allowed to do different things
 * depending on who is watching, which is why risk is evaluated against mode
 * rather than baked into the artifact.
 */
export type ExecutionMode =
  /** LLM is exploring. Most permissive for reads, strictest on writes. */
  | 'discovery'
  /** Production replay triggered by an agent with no human present. */
  | 'unattended'
  /** A human is at the console and can approve a risky step. */
  | 'attended';

export type RiskClass =
  /** Reads and navigation. No state change. */
  | 'safe'
  /** Changes state but is undoable from the UI (filling a field, opening a form). */
  | 'reversible'
  /** Moves money, deletes, or otherwise cannot be undone from this screen. */
  | 'irreversible';

export interface PolicyConfig {
  /** Origins the agent may operate on, e.g. "http://127.0.0.1:4173". */
  allowedOrigins: string[];
  /** Glob-ish path patterns within those origins. "*" matches one segment. */
  allowedRoutes: string[];
  /** Action verbs permitted at all. */
  allowedActions: ActionType[];
  /**
   * Control names matching these patterns are treated as irreversible
   * regardless of what the flow claims. Deny-by-default on the risky class is
   * safer than enumerating every safe control.
   */
  irreversiblePatterns: string[];
  /** Values matching these are scrubbed from logs, artifacts and prompts. */
  redactPatterns: string[];
}

export type PolicyDecision =
  | { effect: 'allow'; risk: RiskClass }
  | {
      /** Not a failure: the action is legitimate but needs a person. */
      effect: 'require-approval';
      risk: RiskClass;
      reason: string;
    }
  | { effect: 'deny'; risk: RiskClass; reason: string; code: PolicyDenialCode };

export type PolicyDenialCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'ROUTE_NOT_ALLOWED'
  | 'ACTION_TYPE_NOT_ALLOWED'
  | 'IRREVERSIBLE_UNATTENDED';

export interface PolicyContext {
  mode: ExecutionMode;
  /** Current location, used for origin/route checks. */
  location: string;
  /** The node being acted upon, when the action targets one. */
  node?: UiNode;
}

export interface Policy {
  check(action: Action, ctx: PolicyContext): PolicyDecision;
  classify(action: Action, node?: UiNode): RiskClass;
  redact(text: string): string;
}
