import { createContext } from 'react';

export interface AuthValue {
  token: string | null;
  login: (t: string) => void;
}

export const AuthContext = createContext<AuthValue>({ token: null, login: () => {} });
