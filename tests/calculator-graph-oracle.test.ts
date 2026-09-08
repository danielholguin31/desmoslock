import { describe, expect, it } from "vitest";

import {
  assertGraphGeometry,
  assertPlotPaint,
  assertZoomGeometryChanged,
  type ExpectedPlot,
  type GraphSnapshot,
} from "./e2e/electron/support/calculator-graph-oracle.js";

const expected: readonly ExpectedPlot[] = [
  {
    expression: "y=x^2",
    kind: "path",
    points: [
      [288, 86],
      [360, 230],
      [432, 86],
    ],
  },
];
const graph: GraphSnapshot = {
  expressions: ["y=x^2"],
  plots: [{ kind: "path", d: "M 288 86 L 360 230 L 432 86", painted: true }],
  zoom: "100%",
  visible: true,
  width: 720,
  height: 460,
  viewport: [1080, 600],
  viewBox: [0, 0, 720, 460],
  matrix: [1, 0, 0, 1, 300, 0],
};

describe("internal graphing evidence oracle", () => {
  it("requires known positions and opaque plot pixels independently", () => {
    expect(() => assertGraphGeometry(graph, expected)).not.toThrow();
    // Opaque red in both RGBA and BGRA order, as returned by native captures.
    expect(() =>
      assertPlotPaint([209, 73, 91, 255, 91, 73, 209, 255], [209, 73, 91]),
    ).not.toThrow();
  });

  it.each([
    "",
    "M 360 230 L 360 230",
    "M NaN 86 L 432 86",
    "M 288 87 L 360 231 L 432 87",
    "M 0 0 L 720 460",
  ])("rejects empty, degenerate, nonfinite or wrong geometry: %s", (d) => {
    expect(() =>
      assertGraphGeometry(
        { ...graph, plots: [{ kind: "path", d, painted: true }] },
        expected,
      ),
    ).toThrow();
  });

  it("rejects a point node at the wrong location or with zero radius", () => {
    const pointExpected: readonly ExpectedPlot[] = [
      { expression: "(2,3)", kind: "point", points: [[432, 122]] },
    ];
    const point: GraphSnapshot = {
      ...graph,
      expressions: ["(2,3)"],
      plots: [{ kind: "point", cx: 432, cy: 122, radius: 5, painted: true }],
    };
    expect(() => assertGraphGeometry(point, pointExpected)).not.toThrow();
    for (const plot of [
      { kind: "point" as const, cx: 432, cy: 123, radius: 5, painted: true },
      { kind: "point" as const, cx: 432, cy: 122, radius: 0, painted: true },
    ])
      expect(() =>
        assertGraphGeometry({ ...point, plots: [plot] }, pointExpected),
      ).toThrow();
  });

  it("rejects hidden, zero-size, offscreen and collapsed graph observations", () => {
    for (const changed of [
      { ...graph, visible: false },
      { ...graph, height: 0 },
      { ...graph, matrix: [1, 0, 0, 1, 1080, 0] },
      { ...graph, matrix: [0, 0, 0, 0, 300, 200] },
      {
        ...graph,
        plots: [
          {
            kind: "path" as const,
            d: "M 288 86 L 360 230 L 432 86",
            painted: false,
          },
        ],
      },
    ])
      expect(() => assertGraphGeometry(changed, expected)).toThrow();
  });

  it("rejects changed zoom text when the geometry is unchanged", () => {
    expect(() =>
      assertZoomGeometryChanged(graph, { ...graph, zoom: "125%" }, "y=x^2"),
    ).toThrow("zoom geometry did not change");
    const zoomed: GraphSnapshot = {
      ...graph,
      zoom: "125%",
      plots: [
        { kind: "path", d: "M 270 50 L 360 230 L 450 50", painted: true },
      ],
    };
    expect(() =>
      assertZoomGeometryChanged(graph, zoomed, "y=x^2"),
    ).not.toThrow();
    expect(() =>
      assertGraphGeometry(zoomed, [
        {
          expression: "y=x^2",
          kind: "path",
          points: [
            [270, 50],
            [360, 230],
            [450, 50],
          ],
        },
      ]),
    ).not.toThrow();
  });

  it("rejects blank, transparent, grid-only and isolated single-pixel captures even with valid geometry", () => {
    assertGraphGeometry(graph, expected);
    for (const pixels of [
      new Array<number>(7 * 7 * 4).fill(255),
      new Array<number>(7 * 7 * 4).fill(0),
      [227, 233, 242, 255, 227, 233, 242, 255],
      [209, 73, 91, 255, 255, 255, 255, 255],
    ])
      expect(() => assertPlotPaint(pixels, [209, 73, 91])).toThrow(
        "plot pixels",
      );
  });

  it("cannot accept geometry after a missing or extra expression", () => {
    expect(() =>
      assertGraphGeometry({ ...graph, expressions: [] }, expected),
    ).toThrow();
    expect(() =>
      assertGraphGeometry({ ...graph, plots: [] }, expected),
    ).toThrow();
  });
});
