/** The clock at request time. Server components read it here (Date.now() inline trips react-hooks/purity). */
export const requestTimeMs = (): number => Date.now();
