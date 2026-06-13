<template lang="pug">
  main(class="home")
    h1 Home
</template>

<script>
import { mapActions } from 'vuex';

export default {
  name: 'PageIndex',
  async asyncData({ store }) {
    await store.dispatch('actionInit'); // root action
  },
  methods: {
    ...mapActions(['actionInit']),
  },
};
</script>
