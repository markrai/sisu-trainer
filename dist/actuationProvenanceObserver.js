import { recordActuationOutcome, recordActuationRequest, } from "./executionProvenance.js";
import { getSession } from "./sessionStore.js";
/**
 * Bike Bridge observer that appends each posted resistance command, with its
 * explicit origin, to the active session's start-time provenance record on the
 * canonical active clock. It only records; it never influences commands.
 */
export function createActuationProvenanceObserver(resolveDay, storage) {
    const store = (storage !== null && storage !== void 0 ? storage : localStorage);
    return {
        requested(request) {
            const day = resolveDay();
            const session = getSession(day, store);
            if (!session.sessionId)
                return undefined;
            const commandId = recordActuationRequest(day, session, request, store);
            return commandId === null ? undefined : { day, sessionId: session.sessionId, commandId };
        },
        resolved(token, outcome) {
            const value = token;
            if (!value)
                return;
            recordActuationOutcome(value.day, value.sessionId, value.commandId, outcome, store);
        },
    };
}
