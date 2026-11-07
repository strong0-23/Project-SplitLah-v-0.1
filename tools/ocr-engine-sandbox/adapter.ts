/**
 * Geometry-only adapter for PaddleOCR's recognised quadrilaterals.
 *
 * It does not repair recognised characters, infer table columns, or consult a
 * receipt/reference answer. The original boxes remain the recognition record;
 * the returned text is only an input to the unchanged receipt parser.
 */
export interface PaddleTextBox {
  poly: number[][];
  text: string;
  score: number;
}

export interface AdapterDiagnostic {
  kind: "invalid-box" | "empty-text" | "unusual-orientation" | "ambiguous-row";
  boxIndices: number[];
  message: string;
}

export interface AdaptedLine {
  text: string;
  boxIndices: number[];
  /** Coordinates in the original, unrotated OCR input image. */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Shared projection angle, not an image rotation or recognised character edit. */
  angleDegrees: number;
  uncertain: boolean;
}

export interface AdaptedPaddleText {
  text: string;
  lines: AdaptedLine[];
  diagnostics: AdapterDiagnostic[];
  rejectedBoxIndices: number[];
  angleDegrees: number;
}

type Point = [number, number];
interface Geometry {
  index: number;
  input: PaddleTextBox;
  points: Point[];
  cx: number;
  cy: number;
  angle: number;
  wide: boolean;
  x: number;
  y: number;
  left: number;
  right: number;
  height: number;
  isolated: boolean;
}

const radians = Math.PI / 180;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function geometry(input: PaddleTextBox, index: number): Geometry | null {
  if (!Array.isArray(input.poly) || input.poly.length !== 4) return null;
  if (!input.poly.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
  const points = input.poly.map((point) => [...point] as Point);
  const cx = points.reduce((sum, [x]) => sum + x, 0) / 4;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / 4;
  const ordered = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  const crosses = ordered.map((a, i) => {
    const b = ordered[(i + 1) % 4]!;
    const c = ordered[(i + 2) % 4]!;
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  if (crosses.some((cross) => Math.abs(cross) < 0.001) || !crosses.every((cross) => Math.sign(cross) === Math.sign(crosses[0]!))) return null;
  const xSorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [p0, p1, p2, p3] = xSorted as [Point, Point, Point, Point];
  const left: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const right: Point = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const width = Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x));
  const height = Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y));
  if (width <= 0 || height <= 0) return null;
  return {
    index, input, points, cx, cy,
    angle: Math.atan2(right[1] - left[1], right[0] - left[0]),
    wide: width >= height * 1.5,
    x: 0, y: 0, left: 0, right: 0, height: 0, isolated: false,
  };
}

/**
 * Receipt rows are usually horizontal or mildly skewed after SDK orientation.
 * Wide boxes supply the skew angle; short quantities do not set that angle.
 * At a shared angle, row centres must agree within 40% of the shorter box's
 * height. This deliberately prefers separate, diagnosed lines to borrowing a
 * neighbouring product's amount. Strongly overlapping boxes cannot share a row.
 */
