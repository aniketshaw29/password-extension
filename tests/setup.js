import { vi } from 'vitest';

export function createChromeMock() {
  const storageData = {};
  return {
    storage: {
      session: {
        set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
        get: vi.fn(async (key) => {
          if (typeof key === 'string') return { [key]: storageData[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, storageData[k]]));
          return { ...storageData };
        }),
        _data: storageData,
      },
    },
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
      lastError: null,
    },
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}
