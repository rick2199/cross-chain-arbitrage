import { ArbitrageOpportunity } from '../types';

export class ArbitrageCalculator {
  // Convert USD amounts to token amounts with proper decimals
  static usdToTokenAmount(usdAmount: number, decimals: number): bigint {
    return BigInt(Math.floor(usdAmount * 10 ** decimals));
  }

  // Calculate price difference between two pools
  static calculatePriceDifference(price1: bigint, price2: bigint, decimals: number = 6): number {
    const p1 = Number(price1) / 10 ** decimals;
    const p2 = Number(price2) / 10 ** decimals;
    return Math.abs(p1 - p2) / Math.min(p1, p2);
  }

  // Calculate potential profit from arbitrage
  static calculateArbitrageProfit(
    buyPrice: bigint,
    sellPrice: bigint,
    amount: bigint,
    decimals: number = 6
  ): bigint {
    if (sellPrice <= buyPrice) return BigInt(0);

    const priceDiff = sellPrice - buyPrice;
    return (amount * priceDiff) / BigInt(10 ** decimals);
  }

  // Calculate profit after costs
  static calculateNetProfit(
    grossProfit: bigint,
    gasCosts: bigint,
    bridgeCosts: bigint,
    slippageCosts: bigint = BigInt(0)
  ): bigint {
    const totalCosts = gasCosts + bridgeCosts + slippageCosts;
    return grossProfit > totalCosts ? grossProfit - totalCosts : BigInt(0);
  }

  // Calculate profit percentage
  static calculateProfitPercentage(netProfit: bigint, investment: bigint): number {
    if (investment === BigInt(0)) return 0;

    const profitNum = Number(netProfit);
    const investmentNum = Number(investment);

    return (profitNum / investmentNum) * 100;
  }

  // Price impact calculation for AMM
  static calculatePriceImpact(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): number {
    if (reserveIn === BigInt(0) || reserveOut === BigInt(0)) return 0;

    // Simplified price impact calculation
    const priceImpact = Number(amountIn) / Number(reserveIn);
    return Math.min(priceImpact * 100, 100); // Cap at 100%
  }

  // Validate arbitrage opportunity
  static validateOpportunity(opportunity: Partial<ArbitrageOpportunity>): boolean {
    if (!opportunity.netProfit || opportunity.netProfit <= BigInt(0)) {
      return false;
    }

    if (!opportunity.profitPercentage || opportunity.profitPercentage < 0.1) {
      return false;
    }

    if (!opportunity.amount || opportunity.amount <= BigInt(0)) {
      return false;
    }

    return true;
  }

  // Format amounts for display
  static formatAmount(
    amount: bigint,
    decimals: number,
    symbol: string = '',
    precision: number = 6
  ): string {
    const formatted = (Number(amount) / 10 ** decimals).toFixed(precision);
    return symbol ? `${formatted} ${symbol}` : formatted;
  }

  // Calculate time-weighted average price (TWAP)
  static calculateTWAP(
    priceHistory: { price: bigint; timestamp: number }[],
    timeWindowMs: number = 300000 // 5 minutes default
  ): bigint {
    const now = Date.now();
    const relevantPrices = priceHistory.filter(p => now - p.timestamp <= timeWindowMs);

    if (relevantPrices.length === 0) return BigInt(0);

    const totalWeight = relevantPrices.reduce((sum, p) => {
      const weight = timeWindowMs - (now - p.timestamp);
      return sum + weight;
    }, 0);

    if (totalWeight === 0) return BigInt(0);

    const weightedSum = relevantPrices.reduce((sum, p) => {
      const weight = timeWindowMs - (now - p.timestamp);
      return sum + Number(p.price) * weight;
    }, 0);

    return BigInt(Math.floor(weightedSum / totalWeight));
  }
}
