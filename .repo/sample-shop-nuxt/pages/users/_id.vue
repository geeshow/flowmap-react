<template lang="pug">
  div(class="user-detail")
    p User detail
</template>

<script>
import { mapGetters } from 'vuex';

export default {
  name: 'UserDetail',
  async asyncData({ store, params }) {
    await store.dispatch('user/fetchUser', params.id); // → user/fetchUser action
  },
  computed: {
    ...mapGetters('user', ['getCurrent']), // store read on user module
  },
};
</script>
