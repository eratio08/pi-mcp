/**
 * Races a promise against a timeout and clears the timer after either branch settles.
 *
 * @template T Promise fulfillment type preserved by the timeout wrapper.
 */
export async function withTimeout<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
