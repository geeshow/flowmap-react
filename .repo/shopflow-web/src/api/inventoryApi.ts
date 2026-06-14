import axios from 'axios';
import { INVENTORY_BASE_URL, INVENTORY_PATHS } from './routes';

// Dedicated instance whose baseURL embeds the gateway segment; calls pass RELATIVE
// path consts so the resolver must compose baseURL + path → /inventory/v1/inventory[...].
export const inventoryHttp = axios.create({ baseURL: INVENTORY_BASE_URL, timeout: 5000 });

// GET /inventory/v1/inventory
export async function listStock() {
  const res = await inventoryHttp.get<Array<{ sku: string }>>(INVENTORY_PATHS.LIST);
  return res.data;
}

// GET /inventory/v1/inventory/{}
export async function getStock(sku: string) {
  const res = await inventoryHttp.get<{ sku: string; onHand: number }>(INVENTORY_PATHS.BY_SKU(sku));
  return res.data;
}
