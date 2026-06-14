// Gateway base URL sourced from the Vite env var → exercises env resolution.
export const GW_BASE = import.meta.env.VITE_GW_BASE;

// Direct API host (bypasses the gateway) — used by services that call the backend
// path directly, exercising the join's Stage-1 direct match (no prefix to strip).
export const API_BASE = import.meta.env.VITE_API_BASE;
