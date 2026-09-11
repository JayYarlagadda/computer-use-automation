/**
 * "Meridian CoreBank Servicing" -- a mock credit-union back-office.
 *
 * This is the target surface, not part of the system being evaluated. It is a
 * stand-in for the legacy applications described in the brief, and it is built
 * hostile on purpose: a frameset, table layout, no test IDs, and form fields
 * with no label association. See views.ts for why that matters.
 *
 * One app factory, two tenants. Every piece of mutable state -- sessions,
 * armed faults -- belongs to the instance rather than the module, so a test
 * can run both tenants side by side in one process and the cross-tenant
 * scenario does not need two terminals.
 *
 *   npm run target                      # tenant A on :4173
 *   npm run target:b                    # tenant B on :4174
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { tenantFor, type TenantConfig } from './tenants.js';
import { findMember, isWellFormedMemberId } from './data/members.js';
import { FaultBox, type FaultKind } from './faults.js';
import * as V from './views.js';

// Demo credentials for a local mock app. Deliberately trivial and documented
// on the sign-on screen; no real credential ever enters this system.
export const DEMO_USER = 'operator';
export const DEMO_PASS = 'demo1234';

export interface MeridianApp {
  app: Express;
  tenant: TenantConfig;
  /** Exposed so in-process tests can arm faults without an HTTP round trip. */
  faults: FaultBox;
}

