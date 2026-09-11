/**
 * Exercises the perception layer against the real target app.
 *
 * This is the check that the central design bet actually holds: that a graph
 * built from roles, accessible names and adjacency evidence is enough to drive
 * a frameset-based, table-laid-out screen with no test IDs -- and specifically
 * that inputs with no accessible name are still reachable via their anchors.
 *
 *   npx tsx tests/surface.smoke.ts
 */

import { BrowserSurface } from '../src/surface/browserSurface.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { UiNode } from '../src/surface/types.js';

const BASE = 'http://127.0.0.1:4173';

function show(nodes: UiNode[], label: string) {
  console.log(`\n--- ${label} (${nodes.length} nodes) ---`);
  for (const n of nodes) {
    const frame = n.framePath.length ? `[${n.framePath.join('/')}] ` : '';
    const anchor = n.anchors.precedingText ? ` <- "${n.anchors.precedingText}"` : '';
    console.log(`  ${frame}${n.role.padEnd(13)} name="${n.name}"${anchor}`);
  }
}

const surface = await BrowserSurface.launch({
  headless: true,
  policy: new PolicyEngine(),
  mode: 'discovery',
});

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// --- Sign-on screen --------------------------------------------------------
await surface.act({ type: 'navigate', location: `${BASE}/` });
let obs = await surface.observe();
show(obs.nodes.filter((n) => n.role !== 'cell'), 'sign-on: controls');

const signOn = obs.nodes.find((n) => n.role === 'button' && n.name === 'Sign On');
check(!!signOn, 'button "Sign On" resolves by role+name');

const pwd = obs.nodes.find((n) => n.sensitive);
check(!!pwd, 'password field is flagged sensitive');
check(pwd?.name === '', 'password field has NO accessible name (as in real legacy markup)');
check(pwd?.anchors.precedingText === 'Password', 'password field is reachable via its adjacent label cell');
check(pwd?.value === undefined, 'sensitive field value is never captured');

// --- Sign on, then the frameset -------------------------------------------
const userField = obs.nodes.find((n) => n.role === 'textbox' && n.anchors.precedingText === 'Operator ID');
check(!!userField, 'operator ID field found by anchor, not by name');
await surface.act({ type: 'type', nodeId: userField!.nodeId, text: 'operator' });
await surface.act({ type: 'type', nodeId: pwd!.nodeId, text: 'demo1234', secret: true });
await surface.act({ type: 'click', nodeId: signOn!.nodeId });

obs = await surface.observe();
const framed = obs.nodes.filter((n) => n.framePath.length > 0);
check(framed.length > 0, 'nodes are discovered inside frames');
const frameNames = [...new Set(framed.map((n) => n.framePath.join('/')))];
console.log(`  frames seen: ${frameNames.join(', ')}`);
check(frameNames.includes('navFrame'), 'navFrame contents are perceived');
check(frameNames.includes('contentFrame'), 'contentFrame contents are perceived');

// --- Search screen: the anchor-relative case ------------------------------
show(obs.nodes.filter((n) => n.role === 'textbox' || n.role === 'button' || n.role === 'link'), 'app: controls across frames');

const memberField = obs.nodes.find(
  (n) => n.role === 'textbox' && n.anchors.precedingText === 'Member ID',
);
check(!!memberField, 'Member ID input found ONLY via anchor (it has no accessible name)');
check(memberField?.name === '', 'confirming the Member ID input really has no name');

const searchBtn = obs.nodes.find((n) => n.role === 'button' && n.name === 'Search');
check(!!searchBtn, 'Search button resolves by role+name');

await surface.act({ type: 'type', nodeId: memberField!.nodeId, text: '100245' });
await surface.act({ type: 'click', nodeId: searchBtn!.nodeId });

obs = await surface.observe();
check(obs.text.includes('Dana Whitfield'), 'reached member detail for 100245');

// --- Reading data out of a table ------------------------------------------
const savingsRow = obs.nodes.find(
  (n) => n.role === 'cell' && n.anchors.rowText?.includes('Savings') && /^\$[\d,]+\.\d\d$/.test(n.name),
);
check(!!savingsRow, 'savings balance cell located by its row context');
if (savingsRow) {
  const read = await surface.act({ type: 'read', nodeId: savingsRow.nodeId });
  check(read.value === '$4,182.55', `read savings balance -> ${read.value}`);
}

// --- Policy choke point ---------------------------------------------------
const adjustLink = obs.nodes.find((n) => n.role === 'link' && /Post Balance Adjustment/i.test(n.name));
check(!!adjustLink, 'found the irreversible action link');

const unattended = await BrowserSurface.launch({
  headless: true,
  policy: new PolicyEngine(),
  mode: 'unattended',
});
await unattended.act({ type: 'navigate', location: `${BASE}/` });
const denied = await unattended
  .act({ type: 'navigate', location: 'https://example.com/' })
  .then(() => null)
  .catch((e: Error) => e);
check(denied?.name === 'PolicyDenied', 'navigating off the allowlist is denied at the choke point');
await unattended.close();

await surface.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
