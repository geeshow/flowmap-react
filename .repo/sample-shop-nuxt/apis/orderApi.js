// API wrapper module (apis/*) — called from a Vuex action. Uses the Nuxt-injected
// $axios via window.$nuxt; the resolver traces action → requestCreateOrder → $axios.post.
export const requestCreateOrder = async (body) => {
  const path = '/orders';
  return await window.$nuxt.$axios.post(path, body);
};
