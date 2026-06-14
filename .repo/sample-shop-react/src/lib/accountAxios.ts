import axios from 'axios';

// Pre-configured shared client exported as a *default* export (niffler accountAxios pattern).
// Exercises default-export axios instance detection.
export default axios.create({ baseURL: import.meta.env.VITE_API_BASE });
