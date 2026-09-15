/**
 * Human-in-the-loop: who holds the session, and how it changes hands.
 *
 * Imports nothing from `src/llm/` and nothing from `src/replay/`. Replay
 * depends on this module for a type, not the other way round, so control
 * transfer stays a property of the session rather than of any one runner.
 */

export * from './types.js';
export * from './broker.js';
export * from './controlled.js';
