// Vuex module 'user'. Actions call this.$axios; URLs use template + process.env.
export const state = () => ({ current: null });

export const getters = {
  getCurrent: (state) => state.current,
};

export const mutations = {
  setUser: (state, payload) => {
    state.current = payload;
  },
};

export const actions = {
  // GET /internal/users/{}  → matches backend user-service
  async fetchUser({ commit }, id) {
    const res = await this.$axios.get(`/internal/users/${id}`);
    commit('setUser', res.data);
    return res.data;
  },

  // GET /funding/v1/fund-items  → exercises process.env.API_VERSION folding
  async fetchProducts() {
    const path = `/funding/${process.env.API_VERSION}/fund-items`;
    const res = await this.$axios.get(path, { params: { size: 100 } });
    return res.data;
  },
};
