import React, { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';

export function UserCard({ name }: { name: string }) {
  const auth = useContext(AuthContext); // store:read on AuthContext
  return (
    <div className="user-card">
      <span>{name}</span>
      {auth.token ? <em>authed</em> : null}
    </div>
  );
}
