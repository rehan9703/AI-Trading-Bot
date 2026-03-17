import { Indicator } from './types';

export const RSI: Indicator = {
  name: 'RSI',
  calculate: (data: any[]) => {
    // Basic RSI calculation
    if (data.length < 14) return null;
    const closes = data.map(d => d.close);
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const rs = (gains / 13) / (losses / 13);
    return 100 - (100 / (1 + rs));
  }
};

export const MACD: Indicator = {
  name: 'MACD',
  calculate: (data: any[]) => {
    // Simplified MACD calculation
    if (data.length < 26) return null;
    const closes = data.map(d => d.close);
    const ema12 = closes.slice(-12).reduce((a, b) => a + b, 0) / 12;
    const ema26 = closes.slice(-26).reduce((a, b) => a + b, 0) / 26;
    return ema12 - ema26;
  }
};
