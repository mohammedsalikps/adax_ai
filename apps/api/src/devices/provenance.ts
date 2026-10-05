/**
 * The validation status of a value that a device SIMULATOR generated. It marks the one thing every reader of observations must know: such a value
 * is not a measurement of anyone. The database sets it apart (migration 0029: a reading is `simulated` exactly when its device record is a
 * simulator); the readers that feed a model, the record rules or the patient leave it out; the screens that show it say SIMULATED.
 */
export const SIMULATED = 'simulated'
