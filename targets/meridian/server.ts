/**
 * "Meridian CoreBank Servicing" -- a mock credit-union back-office.
 *
 * This is the target surface, not part of the system being evaluated. It is a
 * stand-in for the legacy applications described in the brief, and it is built
 * hostile on purpose: a frameset, table layout, no test IDs, and form fields
 * with no label association. See views.ts for why that matters.
 *
 * One server, two tenants. Run it twice on two ports with MERIDIAN_TENANT=a|b
 * to get two institutions running the same vendor product with different
 * wording -- the cross-tenant reuse scenario.
 *
 *   npm run target                      # tenant A on :4173
 *   MERIDIAN_TENANT=b PORT=4174 npm run target
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { tenantFor } from './tenants.js';
import { findMember, isWellFormedMemberId } from './data/members.js';
import { armFault, clearFaults, consumeFault, listFaults, type FaultKind } from './faults.js';
import * as V from './views.js';

const TENANT = tenantFor(process.env.MERIDIAN_TENANT);
const PORT = Number(process.env.PORT ?? process.env.MERIDIAN_PORT ?? 4173);

// Demo credentials for a local mock app. Deliberately trivial and documented
// in the sign-on screen; no real credential ever enters this system.
const DEMO_USER = 'operator';
const DEMO_PASS = 'demo1234';

const sessions = new Map<string, { user: string; startedAt: number }>();

const app = express();
app.use(express.urlencoded({ extended: false }));

function cookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1))];
    }),
  );
}

/** Applies faults that can affect any authenticated screen. */
async function faultGate(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith('/_admin') || req.path === '/login' || req.path === '/') return next();

  const slow = consumeFault('slow');
  if (slow) await new Promise((r) => setTimeout(r, slow.delayMs ?? 4000));

  if (consumeFault('app_error')) {
    res.status(500).send(V.appErrorScreen(TENANT));
    return;
  }

  if (consumeFault('session_expired')) {
    const token = cookies(req).sid;
    if (token) sessions.delete(token);
    res.send(V.loginPage(TENANT, 'Your session has expired. Please sign on again.'));
    return;
  }

  if (consumeFault('interstitial')) {
    res.send(V.interstitialScreen(TENANT, req.originalUrl));
    return;
  }

  next();
}

function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = cookies(req).sid;
  if (!token || !sessions.has(token)) {
    res.send(V.loginPage(TENANT, 'Your session has expired. Please sign on again.'));
    return;
  }
  next();
}

app.use(faultGate);

// --- Fault control surface -------------------------------------------------
// Used by the replay demo to reproduce each runtime condition on demand.

app.get('/_admin/faults', (_req, res) => {
  res.json({ tenant: TENANT.id, armed: listFaults() });
});

app.post('/_admin/faults', express.json(), (req, res) => {
  const { kind, count, delayMs } = req.body as { kind: FaultKind; count?: number; delayMs?: number };
  armFault(kind, count ?? 1, delayMs);
  res.json({ ok: true, armed: listFaults() });
});

app.delete('/_admin/faults', (_req, res) => {
  clearFaults();
  res.json({ ok: true, armed: [] });
});

app.get('/_admin/health', (_req, res) => {
  res.json({ ok: true, tenant: TENANT.id, product: TENANT.product, version: TENANT.productVersion });
});

// --- Sign on ---------------------------------------------------------------

app.get('/', (_req, res) => res.send(V.loginPage(TENANT)));

app.post('/login', (req, res) => {
  const { user, pass } = req.body as { user?: string; pass?: string };
  if (user !== DEMO_USER || pass !== DEMO_PASS) {
    res.send(V.loginPage(TENANT, 'Invalid operator ID or password.'));
    return;
  }
  const sid = randomUUID();
  sessions.set(sid, { user, startedAt: Date.now() });
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
  // Tenant B interrupts sign-on with a notice; tenant A goes straight through.
  res.redirect(TENANT.loginInterstitial ? '/notice?next=/app' : '/app');
});

app.get('/logout', (req, res) => {
  const token = cookies(req).sid;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.redirect('/');
});

app.get('/notice', requireSession, (req, res) => {
  res.send(V.interstitialScreen(TENANT, String(req.query.next ?? '/app')));
});

// --- Application shell -----------------------------------------------------

app.get('/app', requireSession, (_req, res) => res.send(V.appFrameset(TENANT)));
app.get('/nav', requireSession, (_req, res) => res.send(V.navFrame(TENANT)));
app.get('/transactions', requireSession, (_req, res) => res.send(V.transactionsScreen(TENANT)));
app.get('/admin', requireSession, (_req, res) => res.send(V.adminScreen(TENANT)));

// --- Member search ---------------------------------------------------------

app.get('/search', requireSession, (_req, res) => res.send(V.searchScreen(TENANT)));

app.post('/search', requireSession, (req, res) => {
  const raw = String((req.body as { memberId?: string }).memberId ?? '');

  // Malformed input is a *form validation error*, distinct from a lookup that
  // legitimately finds nothing. Replay needs to tell these apart.
  if (!isWellFormedMemberId(raw)) {
    res.send(V.searchScreen(TENANT, { error: 'Member number must be exactly 6 digits.' }));
    return;
  }

  const member = findMember(raw);
  if (!member) {
    res.send(V.searchScreen(TENANT, { notFound: `No member found for number ${raw}.` }));
    return;
  }

  res.redirect(`/member/${member.memberId}`);
});

// --- Member detail ---------------------------------------------------------

app.get('/member/:id', requireSession, (req, res) => {
  const id = String(req.params.id);
  const member = findMember(id);
  if (!member) {
    res.send(V.searchScreen(TENANT, { notFound: `No member found for number ${id}.` }));
    return;
  }
  if (member.restricted || consumeFault('permission_denied')) {
    res.status(403).send(V.permissionDeniedScreen(TENANT, id));
    return;
  }
  res.send(V.memberScreen(TENANT, member));
});

// --- Irreversible action ---------------------------------------------------

app.get('/member/:id/adjust', requireSession, (req, res) => {
  const member = findMember(String(req.params.id));
  if (!member) {
    res.send(V.searchScreen(TENANT, { notFound: `No member found for number ${req.params.id}.` }));
    return;
  }
  res.send(V.adjustScreen(TENANT, member));
});

app.post('/member/:id/adjust', requireSession, (req, res) => {
  // Intentionally a real state change with no undo on the screen. The policy
  // layer is expected to never reach this unattended.
  const member = findMember(String(req.params.id));
  if (!member) {
    res.send(V.searchScreen(TENANT, { notFound: 'No member found.' }));
    return;
  }
  res.send(
    V.memberScreen(TENANT, member).replace(
      '<b>Member Detail</b>',
      '<b>Member Detail</b> &mdash; <font color="#006000">Adjustment posted.</font>',
    ),
  );
});

app.listen(PORT, () => {
  console.log(
    `[meridian] tenant=${TENANT.id} "${TENANT.institution}" ${TENANT.product} v${TENANT.productVersion}`,
  );
  console.log(`[meridian] http://127.0.0.1:${PORT}/  (operator / demo1234)`);
});
