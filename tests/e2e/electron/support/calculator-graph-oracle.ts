import assert from "node:assert/strict";

export type GraphPoint = readonly [number, number];
export type GraphPlot =
  | { readonly kind: "path"; readonly d: string; readonly painted: boolean }
  | {
      readonly kind: "point";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly painted: boolean;
    };
export interface GraphSnapshot {
  readonly document: { readonly url: string; readonly timeOrigin: number };
  readonly expressions: readonly string[];
  readonly plots: readonly GraphPlot[];
  readonly zoom: string;
  readonly visible: boolean;
  readonly width: number;
  readonly height: number;
  readonly viewport: GraphPoint;
  readonly viewBox: readonly number[];
  readonly matrix: readonly number[];
}
export interface ExpectedPlot {
  readonly expression: string;
  readonly kind: "path" | "point";
  readonly points: readonly GraphPoint[];
}

// Only the repository-owned M/L polyline profile is accepted. This is a test
// oracle, not another expression parser or a production SVG capability.
function polyline(d: string): GraphPoint[] {
  const tokens = d.trim().split(/\s+/);
  assert(tokens.length >= 6 && tokens.length % 3 === 0, "empty/invalid path");
  const points: GraphPoint[] = [];
  for (let index = 0; index < tokens.length; index += 3) {
    assert.equal(tokens[index], index === 0 ? "M" : "L", "path command");
    const x = Number(tokens[index + 1]);
    const y = Number(tokens[index + 2]);
    assert(Number.isFinite(x) && Number.isFinite(y), "nonfinite geometry");
    points.push([x, y]);
  }
  assert(
    points.some(
      (point) => point[0] !== points[0]?.[0] || point[1] !== points[0]?.[1],
    ),
    "degenerate geometry",
  );
  return points;
}

function segmentDistance(
  point: GraphPoint,
  a: GraphPoint,
  b: GraphPoint,
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared,
          ),
        );
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

export function graphScreenPoint(
  snapshot: GraphSnapshot,
  point: GraphPoint,
): GraphPoint {
  const [a, b, c, d, e, f] = snapshot.matrix;
  assert(
    [a, b, c, d, e, f].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
    "invalid screen transform",
  );
  assert(
    a !== undefined &&
      b !== undefined &&
      c !== undefined &&
      d !== undefined &&
      e !== undefined &&
      f !== undefined,
  );
  assert(Math.abs(a * d - b * c) > 0, "collapsed screen transform");
  const result: GraphPoint = [
    a * point[0] + c * point[1] + e,
    b * point[0] + d * point[1] + f,
  ];
  assert(
    result[0] >= 0 &&
      result[0] < snapshot.viewport[0] &&
      result[1] >= 0 &&
      result[1] < snapshot.viewport[1],
    "expected plot is offscreen",
  );
  return result;
}

export function assertGraphGeometry(
  snapshot: GraphSnapshot,
  expected: readonly ExpectedPlot[],
): void {
  assert.equal(snapshot.visible, true, "graph is hidden");
  assert(
    Number.isFinite(snapshot.width) &&
      snapshot.width > 0 &&
      Number.isFinite(snapshot.height) &&
      snapshot.height > 0,
    "graph has no visible rectangle",
  );
  assert.deepEqual(snapshot.viewBox, [0, 0, 720, 460]);
  assert.deepEqual(
    snapshot.expressions,
    expected.map((plot) => plot.expression),
  );
  assert.equal(snapshot.plots.length, expected.length);
  expected.forEach((requirement, index) => {
    const actual = snapshot.plots[index];
    assert(
      actual !== undefined && actual.kind === requirement.kind,
      "missing plot",
    );
    assert.equal(actual.painted, true, "plot paint is disabled");
    assert(requirement.points.length > 0);
    const points = actual.kind === "path" ? polyline(actual.d) : null;
    for (const point of requirement.points) {
      assert(
        point.every(Number.isFinite) &&
          point[0] >= 0 &&
          point[0] <= 720 &&
          point[1] >= 0 &&
          point[1] <= 460,
      );
      graphScreenPoint(snapshot, point);
      if (actual.kind === "point") {
        assert(Number.isFinite(actual.radius) && actual.radius > 0);
        assert(
          Math.hypot(actual.cx - point[0], actual.cy - point[1]) <= 0.15,
          "point position",
        );
      } else {
        assert(points !== null);
        assert(
          points.some((a, index) => {
            const b = points[index + 1];
            return b !== undefined && segmentDistance(point, a, b) <= 0.15;
          }),
          `missing known geometry for ${requirement.expression}`,
        );
      }
    }
  });
}

