import type { OcrResult } from "./ocr";

export type RecognitionEngine = "text" | "tesseract" | "paddle";
export type RecognitionPolygon = number[][];
export interface RecognitionSource {
  engine: RecognitionEngine;
  attemptIndex?: number;
  boxIndices: number[];
  /** Zero-based lines in the engine's supported reading order, including blanks. */
  lineIndices: number[];
}
export interface NativeConfidence {
  engine: "tesseract" | "paddle";
  /** Engine-native scores; these are deliberately not a common probability. */
  scale: "tesseract-0-100" | "paddle-0-1";
  values: number[];
}
export interface RecognitionGeometry {
  polygons: RecognitionPolygon[];
  bounds: { left: number; top: number; right: number; bottom: number };
  coordinateSpace: "selected-attempt" | "ocr-input";
  angleDegrees?: number;
}
export interface RecognitionLine {
  id: string;
  text: string;
  source: RecognitionSource;
  geometry?: RecognitionGeometry;
  nativeConfidence?: NativeConfidence;
  uncertain: boolean;
}
export interface RecognitionBox {
  index: number;
  text: string;
  polygon?: RecognitionPolygon;
  nativeConfidence?: NativeConfidence;
  uncertain: boolean;
}
export interface RecognitionDiagnostic {
  kind: string;
  severity: "info" | "warning";
  boxIndices: number[];
  lineIndices: number[];
  /** Technical messages only; never interpolate recognised text or money. */
  message: string;
}
/** Geometry and evidence only. No price/role interpretation belongs in adapters. */
export interface RecognitionDocument {
  engine: RecognitionEngine;
  text: string;
  lines: RecognitionLine[];
  rawBoxes: RecognitionBox[];
  diagnostics: RecognitionDiagnostic[];
}

/** Structural contracts avoid importing experimental Paddle code into the app. */
export interface PaddleRecognitionBox { text: string; poly: number[][]; score: number }
export interface PaddleAdaptedLines {
  text: string;
  lines: {
    text: string;
    boxIndices: number[];
    bounds: { left: number; top: number; right: number; bottom: number };
    angleDegrees: number;
    uncertain: boolean;
  }[];
  diagnostics: { kind: string; boxIndices: number[]; message?: string }[];
  rejectedBoxIndices: number[];
}

const finitePolygon = (poly: number[][]): boolean => Array.isArray(poly) && poly.length === 4 &&
  poly.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
const copyPolygon = (poly: number[][]): RecognitionPolygon => poly.map(point => [...point]);
const finiteBounds = (bounds: RecognitionGeometry["bounds"]): boolean =>
  Object.values(bounds).every(Number.isFinite) && bounds.right > bounds.left && bounds.bottom > bounds.top;
const diagnostic = (kind: string, message: string, boxIndices: number[] = [], lineIndices: number[] = [], severity: "info" | "warning" = "warning"): RecognitionDiagnostic =>
  ({ kind, message, boxIndices: [...boxIndices], lineIndices: [...lineIndices], severity });

/**
 * Tesseract's full selected string is authoritative. Its optional word array
 * lacks line identifiers, so words remain separate raw evidence. We never
 * invent line boxes by nearest-neighbour or text matching.
 */
export function documentFromTesseract(ocr: OcrResult): RecognitionDocument {
  const diagnostics: RecognitionDiagnostic[] = [];
  const selected = Number.isSafeInteger(ocr.selectedAttempt) && ocr.selectedAttempt >= 0 ? ocr.attempts[ocr.selectedAttempt] : undefined;
  const bound = selected?.text === ocr.text;
  if (!bound) diagnostics.push(diagnostic("selected-attempt-mismatch", "Selected text cannot be bound to a recorded recognition attempt."));
  const words = bound ? selected?.words ?? [] : [];
  const rawBoxes: RecognitionBox[] = words.map((word, index) => {
    const bounds = { left: word.bbox.x0, top: word.bbox.y0, right: word.bbox.x1, bottom: word.bbox.y1 };
    const validGeometry = finiteBounds(bounds);
    const validConfidence = Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 100;
    if (!validGeometry) diagnostics.push(diagnostic("invalid-word-geometry", "Word geometry is not a finite positive rectangle.", [index]));
    if (!validConfidence) diagnostics.push(diagnostic("invalid-native-confidence", "A Tesseract native confidence score is invalid.", [index]));
    return {
      index, text: word.text,
      ...(validGeometry ? { polygon: [[bounds.left, bounds.top], [bounds.right, bounds.top], [bounds.right, bounds.bottom], [bounds.left, bounds.bottom]] } : {}),
      ...(validConfidence ? { nativeConfidence: { engine: "tesseract" as const, scale: "tesseract-0-100" as const, values: [word.confidence] } } : {}),
      uncertain: !validGeometry || !validConfidence,
    };
  });
  diagnostics.push(diagnostic("line-geometry-unavailable", "This Tesseract result has no explicit word-to-line association; line geometry is unavailable.", [], [], "info"));
  return {
    engine: "tesseract", text: ocr.text, rawBoxes, diagnostics,
    lines: ocr.text.split(/\r\n|\n|\r/).map((text, index) => ({
      id: `tesseract-line-${index}`, text,
      source: { engine: "tesseract", ...(bound ? { attemptIndex: ocr.selectedAttempt } : {}), boxIndices: [], lineIndices: [index] },
      uncertain: !bound,
    })),
  };
}

