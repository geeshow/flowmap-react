import React, { useEffect } from 'react';
import { useProfile } from '../hooks/useProfile';

export default function ProfilePage() {
  const { name, load } = useProfile('1');
  useEffect(() => {
    load();
  }, []);
  return <div>{name}</div>;
}
