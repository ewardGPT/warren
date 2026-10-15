/** Read metadata describes the original JSON, never an estimated complete ledger. */
export function omittedReadField(path: string, value: unknown) {
  return {
    path,
    jsonBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    ...(Array.isArray(value) ? { items: value.length } : {}),
  };
}

export function readView(original: unknown, fullCommand: string, omittedFields: ReturnType<typeof omittedReadField>[] = []) {
  return {
    complete: omittedFields.length === 0,
    fullJsonBytes: Buffer.byteLength(JSON.stringify(original), "utf8"),
    omittedFields,
    fullCommand,
  };
}