/** Wrap the geometry adapter's reading order without business interpretation. */
export function documentFromPaddle(boxes: readonly PaddleRecognitionBox[], adapted: PaddleAdaptedLines, attemptIndex?: number): RecognitionDocument {
  const diagnostics: RecognitionDiagnostic[] = adapted.diagnostics.map(entry => diagnostic(
    entry.kind, "The geometry adapter reported an uncertain or omitted detection.", entry.boxIndices,
  ));
  const rejected = new Set(adapted.rejectedBoxIndices);
  const rawBoxes: RecognitionBox[] = boxes.map((box, index) => {
    const validGeometry = finitePolygon(box.poly);
    const validConfidence = Number.isFinite(box.score) && box.score >= 0 && box.score <= 1;
    if (!validGeometry && !rejected.has(index)) diagnostics.push(diagnostic("invalid-box-geometry", "Paddle detection geometry is invalid.", [index]));
    if (!validConfidence) diagnostics.push(diagnostic("invalid-native-confidence", "A Paddle native confidence score is invalid.", [index]));
    return {
      index, text: box.text,
      ...(validGeometry ? { polygon: copyPolygon(box.poly) } : {}),
      ...(validConfidence ? { nativeConfidence: { engine: "paddle" as const, scale: "paddle-0-1" as const, values: [box.score] } } : {}),
      uncertain: rejected.has(index) || !validGeometry || !validConfidence,
    };
  });
  const text = adapted.lines.map(line => line.text).join("\n");
  const textMismatch = text !== adapted.text;
  if (textMismatch) diagnostics.push(diagnostic("adapter-text-mismatch", "Adapter text disagrees with its recorded lines; the recorded line sequence is retained."));
  const validAttempt = attemptIndex !== undefined && Number.isSafeInteger(attemptIndex) && attemptIndex >= 0;
  if (attemptIndex !== undefined && !validAttempt) diagnostics.push(diagnostic("invalid-attempt-index", "Recognition attempt index is invalid."));
  const owners = new Map<number, number[]>();
  adapted.lines.forEach((line, lineIndex) => line.boxIndices.forEach(index => owners.set(index, [...owners.get(index) ?? [], lineIndex])));
  for (const [index, lines] of owners) if (lines.length > 1) diagnostics.push(diagnostic("reused-source-box", "A detection is assigned to more than one adapter line.", [index], lines));
  const lines: RecognitionLine[] = adapted.lines.map((line, index) => {
    const validSources = line.boxIndices.length > 0 && line.boxIndices.every(boxIndex => Number.isSafeInteger(boxIndex) && boxIndex >= 0 && boxIndex < boxes.length && !rejected.has(boxIndex));
    const duplicateSources = new Set(line.boxIndices).size !== line.boxIndices.length || line.boxIndices.some(boxIndex => (owners.get(boxIndex)?.length ?? 0) > 1);
    const sourceBoxes = validSources ? line.boxIndices.map(boxIndex => rawBoxes[boxIndex]!) : [];
    const validGeometry = validSources && finiteBounds(line.bounds) && Number.isFinite(line.angleDegrees) && sourceBoxes.every(box => !!box.polygon);
    const sourceTextMismatch = validSources && sourceBoxes.map(box => box.text).join(" ") !== line.text;
    const confidences = sourceBoxes.flatMap(box => box.nativeConfidence?.values ?? []);
    if (!validSources) diagnostics.push(diagnostic("invalid-line-source", "Adapter line source indices are invalid or refer to omitted detections.", line.boxIndices, [index]));
    if (validSources && !validGeometry) diagnostics.push(diagnostic("invalid-line-geometry", "Adapter line geometry is invalid.", line.boxIndices, [index]));
    if (sourceTextMismatch) diagnostics.push(diagnostic("adapter-line-text-mismatch", "Adapter line text does not preserve the indexed source text sequence.", line.boxIndices, [index]));
    return {
      id: `paddle-line-${index}`, text: line.text,
      source: { engine: "paddle", ...(validAttempt ? { attemptIndex } : {}), boxIndices: [...line.boxIndices], lineIndices: [index] },
      ...(validGeometry ? { geometry: { polygons: sourceBoxes.map(box => copyPolygon(box.polygon!)), bounds: { ...line.bounds }, coordinateSpace: "ocr-input" as const, angleDegrees: line.angleDegrees } } : {}),
      ...(confidences.length === sourceBoxes.length && confidences.length > 0 ? { nativeConfidence: { engine: "paddle" as const, scale: "paddle-0-1" as const, values: confidences } } : {}),
      uncertain: line.uncertain || textMismatch || sourceTextMismatch || !validSources || !validGeometry || duplicateSources || sourceBoxes.some(box => box.uncertain),
    };
  });
  return { engine: "paddle", text, lines, rawBoxes, diagnostics };
}