export function adaptPaddleTextBoxes(boxes: readonly PaddleTextBox[]): AdaptedPaddleText {
  const diagnostics: AdapterDiagnostic[] = [];
  const rejectedBoxIndices: number[] = [];
  const valid: Geometry[] = [];
  boxes.forEach((input, index) => {
    if (typeof input?.text !== "string" || !input.text.trim()) {
      diagnostics.push({ kind: "empty-text", boxIndices: [index], message: "Box has no recognised text; omitted from parser input." });
      rejectedBoxIndices.push(index);
      return;
    }
    const box = geometry(input, index);
    if (!box) {
      diagnostics.push({ kind: "invalid-box", boxIndices: [index], message: "Expected a finite, non-degenerate convex quadrilateral; recognised text retained only in the raw OCR record." });
      rejectedBoxIndices.push(index);
      return;
    }
    valid.push(box);
  });
  const angles = valid.filter((box) => box.wide && Math.abs(box.angle) <= 30 * radians).map((box) => box.angle);
  const angle = angles.length ? median(angles) : 0;
  const angleDegrees = angle / radians;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const box of valid) {
    const along = box.points.map(([x, y]) => x * cos + y * sin);
    const across = box.points.map(([x, y]) => -x * sin + y * cos);
    box.x = box.cx * cos + box.cy * sin;
    box.y = -box.cx * sin + box.cy * cos;
    box.left = Math.min(...along);
    box.right = Math.max(...along);
    box.height = Math.max(...across) - Math.min(...across);
    if (box.wide && Math.abs(box.angle - angle) > 8 * radians) {
      box.isolated = true;
      diagnostics.push({ kind: "unusual-orientation", boxIndices: [box.index], message: "Box direction disagrees with the shared receipt direction; kept on its own line." });
    }
  }
  const compatible = (a: Geometry, b: Geometry) => {
    if (a.isolated || b.isolated) return false;
    if (Math.abs(a.y - b.y) > 0.4 * Math.min(a.height, b.height)) return false;
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    return overlap <= 0.2 * Math.min(a.right - a.left, b.right - b.left);
  };
  // Overlapping detections on the same row may be duplicates or competing text
  // hypotheses. Preserve both raw strings, but do not silently concatenate them.
  const overlapping = new Set<number>();
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i]!;
      const b = valid[j]!;
      if (a.isolated || b.isolated || Math.abs(a.y - b.y) > 0.4 * Math.min(a.height, b.height)) continue;
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (overlap > 0.2 * Math.min(a.right - a.left, b.right - b.left)) {
        overlapping.add(i);
        overlapping.add(j);
        diagnostics.push({ kind: "ambiguous-row", boxIndices: [a.index, b.index], message: "Overlapping detections may contain competing text; kept as separate uncertain lines." });
      }
    }
  }
  for (const i of overlapping) valid[i]!.isolated = true;
  const neighbours = valid.map((a, i) => valid.map((b, j) => i !== j && compatible(a, b)));
  const visited = new Set<number>();
  const groups: { boxes: Geometry[]; uncertain: boolean }[] = [];
  for (let start = 0; start < valid.length; start++) {
    if (visited.has(start)) continue;
    const members: number[] = [];
    const pending = [start];
    visited.add(start);
    while (pending.length) {
      const next = pending.pop()!;
      members.push(next);
      for (let j = 0; j < valid.length; j++) {
        if (neighbours[next]![j] && !visited.has(j)) {
          visited.add(j);
          pending.push(j);
        }
      }
    }
    // A bridge between two incompatible rows is evidence of ambiguity, not a
    // reason to pick the nearest row or merge the entire connected component.
    const clique = members.every((a) => members.every((b) => a === b || neighbours[a]![b]));
    if (!clique) {
      diagnostics.push({ kind: "ambiguous-row", boxIndices: members.map((i) => valid[i]!.index).sort((a, b) => a - b), message: "Boxes have conflicting row memberships; each is kept on a separate line without assigning amounts to products." });
      for (const i of members) groups.push({ boxes: [valid[i]!], uncertain: true });
    } else {
      groups.push({ boxes: members.map((i) => valid[i]!), uncertain: members.some((i) => valid[i]!.isolated) });
    }
  }
  const meanY = (group: { boxes: Geometry[] }) => group.boxes.reduce((sum, box) => sum + box.y, 0) / group.boxes.length;
  const stableTextKey = (group: { boxes: Geometry[] }) => group.boxes.map((box) => box.input.text).sort().join("\n");
  groups.sort((a, b) => meanY(a) - meanY(b) || Math.min(...a.boxes.map((box) => box.left)) - Math.min(...b.boxes.map((box) => box.left)) || (stableTextKey(a) < stableTextKey(b) ? -1 : stableTextKey(a) > stableTextKey(b) ? 1 : 0) || a.boxes[0]!.index - b.boxes[0]!.index);
  const lines: AdaptedLine[] = groups.map(({ boxes: row, uncertain }) => {
    row.sort((a, b) => a.left - b.left || a.y - b.y || a.index - b.index);
    const points = row.flatMap((box) => box.points);
    return {
      text: row.map((box) => box.input.text).join(" "),
      boxIndices: row.map((box) => box.index),
      bounds: {
        left: Math.min(...points.map(([x]) => x)), top: Math.min(...points.map(([, y]) => y)),
        right: Math.max(...points.map(([x]) => x)), bottom: Math.max(...points.map(([, y]) => y)),
      },
      angleDegrees, uncertain,
    };
  });
  return { text: lines.map((line) => line.text).join("\n"), lines, diagnostics, rejectedBoxIndices, angleDegrees };
}
