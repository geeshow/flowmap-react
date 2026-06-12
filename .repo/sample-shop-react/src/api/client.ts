import axios from 'axios';

// baseURL comes from an env var → exercises env resolution + baseURL compose.
export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE,
  timeout: 5000,
});
