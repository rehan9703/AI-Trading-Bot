export interface Signal {
  symbol: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  indicator: string;
}

export interface Indicator {
  name: string;
  calculate(data: any[]): number | null;
}

export interface Strategy {
  name: string;
  evaluate(data: any[]): Signal;
}
