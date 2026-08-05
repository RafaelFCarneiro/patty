import { EventEmitter } from 'node:events';

/**
 * In-process change notification (ADR-027 Phase 3): a plain `EventEmitter` wrapper, never an
 * external broker — the MCP server, HTTP sidecar, and scheduler share one process (ADR-024
 * context), so this is the whole mechanism. `diplomat/db/effects.ts` publishes the entity tags of
 * every batch that actually committed writes; `GET /ui/events` (`diplomat/http/routes/ui.ts`)
 * subscribes and forwards them to connected browsers over SSE. Lives at the `diplomat/` root — not
 * owned by any one surface, just the shared plumbing between the two — mirroring how `RunEffects`
 * crosses the same boundary. `createChangeBus()` itself is composition-root-only, called once in
 * `main.ts`/`test/integration/app-builder.ts`; `diplomat/db` and `diplomat/http` only ever import
 * the `PublishChange`/`ChangeBus` *types* from here and receive the bound `publish`/`subscribe`
 * function as a parameter, never construct one themselves. Known limit: only reaches subscribers
 * on this process — a write from a different stdio server won't push here (mitigated by ADR-024
 * steering multi-client use to the single HTTP-transport server; a periodic poll can backstop if
 * cross-process live-update ever matters).
 */
export type PublishChange = (entities: readonly string[]) => void;

export type ChangeBus = {
  publish: PublishChange;
  /** Registers `listener` for every future publish; returns a function that unregisters it. */
  subscribe: (listener: PublishChange) => () => void;
};

const CHANGE_EVENT = 'change';

export const createChangeBus = (): ChangeBus => {
  const emitter = new EventEmitter();
  // Every connected browser tab is a genuine subscriber, not a leak — an unbounded count is
  // expected, so the default max-listeners warning (tuned for accidental-leak detection) doesn't
  // apply here.
  emitter.setMaxListeners(0);

  return {
    publish: (entities) => {
      emitter.emit(CHANGE_EVENT, entities);
    },
    subscribe: (listener) => {
      emitter.on(CHANGE_EVENT, listener);
      return () => {
        emitter.off(CHANGE_EVENT, listener);
      };
    },
  };
};
