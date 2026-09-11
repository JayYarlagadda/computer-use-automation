/**
 * The surface abstraction.
 *
 * This is the seam the brief asks about in 3.7: the boundary between "how we
 * perceive and act on a surface" and "the recorded flow". Everything above
 * this file -- the agent loop, the artifact schema, the replay engine -- is
 * written against these types and has no idea whether it is driving a browser,
 * a native desktop window, or a screenshot.
 *
 * The vocabulary is deliberately that of an accessibility tree: role, name,
 * value, state. Browsers expose it; Windows UIA, macOS AX and AT-SPI expose
 * the same shape for desktop applications. Choosing the intersection of those
 * representations is what makes a desktop surface a new implementation of this
 * interface rather than a rewrite of everything above it.
 *
 * What is deliberately NOT here: selectors, HTML, CSS, the DOM. A UiNode has
 * no `selector` field. The layers above cannot depend on markup because they
 * are never given any.
 */

import type { RiskClass } from '../policy/types.js';

/**
 * A control on the surface, as an operator would perceive it.
 *
 * `nodeId` is ephemeral -- valid only within the observation that produced it.
 * It is a handle for "act on the thing I just showed you", never something to
 * persist. Durable targeting is TargetDescriptor's job (see artifact schema);
 * conflating the two is how recorded flows end up depending on DOM ordering.
 */
export interface UiNode {
  nodeId: string;
  /** Accessibility role: button, textbox, link, cell, dialog, checkbox, ... */
  role: string;
  /** Accessible name -- often empty on legacy surfaces with no label wiring. */
  name: string;
  /** Current value for inputs/selects. Redacted before it reaches a model. */
  value?: string;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  /**
   * Marks a control whose value is regulated or secret (password fields, and
   * fields the policy layer flags as PII). Values of sensitive nodes are never
   * captured into observations, artifacts, logs, or model prompts, and their
   * bounding boxes are masked in screenshots.
   */
  sensitive?: boolean;
  /**
   * Path of frame names from the root to this node's document.
   * Empty for top-level. Framesets are ubiquitous in the target environment,
   * so frame identity is part of a node's identity rather than an afterthought.
   */
  framePath: string[];
  bbox: BoundingBox;
  /**
   * Raw evidence used to build durable locators at record time: nearby text,
   * the row/column a cell sits in, ordinal position. Available to the locator
   * compiler, never shown to the model.
   */
  anchors: NodeAnchors;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeAnchors {
  /** Text of the cell/element immediately preceding -- the de facto label on
   *  table-laid-out legacy screens where no <label for> exists. */
  precedingText?: string;
  /** Text content of the containing row, if any. */
  rowText?: string;
  /** Heading or section title governing this node's region. */
  sectionText?: string;
  /** Index among siblings sharing the same role, within the same frame. */
  ordinalInRole: number;
  /** Tag name, kept only for debugging evidence -- never used for targeting. */
  debugTag?: string;
}

/** A full perception of the surface at one instant. */
export interface Observation {
  observedAt: string;
  /** Logical location: URL for web, window title/app id for desktop. */
  location: string;
  title: string;
  nodes: UiNode[];
  /** PNG bytes. Optional because not every surface can cheaply produce one. */
  screenshot?: Buffer;
  /** Visible text of the surface, used for checkpoint predicates. */
  text: string;
}

/** The action vocabulary. Intentionally small and surface-neutral. */
export type Action =
  | { type: 'click'; nodeId: string }
  | { type: 'type'; nodeId: string; text: string; secret?: boolean }
  | { type: 'select'; nodeId: string; option: string }
  | { type: 'press'; key: string }
  | { type: 'navigate'; location: string }
  | { type: 'read'; nodeId: string }
  | { type: 'wait'; ms: number };

export type ActionType = Action['type'];

/**
 * An action that was refused rather than attempted.
 *
 * This is a *value*, not an exception, because the two callers both need to
 * carry on afterwards: the discovery loop tells the model "that was refused,
 * choose differently" and takes another turn, and the replay executor routes
 * an `approval-required` refusal into escalation. Throwing would force both to
 * reconstruct control flow from a catch block.
 */
export interface ActRefusal {
  /** `denied` is final. `approval-required` is a request for a human. */
  kind: 'denied' | 'approval-required';
  /** Stable machine-readable cause; see PolicyDenialCode. */
  code: string;
  reason: string;
  risk: RiskClass;
}

export interface ActResult {
  ok: boolean;
  /** Populated for `read`. */
  value?: string;
  /** Why the action could not be performed, if it could not. */
  error?: string;
  /**
   * Set when the action was refused by policy rather than failing
   * mechanically. `ok` is false either way, but the distinction matters: a
   * refusal is the system working, a failure is the surface not cooperating.
   */
  refusal?: ActRefusal;
}

/**
 * A surface the system can perceive and drive.
 *
 * Implementations: BrowserSurface (built), DesktopSurface (documented seam).
 */
export interface Surface {
  readonly kind: 'browser' | 'desktop' | 'screenshot';
  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  close(): Promise<void>;
}
