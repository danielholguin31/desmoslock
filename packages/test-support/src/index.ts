export type InMemoryValue =
  | boolean
  | number
  | string
  | null
  | readonly InMemoryValue[]
  | { readonly [key: string]: InMemoryValue };

export interface InMemoryRecord {
  readonly id: string;
  readonly value: InMemoryValue;
  readonly version: number;
}

export interface InMemoryBackend {
  list(): readonly InMemoryRecord[];
  read(id: string): InMemoryRecord | null;
  reset(): readonly InMemoryRecord[];
  write(id: string, value: InMemoryValue): InMemoryRecord;
}

function cloneRecord(record: InMemoryRecord): InMemoryRecord {
  return structuredClone(record);
}

function validateRecord(record: InMemoryRecord): InMemoryRecord {
  if (record.id.trim() !== record.id || record.id.length === 0) {
    throw new Error("In-memory record id must be a non-empty trimmed string");
  }
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error(`In-memory record ${record.id} has an invalid version`);
  }
  return cloneRecord(record);
}

export function createInMemoryBackend(
  seed: readonly InMemoryRecord[] = [],
): InMemoryBackend {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "@desmoslock/test-support may initialize only in a test runtime",
    );
  }

  const initial = new Map<string, InMemoryRecord>();
  for (const candidate of seed) {
    const record = validateRecord(candidate);
    if (initial.has(record.id)) {
      throw new Error(`Duplicate in-memory seed id: ${record.id}`);
    }
    initial.set(record.id, record);
  }

  let records = new Map(
    [...initial].map(([id, record]) => [id, cloneRecord(record)]),
  );

  const list = (): readonly InMemoryRecord[] =>
    [...records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneRecord);

  return {
    list,
    read(id) {
      const record = records.get(id);
      return record === undefined ? null : cloneRecord(record);
    },
    reset() {
      records = new Map(
        [...initial].map(([id, record]) => [id, cloneRecord(record)]),
      );
      return list();
    },
    write(id, value) {
      const prior = records.get(id);
      const record = validateRecord({
        id,
        value,
        version: prior === undefined ? 1 : prior.version + 1,
      });
      records.set(id, record);
      return cloneRecord(record);
    },
  };
}
