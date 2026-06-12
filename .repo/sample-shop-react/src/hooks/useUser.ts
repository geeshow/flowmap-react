import { useState } from 'react';
import { getUser } from '../api/user';

// Custom hook → HOOK node; component calls it (internal edge), it calls getUser (api edge).
export function useUser(id: string) {
  const [name, setName] = useState('');
  async function load() {
    const u = await getUser(id);
    setName(u.name);
  }
  return { name, load };
}
