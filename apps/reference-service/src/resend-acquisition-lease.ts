/** A Resend acquisition lease is active only before its exclusive expiry instant. */
export const resendAcquisitionLeaseIsActiveAt = (
  claimedUntil: string | null,
  observedAt: string,
): boolean => {
  if (claimedUntil === null) return false;
  const expiry = Date.parse(claimedUntil);
  const observed = Date.parse(observedAt);
  return Number.isFinite(expiry) && Number.isFinite(observed) && observed < expiry;
};
