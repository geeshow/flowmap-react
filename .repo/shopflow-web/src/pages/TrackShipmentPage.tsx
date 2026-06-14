import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTrackShipment } from '../hooks/useTrackShipment';

export default function TrackShipmentPage() {
  const { id = '' } = useParams();
  const { status, load } = useTrackShipment(id);
  useEffect(() => {
    load();
  }, [id]);
  return <div>{status}</div>;
}
