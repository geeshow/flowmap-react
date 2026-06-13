<template lang="pug">
  div(class="orders")
    button(@click="submit") Order
</template>

<script>
import { mapActions } from 'vuex';
import axios from 'axios';

export default {
  name: 'OrdersPage',
  methods: {
    ...mapActions({ createOrder: 'orders/createOrder' }), // → orders/createOrder action
    async submit() {
      await this.createOrder({ sku: 'A1' });
      await this.geocode();
    },
    async geocode() {
      // third-party absolute URL → EXTERNAL, unmatched in join
      await axios.get('https://maps.googleapis.com/maps/api/geocode/json');
    },
  },
};
</script>
