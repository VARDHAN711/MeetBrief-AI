import '@testing-library/jest-dom/vitest';
function makeStorage() {
  const values = new Map<string, string>();
  return {
  get length() { return values.size; },
  key: (index: number) => [...values.keys()][index] ?? null,
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
  };
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: makeStorage() });
