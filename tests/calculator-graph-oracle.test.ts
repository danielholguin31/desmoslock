import { describe, expect, it } from "vitest";

import {
  assertGraphGeometry,
  assertGraphRestoredAfterNavigation,
  assertPlotPaint,
  assertZoomGeometryChanged,
  type ExpectedPlot,
  type GraphSnapshot,
  type GraphRecoveryEvent,
  type GraphRecoveryEvidence,
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
  document: { url: "desmoslock-calculator://host/index.html", timeOrigin: 100 },
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

// Synthetic phase records exercise the oracle, not Electron or its event source.
const calculatorUrl = "desmoslock-calculator://host/index.html";
const attemptedUrl = "http://127.0.0.1:43210/navigation";
const retainedForms: readonly ExpectedPlot[] = [
  {
    expression: "y=x",
    kind: "path",
    points: [
      [216, 374],
      [360, 230],
      [504, 86],
    ],
  },
  {
    expression: "y=sin(x)",
    kind: "path",
    points: [
      [270, 270.9184],
      [450, 189.0816],
    ],
  },
  {
    expression: "y=cos(x)",
    kind: "path",
    points: [
      [360, 185],
      [450, 248.7266],
    ],
  },
  {
    expression: "y=3",
    kind: "path",
    points: [
      [150, 95],
      [600, 95],
    ],
  },
  {
    expression: "x=-3",
    kind: "path",
    points: [
      [225, 30],
      [225, 430],
    ],
  },
  { expression: "(2,3)", kind: "point", points: [[450, 95]] },
];
const initialForms = retainedForms.slice(0, 1);
const beforeNavigation: GraphSnapshot = {
  ...graph,
  document: { url: calculatorUrl, timeOrigin: 100 },
  expressions: retainedForms.map((form) => form.expression),
  plots: retainedForms.map((form) =>
    form.kind === "point"
      ? { kind: "point", cx: 450, cy: 95, radius: 5, painted: true }
      : {
          kind: "path",
          d: form.points
            .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
            .join(" "),
          painted: true,
        },
  ),
  zoom: "125%",
};
const restored: GraphSnapshot = {
  ...beforeNavigation,
  document: { url: calculatorUrl, timeOrigin: 200 },
  expressions: ["y=x"],
  plots: beforeNavigation.plots.slice(0, 1),
  zoom: "100%",
};
const failedNavigation: GraphRecoveryEvent = {
  kind: "failed-load",
  url: attemptedUrl,
  isMainFrame: true,
  errorCode: -20,
};
const navigated: GraphRecoveryEvent = { kind: "navigated", url: calculatorUrl };
const finished: GraphRecoveryEvent = {
  kind: "finished-load",
  url: calculatorUrl,
};
const recovery: GraphRecoveryEvidence = {
  calculatorUrl,
  attemptedUrl,
  beforePlots: retainedForms,
  initialPlots: initialForms,
  events: [failedNavigation, navigated, finished],
};

describe("hostile-navigation graph recovery oracle", () => {
  it("accepts exact six-form preflight and the fresh initial graph only after observed owned document restoration", () => {
    // The former whole-probe retention assertion rejects this legitimate reset.
    expect(() => assertGraphGeometry(restored, retainedForms)).toThrow();
    expect(() =>
      assertGraphRestoredAfterNavigation(beforeNavigation, restored, recovery),
    ).not.toThrow();
  });

  it.each<[string, readonly GraphRecoveryEvent[]]>([
    ["no observed failure", []],
    [
      "only a subframe failed",
      [
        { ...failedNavigation, isMainFrame: false },
        ...recovery.events.slice(1),
      ],
    ],
    [
      "a different URL failed",
      [
        { ...failedNavigation, url: attemptedUrl + "-other" },
        ...recovery.events.slice(1),
      ],
    ],
    [
      "no failed error code",
      [{ ...failedNavigation, errorCode: 0 }, ...recovery.events.slice(1)],
    ],
    ["no document commit", [failedNavigation, finished]],
    ["no completed load", recovery.events.slice(0, 2)],
    [
      "foreign document committed",
      [failedNavigation, { ...navigated, url: attemptedUrl }, finished],
    ],
    ["load precedes failure", [navigated, finished, failedNavigation]],
  ])("rejects unexplained state loss: %s", (_label, events) => {
    expect(() =>
      assertGraphRestoredAfterNavigation(beforeNavigation, restored, {
        ...recovery,
        events,
      }),
    ).toThrow();
  });

  it("rejects a reset in the same document or a different final origin", () => {
    for (const document of [
      beforeNavigation.document,
      { url: attemptedUrl, timeOrigin: 200 },
      { url: calculatorUrl, timeOrigin: NaN },
    ]) {
      expect(() =>
        assertGraphRestoredAfterNavigation(
          beforeNavigation,
          { ...restored, document },
          recovery,
        ),
      ).toThrow();
    }
  });

  it("rejects wrong recovered geometry, paint, expressions or zoom despite a valid recovery event sequence", () => {
    for (const changed of [
      {
        ...restored,
        plots: [
          { kind: "path" as const, d: "M 216 375 L 504 87", painted: true },
        ],
      },
      {
        ...restored,
        plots: [
          { kind: "path" as const, d: "M 216 374 L 504 86", painted: false },
        ],
      },
      { ...restored, expressions: ["y=x", "(2,3)"] },
      { ...restored, zoom: "125%" },
    ])
      expect(() =>
        assertGraphRestoredAfterNavigation(beforeNavigation, changed, recovery),
      ).toThrow();
  });

  it("rejects missing pre-attack forms or the wrong pre-attack zoom", () => {
    expect(() =>
      assertGraphRestoredAfterNavigation(
        { ...beforeNavigation, expressions: ["y=x"] },
        restored,
        recovery,
      ),
    ).toThrow();
    expect(() =>
      assertGraphRestoredAfterNavigation(
        { ...beforeNavigation, zoom: "100%" },
        restored,
        recovery,
      ),
    ).toThrow();
  });
});
