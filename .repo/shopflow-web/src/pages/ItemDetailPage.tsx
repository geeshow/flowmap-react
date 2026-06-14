import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useItemDetail } from '../hooks/useCatalog';

export default function ItemDetailPage() {
  const { id = '1' } = useParams();
  const { item, load } = useItemDetail(id);
  useEffect(() => {
    load();
  }, [id]);
  return <div>{item?.name}</div>;
}
