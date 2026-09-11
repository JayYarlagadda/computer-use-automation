/**
 * Browser implementation of Surface.
 *
 * Two things here are load-bearing beyond "drive Playwright":
 *
 * 1. Frames are first-class. The target environment is full of framesets, so
 *    every node carries the frame path it was found in, and acting on a node
 *    means acting in the frame that produced it. Flattening frames away would
 *    make the whole model wrong for the common case.
 *
 * 2. Policy is enforced here, not above. act() is the single function every
 *    action in both discovery and replay flows through, so putting the check
 *    inside it means there is no code path that can skip it.
 *
 * 3. observe() is the symmetric choke point for perception. Every byte that
 *    reaches a model, a log or an artifact is produced here, so redaction
 *    happens here too -- once, rather than at each of the places data is
 *    later serialised and forgotten about.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import type { Action, ActResult, Observation, Surface, UiNode } from './types.js';
import { NODE_ATTR, uiGraphExpression, type RawFrameGraph } from './uiGraph.js';
import type { ExecutionMode, Policy, PolicyDecision } from '../policy/types.js';

export interface BrowserSurfaceOptions {
  headless?: boolean;
  policy: Policy;
  mode: ExecutionMode;
  /** Notified for every policy decision, for the evidence log. */
  onPolicyDecision?: (action: Action, decision: PolicyDecision) => void;
  defaultTimeoutMs?: number;
  /** Upper bound on how long a screen is given to stop changing. */
  settleTimeoutMs?: number;
}

export class BrowserSurface implements Surface {
  readonly kind = 'browser' as const;

