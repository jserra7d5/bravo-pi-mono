export function composeAbortSignal(timeoutMs: number, userSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeoutSignal;
  if (userSignal.aborted) return userSignal;
  return AbortSignal.any([userSignal, timeoutSignal]);
}
