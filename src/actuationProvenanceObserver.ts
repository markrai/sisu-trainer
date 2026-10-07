import type {
  BikeBridgeActuationObserver,
  BikeBridgeActuationOutcome,
  BikeBridgeActuationRequest,
} from "./platform/bikeBridgeRuntime.js";
import {
  recordActuationOutcome,
  recordActuationRequest,
  type ExecutionProvenanceStorage,
} from "./executionProvenance.js";
import { getSession, type SessionStorage } from "./sessionStore.js";

interface ActuationToken {
  day: string;
  sessionId: string;
  commandId: number;
}

/**
 * Bike Bridge observer that appends each posted resistance command, with its
 * explicit origin, to the active session's start-time provenance record on the
 * canonical active clock. It only records; it never influences commands.
 */
export function createActuationProvenanceObserver(
  resolveDay: () => string,
  storage?: SessionStorage & ExecutionProvenanceStorage
): BikeBridgeActuationObserver {
  const store = (storage ?? localStorage) as SessionStorage & ExecutionProvenanceStorage;
  return {
    requested(request: BikeBridgeActuationRequest): ActuationToken | undefined {
      const day = resolveDay();
      const session = getSession(day, store);
      if (!session.sessionId) return undefined;
      const commandId = recordActuationRequest(day, session, request, store);
      return commandId === null ? undefined : { day, sessionId: session.sessionId, commandId };
    },
    resolved(token: unknown, outcome: BikeBridgeActuationOutcome): void {
      const value = token as ActuationToken | undefined;
      if (!value) return;
      recordActuationOutcome(value.day, value.sessionId, value.commandId, outcome, store);
    },
  };
}
