/**
 * A name as the doctor reads it (jury polish): the synthetic deployment's names carry a "(synthetic)" mark in the data ("Dr. Meera Iyer
 * (synthetic)", "ADAXAI Clinic (synthetic)"); the screen shows the plain name and says once, subtly, that the data is synthetic.
 */
export const plainName = (name: string | null | undefined): string => (name ?? '').replace(/\s*\(synthetic\)\s*$/i, '').trim()

/** Whether a name carries the synthetic mark. */
export const isSyntheticName = (name: string | null | undefined): boolean => /\(synthetic\)\s*$/i.test(name ?? '')
/** Text with the synthetic dataset's "(synthetic)" marks taken out of the names in it (the sidebar says once that the data is synthetic). */
export const withoutSyntheticMarks = (text: string): string => text.replace(/\s*\(synthetic\)/gi, '')
