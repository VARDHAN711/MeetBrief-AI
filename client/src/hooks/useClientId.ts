import { useState } from 'react';
export function useClientId(): string {
  const [id] = useState(() => {
    const existing = localStorage.getItem('meetbrief-client-id');
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem('meetbrief-client-id', created);
    return created;
  });
  return id;
}