  /** nodeId prefix -> the frame that produced those nodes. */
  private frameByPrefix = new Map<string, Frame>();
  private lastObservation?: Observation;
  /** Timestamp of the last sign the page was still doing something. */
  private lastActivityAt = 0;
  /** Requests started but not yet finished or failed. */
  private inFlight = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: BrowserSurfaceOptions,
  ) {
    const touch = () => {
      this.lastActivityAt = Date.now();
    };
    // Outstanding requests are counted, not just timestamped. A response that
    // takes three seconds emits one event at the start and one at the end, so
    // an event-recency check alone sees a long quiet gap and concludes the page
    // has settled -- in the middle of exactly the slow load it was meant to
    // wait for.
    page.on('request', () => {
      this.inFlight += 1;
      touch();
    });
    page.on('requestfinished', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      touch();
    });
    page.on('requestfailed', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      touch();
    });
    page.on('framenavigated', touch);
  }

  static async launch(opts: BrowserSurfaceOptions): Promise<BrowserSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(opts.defaultTimeoutMs ?? 10_000);
    return new BrowserSurface(browser, context, page, opts);
  }

  /** Exposed so the session broker can hand this same page to a human. */
  get livePage(): Page {
    return this.page;
  }

  async observe(opts: { screenshot?: boolean } = {}): Promise<Observation> {
    await this.settle();

    this.frameByPrefix.clear();
    const nodes: UiNode[] = [];
    const texts: string[] = [];
    let rootGraph: RawFrameGraph | undefined;

    const frames = this.page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const prefix = `f${i}n`;
      const framePath = pathOf(frame);

      let graph: RawFrameGraph;
      try {
        graph = (await frame.evaluate(uiGraphExpression(prefix))) as RawFrameGraph;
      } catch (err) {
        // Child frames detach mid-observation routinely, so losing one is not a
        // failure of the observation as a whole. The main frame failing is
        // always a real bug and must not be swallowed.
        if (frame === this.page.mainFrame()) throw err;
        continue;
      }

      this.frameByPrefix.set(prefix, frame);
      if (frame === this.page.mainFrame()) rootGraph = graph;

      for (const raw of graph.nodes) {
        nodes.push(this.scrub({ ...raw, framePath }));
      }
      if (graph.text) texts.push(graph.text);
    }

    const observation: Observation = {
      observedAt: new Date().toISOString(),
      location: this.page.url(),
      title: rootGraph?.title ?? (await this.page.title().catch(() => '')),
      nodes,
      // Text comes from the same evaluation that produced the nodes, not from
      // a second pass over the frames. A second pass can observe a different
      // document than the first did -- which produced an observation whose
      // node graph showed the search screen while its text showed the member
      // detail screen, and an agent reasoning over a screen it was not on.
      text: this.opts.policy.redact(texts.join('\n').slice(0, 20_000)),
    };

    // Order matters: the mask list is derived from the nodes we just built,
    // not from the previous observation. Deriving it from `lastObservation`
    // means the first screenshot of a screen -- the one that actually shows
    // the freshly-typed password -- is captured with no masks at all.
    this.lastObservation = observation;

    if (opts.screenshot) {
      observation.screenshot = await this.screenshot(nodes);
    }

    return observation;
  }

  /**
   * Applies pattern redaction to everything a node carries outward, and marks
   * any node that needed it as sensitive.
   *
   * The second half is the part that earns its keep. A member's SSN sits in an
   * ordinary table cell with no markup saying so; flagging the node means the
   * same value is also masked in screenshots and skipped by value capture,
   * without anyone having had to enumerate "the SSN cell" in advance.
   */
  private scrub(node: UiNode): UiNode {
    const redact = (s: string | undefined) => (s === undefined ? undefined : this.opts.policy.redact(s));

    const name = this.opts.policy.redact(node.name);
    const value = redact(node.value);

    // Anchors are redacted too -- they are ambient row and section text, and
    // on these screens that is where a regulated value most often turns up as
    // a side effect of sitting next to something else.
    const anchors = {
      ...node.anchors,
      precedingText: redact(node.anchors.precedingText),
      rowText: redact(node.anchors.rowText),
      sectionText: redact(node.anchors.sectionText),
    };

    // But only the node's *own* content marks it sensitive. Tainting on anchor
    // text would spread from one SSN cell across its entire row, so the join
    // date and the "SSN" label would be masked in screenshots and refused by
    // read -- over-redaction, which is its own failure mode: a capability that
    // cannot read a join date because a neighbouring cell was regulated is
    // just broken, and it trains people to turn redaction off.
    const ownContentRedacted = name !== node.name || value !== node.value;

    return {
      ...node,
      name,
      ...(value === undefined ? {} : { value }),
      anchors,
      ...(node.sensitive || ownContentRedacted ? { sensitive: true as const } : {}),
    };
  }

  /**
   * Screenshots mask sensitive controls before the bytes ever exist, rather
   * than blurring them afterwards. Evidence for a regulated system has to be
   * safe at rest by construction.
   */
  private async screenshot(nodes: UiNode[]): Promise<Buffer> {
    const masks = nodes
      .filter((n) => n.sensitive)
      .map((n) => this.locatorFor(n.nodeId))
      .filter((l): l is NonNullable<typeof l> => Boolean(l));

    return this.page.screenshot({
      fullPage: false,
      ...(masks.length ? { mask: masks } : {}),
    });
  }

  private locatorFor(nodeId: string) {
    const prefix = nodeId.replace(/\d+$/, '');
    const frame = this.frameByPrefix.get(prefix);
    if (!frame) return undefined;
    return frame.locator(`[${NODE_ATTR}="${nodeId}"]`);
  }

  private nodeFor(nodeId: string): UiNode | undefined {
    return this.lastObservation?.nodes.find((n) => n.nodeId === nodeId);
  }

  async act(action: Action): Promise<ActResult> {
    const node = 'nodeId' in action ? this.nodeFor(action.nodeId) : undefined;
    const before = this.frameLocations();

    // --- the choke point, part one: intent ---------------------------------
    const decision = this.opts.policy.check(action, {
      mode: this.opts.mode,
      location: this.page.url(),
      node,
    });
    this.opts.onPolicyDecision?.(action, decision);

    if (decision.effect !== 'allow') {
      return {
        ok: false,
        error: decision.reason,
        refusal: {
          kind: decision.effect === 'deny' ? 'denied' : 'approval-required',
          code: decision.effect === 'deny' ? decision.code : 'APPROVAL_REQUIRED',
          reason: decision.reason,
          risk: decision.risk,
        },
      };
    }

    let result: ActResult;
    try {
      result = await this.perform(action);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // --- the choke point, part two: consequence ----------------------------
    const containment = await this.contain(before);
    return containment ?? result;
  }

  /** Where every frame currently sits, keyed by frame path. */
  private frameLocations(): Map<string, string> {
    const at = new Map<string, string>();
    for (const frame of this.page.frames()) at.set(pathOf(frame).join('/'), frame.url());
    return at;
  }

  /**
   * Re-checks where the action actually left us, and walks it back if that is
   * somewhere the allowlist would not have let us go deliberately.
   *
   * Checking intent alone is not enough, and the gap is not hypothetical: a
   * click is authorised against the page it happens *on*, so clicking a link
   * to an off-allowlist screen passes the pre-check and lands somewhere the
   * agent was never permitted to be. Predicting the destination is not an
   * option here -- an href is markup, which perception deliberately does not
   * expose (D1), and reading it would still miss form posts and scripted
   * redirects. So containment is detective rather than preventive: notice,
   * revert, and report it under its own code so a constrained run is visible
   * in evidence rather than quietly wrong.
   *
   * Every frame is checked, not just the top-level page. On a frameset the
   * whole point of a nav link is that it retargets a *child* frame while the
   * address bar never moves -- so a top-level-only check would pass while the
   * agent sat on a screen it was never allowed to open.
   */
  private async contain(before: Map<string, string>): Promise<ActResult | undefined> {
    for (const frame of this.page.frames()) {
      const key = pathOf(frame).join('/');
      const now = frame.url();
      const prev = before.get(key);

      if (now === prev || now === 'about:blank' || now === '') continue;

      const verdict = this.opts.policy.check(
        { type: 'navigate', location: now },
        { mode: this.opts.mode, location: now },
      );
      if (verdict.effect === 'allow') continue;

      const restored = prev && prev !== 'about:blank' ? prev : undefined;
      if (restored) {
        await frame.goto(restored, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await this.settle();
      }
      // Node ids were stamped against a page that no longer exists.
      this.lastObservation = undefined;

      const where = key ? `frame "${key}"` : 'the page';
      const reason =
        `Action moved ${where} to ${now}, which is outside the allowlist.` +
        (restored ? ` Returned to ${restored}.` : ' No previous location to return to.');

      this.opts.onPolicyDecision?.(
        { type: 'navigate', location: now },
        { effect: 'deny', risk: verdict.risk, code: 'NAVIGATED_OFF_ALLOWLIST', reason },
      );
      return {
        ok: false,
        error: reason,
        refusal: { kind: 'denied', code: 'NAVIGATED_OFF_ALLOWLIST', reason, risk: verdict.risk },
      };
    }

    return undefined;
  }

  private async perform(action: Action): Promise<ActResult> {
    // Taken before the action so settle() can tell "nothing happened yet" from
    // "nothing is going to happen".
    const startedAt = Date.now();

    switch (action.type) {
      case 'navigate': {
        await this.page.goto(action.location, { waitUntil: 'domcontentloaded' });
        await this.settle(startedAt);
        return { ok: true };
      }

      case 'wait': {
        await this.page.waitForTimeout(action.ms);
        return { ok: true };
      }

      case 'press': {
        await this.page.keyboard.press(action.key);
        await this.settle(startedAt);
        return { ok: true };
      }

      default:
        break;
    }

    const locator = this.locatorFor(action.nodeId);
    if (!locator) {
      return { ok: false, error: `Node ${action.nodeId} is not from the current observation.` };
    }

    switch (action.type) {
      case 'click': {
        await locator.click();
        await this.settle(startedAt);
        return { ok: true };
      }

      case 'type': {
        await locator.fill(action.text);
        return { ok: true };
      }

      case 'select': {
        await locator.selectOption({ label: action.option });
        await this.settle(startedAt);
        return { ok: true };
      }

      case 'read': {
        const node = this.nodeFor(action.nodeId);
        if (node?.sensitive) {
          return { ok: false, error: `Node ${action.nodeId} is sensitive; its value is never captured.` };
        }
        const value =
          (await locator.inputValue().catch(() => null)) ?? (await locator.innerText().catch(() => ''));
        return { ok: true, value: this.opts.policy.redact(value.trim()) };
      }
    }
  }

  /**
   * Waits for the surface to stop changing.
   *
   * Deliberately not a fixed sleep: a magic number is simultaneously too long
   * on a fast run and too short on a slow one, and "transient slowness" is one
   * of the runtime conditions replay is explicitly required to absorb.
   *
   * It is also deliberately not `page.waitForLoadState()` alone. Load state is
   * a property of the *main* frame, and on a frameset the main frame never
   * moves -- submitting the search form navigates a child frame while the
   * address bar sits on /app throughout. A main-frame-only wait therefore
   * returns instantly and the next observation reads the previous screen.
   *
   * So quiescence is measured from real page events instead: wait for the
   * action to actually start doing something (bounded by a short grace, since
   * plenty of actions correctly cause no traffic at all), then wait for the
   * traffic to stop, then confirm every frame has a document.
   */
  private async settle(actionStartedAt?: number): Promise<void> {
    const GRACE_MS = 250;
    const QUIET_MS = 300;
    const deadline = Date.now() + (this.opts.settleTimeoutMs ?? 15_000);

    if (actionStartedAt !== undefined) {
      const graceUntil = actionStartedAt + GRACE_MS;
      while (Date.now() < graceUntil && this.lastActivityAt < actionStartedAt) {
        await delay(25);
      }
    }

    while (Date.now() < deadline && (this.inFlight > 0 || Date.now() - this.lastActivityAt < QUIET_MS)) {
      await delay(50);
    }

    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await Promise.all(
      this.page.frames().map((f) => f.waitForLoadState('domcontentloaded').catch(() => {})),
    );
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathOf(frame: Frame): string[] {
  const path: string[] = [];
  let cur: Frame | null = frame;
  while (cur && cur.parentFrame()) {
    path.unshift(cur.name() || '<anonymous>');
    cur = cur.parentFrame();
  }
  return path;
}
