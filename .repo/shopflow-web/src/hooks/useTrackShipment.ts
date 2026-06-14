import { useState } from 'react';
import { trackShipment } from '../api/shippingApi';

// Plain hook: TrackShipmentPage → useTrackShipment → trackShipment → request → http.
export function useTrackShipment(orderId: string) {
  const [status, setStatus] = useState<string | null>(null);
  async function load() {
    const res = await trackShipment(orderId);
    setStatus(res.status);
  }
  return { status, load };
}
