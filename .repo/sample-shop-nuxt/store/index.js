// Root Vuex module (store/index.js → namespace '').
export const state = () => ({ ready: false });

export const mutations = {
  setReady: (state, payload) => {
    state.ready = payload;
  },
};

export const actions = {
  async actionInit({ dispatch }) {
    // action → action dispatch (root → user module)
    await dispatch('user/fetchProducts');
  },
};
