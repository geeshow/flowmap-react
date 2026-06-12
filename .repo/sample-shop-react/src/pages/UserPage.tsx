import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { UserCard } from '../components/UserCard';
import { useUser } from '../hooks/useUser';
import { fetchUser } from '../store/userSlice';

export default function UserPage() {
  const dispatch = useDispatch();
  const current = useSelector((s: any) => s.user.current); // store:read redux:user
  const { name, load } = useUser(current?.id ?? '1'); // internal call → useUser hook

  useEffect(() => {
    dispatch(fetchUser('1')); // store:dispatch redux:user (thunk → async)
    load();
  }, [dispatch]);

  return <UserCard name={name || current?.name || ''} />; // render → UserCard
}
