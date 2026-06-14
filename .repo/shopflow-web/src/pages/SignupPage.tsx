import React from 'react';
import { useSignup } from '../hooks/useSignup';

export default function SignupPage() {
  const { signup } = useSignup();
  return <button onClick={() => signup('a@b.io', 'Ann')}>Sign up</button>;
}
