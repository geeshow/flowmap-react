import { useState } from 'react';
import { createUser } from '../api/userApi';

// Plain hook: SignupPage → useSignup → createUser → request → http.
export function useSignup() {
  const [id, setId] = useState('');
  async function signup(email: string, name: string) {
    const u = await createUser({ email, name });
    setId(u.id);
  }
  return { id, signup };
}