export function createMeridianApp(tenant: TenantConfig): MeridianApp {
  const faults = new FaultBox();
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

    const slow = faults.consume('slow', req.path);
    if (slow) await new Promise((r) => setTimeout(r, slow.delayMs ?? 4000));

    if (faults.consume('app_error', req.path)) {
      res.status(500).send(V.appErrorScreen(tenant));
      return;
    }

    if (faults.consume('session_expired', req.path)) {
      const token = cookies(req).sid;
      if (token) sessions.delete(token);
      res.send(V.loginPage(tenant, 'Your session has expired. Please sign on again.'));
      return;
    }

    if (faults.consume('interstitial', req.path)) {
      res.send(V.interstitialScreen(tenant, req.originalUrl));
      return;
    }

    next();
  }

  function requireSession(req: Request, res: Response, next: NextFunction) {
    const token = cookies(req).sid;
    if (!token || !sessions.has(token)) {
      res.send(V.loginPage(tenant, 'Your session has expired. Please sign on again.'));
      return;
    }
    next();
  }

  app.use(faultGate);

  // --- Fault control surface -----------------------------------------------
  // Used by the replay demo to reproduce each runtime condition on demand.

  app.get('/_admin/faults', (_req, res) => {
    res.json({ tenant: tenant.id, armed: faults.list() });
  });

  app.post('/_admin/faults', express.json(), (req, res) => {
    const { kind, count, delayMs, onPath } = req.body as {
      kind: FaultKind;
      count?: number;
      delayMs?: number;
      onPath?: string;
    };
    faults.arm(kind, count ?? 1, { ...(delayMs !== undefined ? { delayMs } : {}), ...(onPath ? { onPath } : {}) });
    res.json({ ok: true, armed: faults.list() });
  });

  app.delete('/_admin/faults', (_req, res) => {
    faults.clear();
    res.json({ ok: true, armed: [] });
  });

  app.get('/_admin/health', (_req, res) => {
    res.json({ ok: true, tenant: tenant.id, product: tenant.product, version: tenant.productVersion });
  });

  // --- Sign on -------------------------------------------------------------

  app.get('/', (_req, res) => res.send(V.loginPage(tenant)));

  app.post('/login', (req, res) => {
    const { user, pass } = req.body as { user?: string; pass?: string };
    if (user !== DEMO_USER || pass !== DEMO_PASS) {
      res.send(V.loginPage(tenant, 'Invalid operator ID or password.'));
      return;
    }
    const sid = randomUUID();
    sessions.set(sid, { user, startedAt: Date.now() });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    // Tenant B interrupts sign-on with a notice; tenant A goes straight through.
    res.redirect(tenant.loginInterstitial ? '/notice?next=/app' : '/app');
  });

  app.get('/logout', (req, res) => {
    const token = cookies(req).sid;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    res.redirect('/');
  });

  app.get('/notice', requireSession, (req, res) => {
    res.send(V.interstitialScreen(tenant, String(req.query.next ?? '/app')));
  });

  // --- Application shell ---------------------------------------------------

  app.get('/app', requireSession, (_req, res) => res.send(V.appFrameset(tenant)));
  app.get('/nav', requireSession, (_req, res) => res.send(V.navFrame(tenant)));
  app.get('/transactions', requireSession, (_req, res) => res.send(V.transactionsScreen(tenant)));
  app.get('/admin', requireSession, (_req, res) => res.send(V.adminScreen(tenant)));

  // --- Member search -------------------------------------------------------

  app.get('/search', requireSession, (_req, res) => res.send(V.searchScreen(tenant)));

  app.post('/search', requireSession, (req, res) => {
    const raw = String((req.body as { memberId?: string }).memberId ?? '');

    // Malformed input is a *form validation error*, distinct from a lookup that
    // legitimately finds nothing. Replay needs to tell these apart.
    if (!isWellFormedMemberId(raw)) {
      res.send(V.searchScreen(tenant, { error: 'Member number must be exactly 6 digits.' }));
      return;
    }

    const member = findMember(raw);
    if (!member) {
      res.send(V.searchScreen(tenant, { notFound: `No member found for number ${raw}.` }));
      return;
    }

    res.redirect(`/member/${member.memberId}`);
  });

  // --- Member detail -------------------------------------------------------

  app.get('/member/:id', requireSession, (req, res) => {
    const id = String(req.params.id);
    const member = findMember(id);
    if (!member) {
      res.send(V.searchScreen(tenant, { notFound: `No member found for number ${id}.` }));
      return;
    }
    if (member.restricted || faults.consume('permission_denied')) {
      res.status(403).send(V.permissionDeniedScreen(tenant, id));
      return;
    }
    res.send(V.memberScreen(tenant, member));
  });

  // --- Irreversible action -------------------------------------------------

  app.get('/member/:id/adjust', requireSession, (req, res) => {
    const member = findMember(String(req.params.id));
    if (!member) {
      res.send(V.searchScreen(tenant, { notFound: `No member found for number ${req.params.id}.` }));
      return;
    }
    res.send(V.adjustScreen(tenant, member));
  });

  app.post('/member/:id/adjust', requireSession, (req, res) => {
    // Intentionally a real state change with no undo on the screen. The policy
    // layer is expected to never reach this unattended.
    const member = findMember(String(req.params.id));
    if (!member) {
      res.send(V.searchScreen(tenant, { notFound: 'No member found.' }));
      return;
    }
    res.send(
      V.memberScreen(tenant, member).replace(
        '<b>Member Detail</b>',
        '<b>Member Detail</b> &mdash; <font color="#006000">Adjustment posted.</font>',
      ),
    );
  });

  return { app, tenant, faults };
}

export interface MeridianHandle extends MeridianApp {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a tenant on `port`, or on an OS-assigned port when `port` is 0.
 * Tests use 0 so a developer's own `npm run target` on :4173 does not collide
 * with a test run.
 */
export async function startMeridian(
  opts: { tenant?: string; port?: number } = {},
): Promise<MeridianHandle> {
  const tenant = tenantFor(opts.tenant);
  const built = createMeridianApp(tenant);

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = built.app.listen(opts.port ?? 0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    ...built,
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run as a CLI only when invoked directly, so importing this module for tests
// does not start listening.
const invokedDirectly =
  !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  // Flags as well as env vars, so `npm run target:b` is one portable string
  // rather than a shell-specific `VAR=x cmd` that breaks on Windows.
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };

  const handle = await startMeridian({
    tenant: flag('tenant') ?? process.env.MERIDIAN_TENANT,
    port: Number(flag('port') ?? process.env.PORT ?? process.env.MERIDIAN_PORT ?? 4173),
  });
  console.log(
    `[meridian] tenant=${handle.tenant.id} "${handle.tenant.institution}" ${handle.tenant.product} v${handle.tenant.productVersion}`,
  );
  console.log(`[meridian] ${handle.url}/  (${DEMO_USER} / ${DEMO_PASS})`);
}
