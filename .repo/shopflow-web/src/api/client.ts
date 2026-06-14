import axios from 'axios';
import { GW_BASE } from './env';

// baseURL comes from the gateway env var → exercises env resolution + baseURL compose.
export const http = axios.create({
  baseURL: GW_BASE,
  timeout: 5000,
});
