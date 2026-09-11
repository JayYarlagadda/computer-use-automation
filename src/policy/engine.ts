/**
 * Guardrail enforcement.
 *
 * Evaluated from inside Surface.act(), the single function every action in
 * both the discovery loop and the replay engine must pass through. A guardrail
 * enforced in a prompt is a request; a model that ignores it meets no
 * mechanism. Enforced here, there is no bypass to find -- including for code
 * we write later that forgets the rule exists.
 *
 * Denial is a typed return value rather than a thrown error. During discovery
 * the agent is told "that was refused, choose something else" and keeps going,
 * which is both more useful and more honest than crashing the run.
 */

import type { Action, UiNode } from '../surface/types.js';
import type {
  ExecutionMode,
  Policy,
  PolicyConfig,
  PolicyContext,
  PolicyDecision,
  RiskClass,
} from './types.js';

export const DEFAULT_POLICY: PolicyConfig = {
  allowedOrigins: ['http://127.0.0.1:4173', 'http://127.0.0.1:4174'],
  allowedRoutes: ['/', '/login', '/logout', '/app', '/nav', '/notice', '/search', '/member/*', '/member/*/adjust', '/transactions'],
  allowedActions: ['click', 'type', 'select', 'press', 'navigate', 'read', 'wait'],
  irreversiblePatterns: [
    // Deliberately matches the *link* to the adjustment screen as well as the
    // submit button on it ("Post Balance Adjustment" and "Post Adjustment").
    // Over-blocking a navigation is the right error to make here: a capability
    // that legitimately needs that screen needs approval for the commit one
    // step later anyway, so gating the entrance costs nothing and closes the
    // window where an unattended run is sitting on a money-moving form.
    'post\\b[\\w\\s]*\\badjust',
    'transfer',
    'delete',
    'remove',
    'close\\s+account',
    'disburse',
    'wire',
    'approve',
    'authori[sz]e',
    'submit\\s+payment',
  ],
  redactPatterns: [
    // Digit-boundary lookarounds, NOT \b. A word boundary needs a non-word
    // character on one side, and the text these patterns run against is often
    // concatenated cell content with no separator at all -- "SSN412-88-0173"
    // out of a table row's innerText. There is no \b between "N" and "4", so
    // a \b-anchored pattern silently misses the one place the value is most
    // likely to leak. Anchoring on "not preceded/followed by a digit" keeps
    // the guard against matching a fragment of a longer number without
    // depending on the surrounding text being tokenised.
    //
    // SSN-shaped values.
    '(?<!\\d)\\d{3}-\\d{2}-\\d{4}(?!\\d)',
    // Long digit runs: account and card numbers.
    '(?<!\\d)\\d{12,19}(?!\\d)',
  ],
};

/**
 * A policy scoped to one running target.
 *
 * Origins are a property of the deployment, not of the code: the same
 * capability runs against tenant A on one host and tenant B on another, and
 * tests run against an OS-assigned port. Baking a port into the default is
 * fine as a convenience; making it the only way to build a policy is not.
 */
export function policyFor(origins: string | string[], overrides: Partial<PolicyConfig> = {}): PolicyEngine {
  return new PolicyEngine({
    ...DEFAULT_POLICY,
    allowedOrigins: Array.isArray(origins) ? origins : [origins],
    ...overrides,
  });
}

/** "/member/*" matches "/member/100245" but not "/member/100245/adjust". */
function routeMatches(pattern: string, path: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+') +
      '/?$',
  );
  return rx.test(path);
}

export class PolicyEngine implements Policy {
  private readonly irreversible: RegExp[];
  private readonly redactions: RegExp[];

  constructor(readonly config: PolicyConfig = DEFAULT_POLICY) {
    this.irreversible = config.irreversiblePatterns.map((p) => new RegExp(p, 'i'));
    this.redactions = config.redactPatterns.map((p) => new RegExp(p, 'g'));
  }

  classify(action: Action, node?: UiNode): RiskClass {
    if (action.type === 'read' || action.type === 'wait' || action.type === 'navigate') return 'safe';

    // Typing into a password field is not itself irreversible, but it is the
    // one action whose payload must never be recorded anywhere.
    if (action.type === 'type' || action.type === 'select' || action.type === 'press') {
      return 'reversible';
    }

    if (action.type === 'click' && node) {
      const label = `${node.name} ${node.value ?? ''}`;
      if (this.irreversible.some((rx) => rx.test(label))) return 'irreversible';
      return 'reversible';
    }

    return 'reversible';
  }

  check(action: Action, ctx: PolicyContext): PolicyDecision {
    const risk = this.classify(action, ctx.node);

    if (!this.config.allowedActions.includes(action.type)) {
      return {
        effect: 'deny',
        risk,
        code: 'ACTION_TYPE_NOT_ALLOWED',
        reason: `Action type "${action.type}" is not in the allowlist.`,
      };
    }

    // Navigation is checked against its destination; everything else against
    // where we currently are.
    const target = action.type === 'navigate' ? action.location : ctx.location;
    const originCheck = this.checkLocation(target, risk);
    if (originCheck) return originCheck;

    // The core safety rule: an irreversible action never happens unattended.
    // It is not an error -- it is a request for a person, routed through the
    // same escalation path as "stuck" (see docs/DECISIONS.md, D4).
    if (risk === 'irreversible') {
      if (ctx.mode === 'attended') {
        return {
          effect: 'require-approval',
          risk,
          reason: `"${ctx.node?.name ?? action.type}" is irreversible and needs operator approval.`,
        };
      }
      return {
        effect: 'deny',
        risk,
        code: 'IRREVERSIBLE_UNATTENDED',
        reason: `"${ctx.node?.name ?? action.type}" is irreversible and cannot run in ${ctx.mode} mode.`,
      };
    }

    return { effect: 'allow', risk };
  }

  private checkLocation(location: string, risk: RiskClass): PolicyDecision | undefined {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      return { effect: 'deny', risk, code: 'ORIGIN_NOT_ALLOWED', reason: `Unparseable location "${location}".` };
    }

    if (!this.config.allowedOrigins.includes(url.origin)) {
      return {
        effect: 'deny',
        risk,
        code: 'ORIGIN_NOT_ALLOWED',
        reason: `Origin ${url.origin} is not in the allowlist.`,
      };
    }

    if (!this.config.allowedRoutes.some((p) => routeMatches(p, url.pathname))) {
      return {
        effect: 'deny',
        risk,
        code: 'ROUTE_NOT_ALLOWED',
        reason: `Route ${url.pathname} is not in the allowlist.`,
      };
    }

    return undefined;
  }

  /**
   * Pattern-based scrubbing for anything serialised. Value-based redaction of
   * known parameter values happens in the evidence layer, which knows what was
   * passed in; this catches regulated shapes we were never told about.
   */
  redact(text: string): string {
    let out = text;
    for (const rx of this.redactions) out = out.replace(rx, '[REDACTED]');
    return out;
  }
}

export function modeFor(unattended: boolean): ExecutionMode {
  return unattended ? 'unattended' : 'attended';
}
