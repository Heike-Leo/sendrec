export interface TimelineLaneItem {
  /** Unique presentation key, including the editor object type namespace. */
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Minimum interval partitioning. Touching endpoints may share a lane.
 * Invalid stored intervals conservatively occupy a dedicated lane; input data
 * is never repaired or mutated here. Keys must be unique.
 */
export function packTimelineLanes(items: readonly TimelineLaneItem[]) {
  const sorted = items.map(item => {
    const valid = Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start;
    return { key: item.key, start: valid ? item.start : -Infinity, end: valid ? item.end : Infinity };
  }).sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const ends: number[] = [];
  const laneByKey = new Map<string, number>();
  for (const item of sorted) {
    const available = ends.findIndex(end => end <= item.start);
    const lane = available < 0 ? ends.length : available;
    ends[lane] = item.end;
    laneByKey.set(item.key, lane);
  }
  return { laneByKey, laneCount: ends.length };
}
