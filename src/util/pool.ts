/** Runs worker over items with at most `concurrency` in flight; keeps input order. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}
