const svgNamespace = "http://www.w3.org/2000/svg";
const graphWidth = 720;
const graphHeight = 460;
const colors = ["#2364aa", "#d1495b", "#2a9d67", "#8256b3"] as const;

type ParsedExpression =
  | {
      readonly kind: "function";
      readonly source: string;
      readonly value: (x: number) => number;
    }
  | {
      readonly kind: "point";
      readonly source: string;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "vertical"; readonly source: string; readonly x: number };

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Controlled calculator markup is missing ${selector}`);
  }
  return element;
}

const form = requiredElement<HTMLFormElement>("[data-expression-form]");
const input = requiredElement<HTMLInputElement>("[data-expression-input]");
const error = requiredElement<HTMLElement>("[data-expression-error]");
const list = requiredElement<HTMLOListElement>("[data-expression-list]");
const graph = requiredElement<SVGSVGElement>("[data-graph]");
const zoomIn = requiredElement<HTMLButtonElement>("[data-zoom-in]");
const zoomOut = requiredElement<HTMLButtonElement>("[data-zoom-out]");
const zoomLabel = requiredElement<HTMLOutputElement>("[data-zoom-label]");

const expressions: ParsedExpression[] = [];
let zoom = 1;

function parseExpression(source: string): ParsedExpression | null {
  const normalized = source.replaceAll(" ", "").toLowerCase();
  if (normalized === "y=x") {
    return { kind: "function", source, value: (x) => x };
  }
  if (normalized === "y=x^2" || normalized === "y=x²") {
    return { kind: "function", source, value: (x) => x * x };
  }
  if (normalized === "y=sin(x)") {
    return { kind: "function", source, value: Math.sin };
  }
  if (normalized === "y=cos(x)") {
    return { kind: "function", source, value: Math.cos };
  }

  const horizontal = /^y=(-?\d+(?:\.\d+)?)$/.exec(normalized);
  if (horizontal?.[1] !== undefined) {
    const y = Number(horizontal[1]);
    return { kind: "function", source, value: () => y };
  }

  const vertical = /^x=(-?\d+(?:\.\d+)?)$/.exec(normalized);
  if (vertical?.[1] !== undefined) {
    return { kind: "vertical", source, x: Number(vertical[1]) };
  }

  const point = /^\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/.exec(normalized);
  if (point?.[1] !== undefined && point[2] !== undefined) {
    return {
      kind: "point",
      source,
      x: Number(point[1]),
      y: Number(point[2]),
    };
  }

  return null;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNamespace, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, value);
  }
  return element;
}

function drawGrid(scale: number): void {
  for (let x = (graphWidth / 2) % scale; x <= graphWidth; x += scale) {
    graph.append(
      svgElement("line", {
        class: "grid-line",
        x1: String(x),
        x2: String(x),
        y1: "0",
        y2: String(graphHeight),
      }),
    );
  }
  for (let y = (graphHeight / 2) % scale; y <= graphHeight; y += scale) {
    graph.append(
      svgElement("line", {
        class: "grid-line",
        x1: "0",
        x2: String(graphWidth),
        y1: String(y),
        y2: String(y),
      }),
    );
  }
  graph.append(
    svgElement("line", {
      class: "axis-line",
      x1: "0",
      x2: String(graphWidth),
      y1: String(graphHeight / 2),
      y2: String(graphHeight / 2),
    }),
    svgElement("line", {
      class: "axis-line",
      x1: String(graphWidth / 2),
      x2: String(graphWidth / 2),
      y1: "0",
      y2: String(graphHeight),
    }),
  );
}

function renderGraph(): void {
  graph.replaceChildren();
  const scale = 36 * zoom;
  drawGrid(scale);

  expressions.forEach((expression, index) => {
    const color = colors[index % colors.length] ?? colors[0];
    if (expression.kind === "point") {
      graph.append(
        svgElement("circle", {
          class: "expression-point",
          cx: String(graphWidth / 2 + expression.x * scale),
          cy: String(graphHeight / 2 - expression.y * scale),
          fill: color,
          r: "5",
        }),
      );
      return;
    }

    if (expression.kind === "vertical") {
      const x = graphWidth / 2 + expression.x * scale;
      graph.append(
        svgElement("path", {
          class: "expression-path",
          d: `M ${x} 0 L ${x} ${graphHeight}`,
          stroke: color,
        }),
      );
      return;
    }

    const commands: string[] = [];
    for (let pixelX = 0; pixelX <= graphWidth; pixelX += 2) {
      const x = (pixelX - graphWidth / 2) / scale;
      const pixelY = graphHeight / 2 - expression.value(x) * scale;
      if (
        Number.isFinite(pixelY) &&
        pixelY > -graphHeight &&
        pixelY < graphHeight * 2
      ) {
        commands.push(
          `${commands.length === 0 ? "M" : "L"} ${pixelX} ${pixelY}`,
        );
      }
    }
    graph.append(
      svgElement("path", {
        class: "expression-path",
        d: commands.join(" "),
        stroke: color,
      }),
    );
  });

  zoomLabel.value = `${Math.round(zoom * 100)}%`;
}

function renderExpressionList(): void {
  list.replaceChildren();
  expressions.forEach((expression, index) => {
    const item = document.createElement("li");
    item.dataset.expression = expression.source;
    item.style.setProperty(
      "--expression-color",
      colors[index % colors.length] ?? colors[0],
    );
    const label = document.createElement("span");
    label.textContent = expression.source;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${expression.source}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      expressions.splice(index, 1);
      renderExpressionList();
      renderGraph();
    });
    item.append(label, remove);
    list.append(item);
  });
}

function addExpression(source: string): boolean {
  const parsed = parseExpression(source);
  if (parsed === null) {
    error.textContent =
      "Use y=x, y=x^2, y=sin(x), y=cos(x), x=n, y=n, or (x,y).";
    return false;
  }
  error.textContent = "";
  expressions.push(parsed);
  renderExpressionList();
  renderGraph();
  return true;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (addExpression(input.value.trim())) input.value = "";
});
zoomIn.addEventListener("click", () => {
  zoom = Math.min(2.5, zoom * 1.25);
  renderGraph();
});
zoomOut.addEventListener("click", () => {
  zoom = Math.max(0.4, zoom / 1.25);
  renderGraph();
});

addExpression("y=x");
