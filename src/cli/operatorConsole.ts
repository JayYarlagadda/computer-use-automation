/**
 * The operator console, server side.
 *
 * A run owns its browser, so the session a person has to take over lives in
 * the process that started the run. The operator is somebody else, at another
 * desk, who was not watching when it stopped. Those two facts together are the
 * whole reason this is a socket rather than a prompt on the run's own stdin:
 * the thing that *has* the session and the person who must *take* it are not
 * in the same place.
 *
 * What goes across the seam is deliberately thin -- list what is waiting, take
 * one, hand it back with a disposition -- because those are exactly the three
 * transitions the control state machine defines. The console is not given a
 * way to drive the page. It cannot be: the operator drives the real browser
 * window with their own hands, which is what "the same live session" means,
 * and a remote-control channel would be a second way to act on a session whose
 * central guarantee is that there is only ever one holder.
 *
 * There is no HTML. The operator's eyes are on the live Chromium window the
 * run left open; a second rendering of a screenshot beside it would be a
 * staler copy of what they are already looking at. `npm run operator` renders
 * this API in a terminal, and that is the only client.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ControlError, type Disposition, type Intervention } from '../hitl/index.js';
import type { SessionBroker } from '../hitl/index.js';

export const DISPOSITIONS: Disposition[] = ['completed', 'rejected', 'abandoned'];

export interface OperatorConsoleOptions {
  broker: SessionBroker;
  /** 0 asks the OS for a free port, which is what tests want. */
  port?: number;
  /** Where this run's screenshots and observations are, for the client to open. */
  evidencePath?: string;
  /** Identifies the run in the console's banner. */
  capabilityId?: string;
}

/** What `GET /api/session` reports. Also the shape the terminal client parses. */
export interface SessionView {
  sessionId: string;
  controlState: string;
  capabilityId?: string;
  evidencePath?: string;
  interventions: Intervention[];
}

export interface OperatorConsole {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startOperatorConsole(options: OperatorConsoleOptions): Promise<OperatorConsole> {
  const { broker } = options;
  const app = express();
  app.use(express.json());

  const view = (): SessionView => ({
    sessionId: broker.sessionId,
    controlState: broker.controlState,
    ...(options.capabilityId ? { capabilityId: options.capabilityId } : {}),
    ...(options.evidencePath ? { evidencePath: options.evidencePath } : {}),
    interventions: broker.all(),
  });

  app.get('/api/session', (_req, res) => res.json(view()));

  app.get('/api/interventions', (req, res) => {
    const waitingOnly = req.query.waiting !== '0';
    res.json(waitingOnly ? broker.waiting() : broker.all());
  });

  app.post('/api/interventions/:id/attach', async (req, res) => {
    const operator = String((req.body as { operator?: string })?.operator ?? '').trim();
    if (!operator) {
      res.status(400).json({ error: 'An operator name is required. The handover has to be attributable.' });
      return;
    }

    await settle(res, async () => {
      // The token stays here. It is the broker's proof of who holds the
      // session, and the operator acts with their hands on the real browser
      // rather than through this API, so shipping it to a client would create
      // a second way to act without creating anything that needs one.
      await broker.attach(req.params.id, operator);
      return { ok: true, intervention: broker.get(req.params.id) };
    });
  });

  app.post('/api/interventions/:id/resolve', async (req, res) => {
    const body = (req.body ?? {}) as { disposition?: string; operator?: string; note?: string };
    const disposition = body.disposition as Disposition | undefined;

    if (!disposition || !DISPOSITIONS.includes(disposition)) {
      res.status(400).json({
        error: `disposition must be one of: ${DISPOSITIONS.join(', ')}.`,
      });
      return;
    }

    await settle(res, async () => {
      const resolution = await broker.resolve(req.params.id, disposition, {
        ...(body.operator ? { operator: body.operator } : {}),
        ...(body.note ? { note: body.note } : {}),
      });
      return { ok: true, resolution };
    });
  });

  app.use((_req, res) => {
    res
      .status(404)
      .type('text/plain')
      .send(
        'Operator console.\n\n' +
          '  GET  /api/session\n' +
          '  GET  /api/interventions[?waiting=0]\n' +
          '  POST /api/interventions/:id/attach   {"operator":"..."}\n' +
          `  POST /api/interventions/:id/resolve  {"disposition":"${DISPOSITIONS.join('|')}","note":"..."}\n\n` +
          'Drive it with:  npm run operator\n',
      );
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(options.port ?? 0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A console the operator left open must not keep the run's process
        // alive after the run has answered.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * A `ControlError` is the state machine refusing a transition -- attaching to
 * something already being worked, resolving something already resolved. That
 * is a 409 rather than a 500: the request was well formed and the answer is
 * "not from here", which is exactly what the client should show its operator.
 */
async function settle(
  res: express.Response,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    res.json(await work());
  } catch (error) {
    if (error instanceof ControlError) {
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
