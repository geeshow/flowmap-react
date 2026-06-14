import React from 'react';
import { useSearch } from '../hooks/useSearch';

export default function SearchPage() {
  const { hits, run } = useSearch();
  return (
    <div>
      <button onClick={() => run('shoes')}>Search</button>
      <ul>{hits.map((h) => <li key={h.id}>{h.title}</li>)}</ul>
    </div>
  );
}
