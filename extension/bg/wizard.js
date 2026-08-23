// CS-P4-3 (C5-1) pairing-wizard progression rules (pure, unit-testable).
//
// The wizard walks a FIRST-TIME user through three steps:
//   1. configure (server + API key)
//   2. test the connection
//   3. build the managed category bookmark bar from the cloud
//
// Each step unlocks only when every earlier step has succeeded, and the
// wizard never skips ahead: a later flag without the earlier ones keeps the
// user on the earliest incomplete step. The options page owns the DOM and
// the in-session state; this module only decides "which step is active".

/**
 * @param {{configured?: boolean, tested?: boolean, built?: boolean}} state
 * @returns {1|2|3|4} the active wizard step (4 = all done).
 */
export function wizardStep({ configured = false, tested = false, built = false } = {}) {
  if (!configured) return 1;
  if (!tested) return 2;
  if (!built) return 3;
  return 4;
}

/** True once every step has succeeded (the wizard can be dismissed). */
export function wizardDone(state) {
  return wizardStep(state) === 4;
}
