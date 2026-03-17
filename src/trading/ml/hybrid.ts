import { predict } from './lstm';

// Mock XGBoost for now, as requested hybrid approach
function getXGBoostProbability(data: number[]): number {
  if (data.length === 0) return 0.5;
  
  // Use relative change instead of absolute price to avoid scale issues (e.g. BTC vs SOL)
  const lastPrice = data[data.length - 1];
  const firstPrice = data[0];
  const relativeChange = (lastPrice - firstPrice) / firstPrice;
  
  // Base probability on momentum + random noise
  const momentumFactor = relativeChange * 10; // Amplify small changes
  const noise = (Math.random() * 0.4 - 0.2); // +/- 20% noise
  
  const prob = 0.5 + momentumFactor + noise;
  return Math.min(0.95, Math.max(0.05, prob));
}

export async function getHybridProbability(data: number[]): Promise<{xgb: number, lstm: number, hybrid: number}> {
  const xgb = getXGBoostProbability(data);
  const lstm = await predict(data);
  const hybrid = (xgb * 0.5) + (lstm * 0.5);
  
  return { xgb, lstm, hybrid };
}
