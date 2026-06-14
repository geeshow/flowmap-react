import { useState } from 'react';
import { getProfile } from '../api/userApi';

// Plain hook: ProfilePage → useProfile → getProfile → request → http.
export function useProfile(id: string) {
  const [name, setName] = useState('');
  async function load() {
    const p = await getProfile(id);
    setName(p.name);
  }
  return { name, load };
}
