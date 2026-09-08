export interface CalculatorSurfaceBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface CalculatorSurface {
  readonly partition: string;
  readonly webContentsId: number;
  attach(): void;
  detach(): void;
  // Detaches and requests renderer close synchronously. Resolution proves actual
  // renderer destruction and session cleanup; unknown destruction rejects.
  close(): Promise<void>;
  setBounds(bounds: CalculatorSurfaceBounds): void;
}
