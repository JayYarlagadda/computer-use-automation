/**
 * Builds the UI graph for one frame, in page context.
 *
 * This runs inside the browser, so it must be entirely self-contained -- no
 * imports, no closure over module scope. Playwright serialises the function
 * source and evaluates it in each frame.
 *
 * Why compute this ourselves rather than take Playwright's accessibility
 * snapshot: we need three things that snapshot does not give us together --
 * bounding boxes, the anchor evidence used to build durable locators (the
 * preceding cell's text, the containing row's text, the governing section
 * heading), and control over which elements count. On table-laid-out legacy
 * screens the "label" for a field is simply the cell to its left, and that
 * relationship is invisible to a standard AX snapshot. Extracting it here is
 * what makes anchor-relative targeting possible at all.
 *
 * The nodeId is stamped onto the element as an attribute so the executor can
 * act on exactly the node it showed the caller. That attribute is ephemeral:
 * it is rewritten on every observation and is never recorded into an artifact.
 */

/** Shape returned from page context; mirrors UiNode minus the frame path. */
export interface RawNode {
  nodeId: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  sensitive?: boolean;
  bbox: { x: number; y: number; width: number; height: number };
  anchors: {
    precedingText?: string;
    rowText?: string;
    sectionText?: string;
    ordinalInRole: number;
    debugTag?: string;
  };
}

export interface RawFrameGraph {
  nodes: RawNode[];
  title: string;
  location: string;
  text: string;
}

export const NODE_ATTR = 'data-cua-node';

/**
 * Wraps the collector as a self-contained expression for frame.evaluate().
 *
 * Passing the function directly does not work: the TypeScript loader compiles
 * named inner functions with esbuild's `keepNames` helper, so the serialised
 * source contains calls to `__name` -- which is a bundler artifact that exists
 * in the Node module scope and not in the page. Evaluating the source inside
 * an IIFE that declares its own `__name` makes the script independent of how
 * (or whether) the build tool rewrites it.
 */
export function uiGraphExpression(prefix: string): string {
  return `(() => {
    var __name = (fn) => fn;
    return (${collectUiGraph.toString()})(${JSON.stringify(prefix)});
  })()`;
}

/**
 * Serialised and evaluated in the browser. `prefix` namespaces node ids per
 * frame so ids are unique across the whole observation.
 */