export type GraphRecoveryEvent =
  | {
      readonly kind: "failed-load";
      readonly url: string;
      readonly isMainFrame: boolean;
      readonly errorCode: number;
    }
  | { readonly kind: "navigated" | "finished-load"; readonly url: string };
export interface GraphRecoveryEvidence {
  readonly calculatorUrl: string;
  readonly attemptedUrl: string;
  readonly beforePlots: readonly ExpectedPlot[];
  readonly initialPlots: readonly ExpectedPlot[];
  readonly events: readonly GraphRecoveryEvent[];
}

// A reset is valid only across an observed failed foreign main-frame navigation
// and a completed replacement document. Missing forms in the same document, or
// a reset inferred solely from the graph's contents, must still fail.
export function assertGraphRestoredAfterNavigation(
  before: GraphSnapshot,
  after: GraphSnapshot,
  evidence: GraphRecoveryEvidence,
): void {
  assertGraphGeometry(before, evidence.beforePlots);
  assert.equal(before.zoom, "125%", "pre-attack zoom");
  assert.equal(before.document.url, evidence.calculatorUrl);
  assert.equal(after.document.url, evidence.calculatorUrl);
  assert.notEqual(evidence.attemptedUrl, evidence.calculatorUrl);
  assert(
    Number.isFinite(before.document.timeOrigin) &&
      before.document.timeOrigin > 0 &&
      Number.isFinite(after.document.timeOrigin) &&
      after.document.timeOrigin > before.document.timeOrigin,
    "no fresh calculator document",
  );
  const failed = evidence.events.findIndex(
    (event) =>
      event.kind === "failed-load" &&
      event.isMainFrame &&
      event.url === evidence.attemptedUrl &&
      Number.isInteger(event.errorCode) &&
      event.errorCode < 0,
  );
  assert(failed >= 0, "missing failed foreign main-frame navigation");
  const navigated = evidence.events.findIndex(
    (event, index) =>
      index > failed &&
      event.kind === "navigated" &&
      event.url === evidence.calculatorUrl,
  );
  assert(navigated > failed, "missing owned document restoration");
  assert(
    evidence.events.some(
      (event, index) =>
        index > navigated &&
        event.kind === "finished-load" &&
        event.url === evidence.calculatorUrl,
    ),
    "restored document did not finish loading",
  );
  assertGraphGeometry(after, evidence.initialPlots);
  assert.equal(after.zoom, "100%", "restored initial zoom");
}

export function plotGeometry(snapshot: GraphSnapshot): readonly unknown[] {
  return snapshot.plots.map((plot) =>
    plot.kind === "path"
      ? { kind: plot.kind, d: plot.d }
      : { kind: plot.kind, cx: plot.cx, cy: plot.cy, radius: plot.radius },
  );
}

export function assertZoomGeometryChanged(
  before: GraphSnapshot,
  after: GraphSnapshot,
  expression: string,
): void {
  const index = before.expressions.indexOf(expression);
  assert(index >= 0 && after.expressions[index] === expression);
  assert.notEqual(before.zoom, after.zoom, "zoom label did not change");
  assert.notDeepEqual(
    plotGeometry(before)[index],
    plotGeometry(after)[index],
    "zoom geometry did not change",
  );
}

// NativeImage's 32-bit raw channel order is platform-dependent. Compare all
// opaque color components without assuming RGBA versus BGRA/ARGB ordering.
// A white/transparent/grid-only capture cannot satisfy a chromatic plot patch.
export function assertPlotPaint(
  patch: readonly number[],
  rgb: readonly [number, number, number],
): void {
  assert(patch.length > 0 && patch.length % 4 === 0);
  assert(
    patch.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ),
  );
  const expected = [...rgb, 255].sort((a, b) => a - b);
  let matching = 0;
  for (let offset = 0; offset < patch.length; offset += 4) {
    const components = patch.slice(offset, offset + 4).sort((a, b) => a - b);
    if (
      components.every(
        (value, index) => Math.abs(value - (expected[index] ?? -256)) <= 12,
      )
    )
      matching += 1;
  }
  assert(matching >= 2, "expected visible plot pixels are absent");
}
