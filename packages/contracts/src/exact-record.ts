export function parseExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;

    const actualKeys = Reflect.ownKeys(value);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key),
      )
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }

      snapshot[key] = descriptor.value as unknown;
    }

    return snapshot;
  } catch {
    return null;
  }
}

export function parseExactArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) {
      return null;
    }

    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      !ownKeys.includes("length") ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
      )
    ) {
      return null;
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      snapshot.push(descriptor.value as unknown);
    }

    return snapshot;
  } catch {
    return null;
  }
}
