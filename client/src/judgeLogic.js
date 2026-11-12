// Which payment Margaret's phone shows after a scenario button: the one the button just created,
// so a button press always brings its payment to the front. Scenario 5 (a pasted request) creates none.
export const pinAfterScenario = (current, out) => out?.payment?.id || current
