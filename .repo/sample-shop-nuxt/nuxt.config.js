const config = require('config');
const env = config.get('env');

module.exports = {
  modules: [
    ['@nuxtjs/axios', { baseURL: `${env.API_HOST}` }],
  ],
  router: {
    middleware: 'global',
  },
};
