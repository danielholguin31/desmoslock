export interface CalculatorSurfaceBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface CalculatorSurface {
  readonly partition: string;
  readonly webContentsId: number;
  close(): Promise<void>;
  setBounds(bounds: CalculatorSurfaceBounds): void;
}
