import { setImmediate as nextTurn } from 'node:timers/promises';
import { act as preactAct } from 'preact/test-utils';

/**
 * Preact flushes renders/effects, but unlike React's async act it does not
 * settle detached promise chains (authorization, Response.json, effect fetches).
 * Yield real event-loop turns inside Preact act without advancing fake playback
 * clocks. Sync callbacks still run and flush synchronously for gesture tests.
 */
export function act(callback: () => unknown): Promise<void> {
  let asynchronous = false;
  const settled = preactAct(() => {
    const result = callback();
    if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
      asynchronous = true;
      return Promise.resolve(result).then(() => nextTurn());
    }
  });
  // Mount effects run at the end of the first act; settle their async work too.
  return asynchronous ? settled.then(() => preactAct(() => nextTurn())) : settled;
}
