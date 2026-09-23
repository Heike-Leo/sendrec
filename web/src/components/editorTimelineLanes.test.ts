import { describe, expect, it } from "vitest";
import { packTimelineLanes, type TimelineLaneItem } from "./editorTimelineLanes";
const item = (key: string, start: number, end: number): TimelineLaneItem => ({ key, start, end });

describe("visual timeline lane packing", () => {
  it.each([
    ["empty", [], 0],
    ["single", [item("a", 0, 5)], 1],
    ["sequential", [item("a", 0, 5), item("b", 30, 35)], 1],
    ["touching", [item("a", 0, 5), item("b", 5, 10)], 1],
    ["two overlapping", [item("a", 0, 5), item("b", 4, 10)], 2],
    ["three overlapping", [item("a", 0, 5), item("b", 1, 6), item("c", 2, 7)], 3],
  ] as const)("packs %s intervals", (_name, items, count) => {
    expect(packTimelineLanes(items).laneCount).toBe(count);
  });
  it("shares lanes across every visual type and namespaces identical IDs", () => {
    const items = ["overlay:cover", "annotation:text", "overlay:blur", "annotation:arrow", "annotation:circle", "annotation:line", "annotation:symbol", "annotation:cover"]
      .map((key, index) => item(key, index * 5, index * 5 + 5));
    const result = packTimelineLanes(items);
    expect(result.laneCount).toBe(1);
    expect([...result.laneByKey.values()]).toEqual(items.map(() => 0));
    expect(result.laneByKey.size).toBe(8);
  });
  it("breaks ties by end then key, independently of input order or repeated calls", () => {
    const items = [item("c", 0, 10), item("b", 0, 5), item("a", 0, 5), item("d", 5, 8)];
    for (const input of [items, [...items].reverse(), [items[2], items[0], items[3], items[1]], items]) {
      expect([...packTimelineLanes(input).laneByKey]).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 0]]);
    }
  });
  it("does not mutate frozen editor objects or storage order", () => {
    const items = Object.freeze([Object.freeze({ ...item("b", 20, 25), text: "unchanged" }), Object.freeze(item("a", 0, 5))]);
    const before = JSON.stringify(items);
    packTimelineLanes(items);
    expect(JSON.stringify(items)).toBe(before);
  });
  it("reuses the lowest lane and shrinks after an overlap is moved or removed", () => {
    const items = [item("a", 0, 5), item("b", 2, 7), item("c", 8, 10), item("d", 10, 12)];
    expect([...packTimelineLanes(items).laneByKey.values()]).toEqual([0, 1, 0, 0]);
    expect(packTimelineLanes(items).laneCount).toBe(2);
    expect(packTimelineLanes([items[0], item("b", 5, 7), ...items.slice(2)]).laneCount).toBe(1);
    expect(packTimelineLanes(items.filter(i => i.key !== "b")).laneCount).toBe(1);
  });
  it("isolates malformed stored intervals without repairing input", () => {
    const items = [item("bad", NaN, 3), item("reversed", 5, 2), item("ok", 0, 5), item("later", 5, 10)];
    const result = packTimelineLanes(items);
    expect(result.laneCount).toBe(3);
    expect(result.laneByKey.get("ok")).toBe(result.laneByKey.get("later"));
    expect(items[0].start).toBeNaN();
    expect(items[1].end).toBe(2);
  });
});