export function collectUiGraph(prefix: string): RawFrameGraph {
  const ATTR = 'data-cua-node';

  const clean = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim();

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    // Non-semantic elements wired up with inline handlers -- common in legacy
    // apps, and invisible to a naive "look for <button>" scan.
    if (el.hasAttribute('onclick')) return 'button';
    return null;
  };

  /** Simplified accessible-name computation, in ARIA precedence order. */
  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const txt = labelledBy
        .split(/\s+/)
        .map((id) => clean(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ');
      if (txt) return txt;
    }

    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const tag = el.tagName.toLowerCase();

    // Button-like inputs take their name from the value attribute.
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(el.getAttribute('value'));
    }

    // Proper label wiring. Legacy screens usually lack this entirely, which is
    // exactly why the anchors below exist.
    const id = el.getAttribute('id');
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) return clean(lbl.textContent);
    }
    const ancestorLabel = el.closest('label');
    if (ancestorLabel) return clean(ancestorLabel.textContent);

    if (tag === 'img') return clean(el.getAttribute('alt'));

    const title = clean(el.getAttribute('title'));
    if (title) return title;

    // Text-bearing controls name themselves.
    if (tag === 'a' || tag === 'button' || tag === 'td' || tag === 'th' || tag === 'summary') {
      return clean(el.textContent).slice(0, 120);
    }

    return '';
  };

  const isSensitive = (el: Element): boolean => {
    if (el.tagName.toLowerCase() !== 'input') return false;
    return (el.getAttribute('type') ?? '').toLowerCase() === 'password';
  };

  const valueOf = (el: Element): string | undefined => {
    if (isSensitive(el)) return undefined;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      return (el as HTMLInputElement).value || undefined;
    }
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      return sel.options[sel.selectedIndex]?.text || undefined;
    }
    return undefined;
  };

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /**
   * The label-by-adjacency heuristic. On a table-laid-out screen the field's
   * label is the text of the previous cell; failing that, the text
   * immediately before the element in its parent.
   */
  const precedingTextOf = (el: Element): string | undefined => {
    const cell = el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = clean(prev.textContent);
        if (t) return t.slice(0, 120);
        prev = prev.previousElementSibling;
      }
    }
    let sib = el.previousSibling;
    while (sib) {
      const t = clean(sib.textContent);
      if (t) return t.slice(0, 120);
      sib = sib.previousSibling;
    }
    const parentCellText = clean(cell?.textContent);
    return parentCellText ? parentCellText.slice(0, 120) : undefined;
  };

  const rowTextOf = (el: Element): string | undefined => {
    const row = el.closest('tr');
    if (!row) return undefined;
    const t = clean(row.textContent);
    return t ? t.slice(0, 240) : undefined;
  };

  /**
   * Nearest governing heading. Walks up looking for a real heading, then falls
   * back to the first cell of a table's header-ish first row -- which is how
   * these screens actually title their sections.
   */
  const sectionTextOf = (el: Element): string | undefined => {
    let cur: Element | null = el;
    while (cur) {
      let sib: Element | null = cur.previousElementSibling;
      while (sib) {
        if (/^h[1-6]$/i.test(sib.tagName)) {
          const t = clean(sib.textContent);
          if (t) return t.slice(0, 120);
        }
        sib = sib.previousElementSibling;
      }
      const table = cur.closest('table');
      if (table) {
        const firstRow = table.querySelector('tr');
        if (firstRow && !firstRow.contains(el)) {
          const t = clean(firstRow.textContent);
          if (t) return t.slice(0, 120);
        }
      }
      cur = cur.parentElement;
    }
    return undefined;
  };

  // Clear stamps from the previous observation so ids never go stale.
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

  const nodes: RawNode[] = [];
  const roleCounts: Record<string, number> = {};
  let seq = 0;

  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    const role = roleOf(el);
    if (!role) continue;

    const name = nameOf(el);
    const visible = isVisible(el);

    if (role === 'cell' || role === 'columnheader') {
      // Cells are collected because reading data out of a table is a
      // first-class action, but an empty cell is noise.
      if (!name) continue;

      // So is a layout cell. Legacy screens nest tables several deep for
      // positioning, and an outer cell's text is the concatenation of
      // everything inside it -- which bloats the model's view of the screen,
      // makes targeting ambiguous (two nodes "named" the same data), and
      // produces exactly the run-together strings that defeat pattern-based
      // redaction. A cell that contains another cell is structure, not data.
      if (el.querySelector('td, th')) continue;
    }
    if (!visible) continue;

    const rect = el.getBoundingClientRect();
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;

    const nodeId = `${prefix}${seq++}`;
    el.setAttribute(ATTR, nodeId);

    nodes.push({
      nodeId,
      role,
      name,
      value: valueOf(el),
      enabled: !(el as HTMLInputElement).disabled,
      visible,
      focused: document.activeElement === el,
      sensitive: isSensitive(el) || undefined,
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      anchors: {
        precedingText: precedingTextOf(el),
        rowText: rowTextOf(el),
        sectionText: sectionTextOf(el),
        ordinalInRole: roleCounts[role]! - 1,
        debugTag: el.tagName.toLowerCase(),
      },
    });
  }

  return {
    nodes,
    title: document.title,
    location: location.href,
    // Line structure is preserved deliberately. Checkpoint predicates match
    // against this text, and collapsing newlines runs adjacent table cells
    // together -- which both weakens the predicates and manufactures the
    // concatenated strings that pattern redaction has the hardest time with.
    text: (document.body?.innerText ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000),
  };
}
