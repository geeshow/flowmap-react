import { useState } from 'react';
import { search } from '../api/searchApi';

// SearchPage → useSearch → search → directHttp.get (direct, no gateway).
export function useSearch() {
  const [hits, setHits] = useState<Array<{ id: number; title: string }>>([]);
  async function run(q: string) {
    setHits(await search(q));
  }
  return { hits, run };
}
