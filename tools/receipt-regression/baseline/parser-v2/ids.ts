let counter = 0;
/** Unique, sortable-enough local ID. Called only from handlers, never at module scope. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}
