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
}

export class PolicyDenied extends Error {
  constructor(
    readonly decision: Extract<PolicyDecision, { effect: 'deny' }>,
    readonly action: Action,
  ) {
    super(decision.reason);
    this.name = 'PolicyDenied';
  }
}

export class ApprovalRequired extends Error {
  constructor(
    readonly decision: Extract<PolicyDecision, { effect: 'require-approval' }>,
    readonly action: Action,
  ) {
    super(decision.reason);
    this.name = 'ApprovalRequired';
  }
}

export class BrowserSurface implements Surface {
  readonly kind = 'browser' as const;

  /** nodeId prefix -> the frame that produced those nodes. */
  private frameByPrefix = new Map<string, Frame>();
  private lastObservation?: Observation;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: BrowserSurfaceOptions,
  ) {}

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
        nodes.push({ ...raw, framePath });
      }
    }

    const observation: Observation = {
      observedAt: new Date().toISOString(),
      location: this.page.url(),
      title: rootGraph?.title ?? (await this.page.title().catch(() => '')),
      nodes,
      text: await this.visibleText(),
    };

    if (opts.screenshot) {
      observation.screenshot = await this.screenshot();
    }

    this.lastObservation = observation;
    return observation;
  }

  /**
   * Screenshots mask sensitive controls before the bytes ever exist, rather
   * than blurring them afterwards. Evidence for a regulated system has to be
   * safe at rest by construction.
   */
  private async screenshot(): Promise<Buffer> {
    const masks = this.lastObservation?.nodes
      .filter((n) => n.sensitive)
      .map((n) => this.locatorFor(n.nodeId))
      .filter((l): l is NonNullable<typeof l> => Boolean(l));

    return this.page.screenshot({
      fullPage: false,
      ...(masks && masks.length ? { mask: masks } : {}),
    });
  }

  private async visibleText(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      try {
        parts.push(await frame.evaluate(() => document.body?.innerText ?? ''));
      } catch {
        /* detached */
      }
    }
    return parts.join('\n').replace(/\s+\n/g, '\n').slice(0, 20_000);
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

    // --- the choke point ---------------------------------------------------
    const decision = this.opts.policy.check(action, {
      mode: this.opts.mode,
      location: this.page.url(),
      node,
    });
    this.opts.onPolicyDecision?.(action, decision);

    if (decision.effect === 'deny') throw new PolicyDenied(decision, action);
    if (decision.effect === 'require-approval') throw new ApprovalRequired(decision, action);
    // -----------------------------------------------------------------------

    try {
      return await this.perform(action);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async perform(action: Action): Promise<ActResult> {
    switch (action.type) {
      case 'navigate': {
        await this.page.goto(action.location, { waitUntil: 'domcontentloaded' });
        await this.settle();
        return { ok: true };
      }

      case 'wait': {
        await this.page.waitForTimeout(action.ms);
        return { ok: true };
      }

      case 'press': {
        await this.page.keyboard.press(action.key);
        await this.settle();
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
        await this.settle();
        return { ok: true };
      }

      case 'type': {
        await locator.fill(action.text);
        return { ok: true };
      }

      case 'select': {
        await locator.selectOption({ label: action.option });
        await this.settle();
        return { ok: true };
      }

      case 'read': {
        const value =
          (await locator.inputValue().catch(() => null)) ?? (await locator.innerText().catch(() => ''));
        return { ok: true, value: value.trim() };
      }
    }
  }

  /**
   * Deliberately not a fixed sleep. Waiting on network idle plus frame load
   * means a slow screen is absorbed by waiting longer, not by a magic number
   * that is simultaneously too long on a fast run and too short on a slow one.
   */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
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
