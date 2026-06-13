import { requestCreateOrder } from '@/apis/orderApi';

// Vuex module 'orders'. Action delegates to an apis/* wrapper (cross-function trace).
export const state = () => ({ list: [] });

export const actions = {
  // POST /orders  → ambiguous in the combined backend graph
  async createOrder({ commit }, body) {
    const res = await requestCreateOrder(body);
    return res.data;
  },
};
