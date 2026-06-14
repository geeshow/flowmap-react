import React, { useEffect } from 'react';
import { useCatalog } from '../hooks/useCatalog';

export default function CatalogPage() {
  const { items, load } = useCatalog();
  useEffect(() => {
    load();
  }, []);
  return <ul>{items.map((i) => <li key={i.id}>{i.id}</li>)}</ul>;
}
