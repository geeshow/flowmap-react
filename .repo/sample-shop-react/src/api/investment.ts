import { http } from './client';

// Static path, fully resolved → GET /internal/investment/current-summary (funding-service).
export async function getInvestmentSummary() {
  const res = await http.get('/internal/investment/current-summary');
  return res.data;
}
