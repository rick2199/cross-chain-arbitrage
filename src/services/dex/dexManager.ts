import { PublicClient, WalletClient, Hash } from 'viem';
import { SwapQuote, SwapError, DEXSwapResult, DEXRoute, DEXHealthStatus } from '../../types';
import { Logger } from '../../utils/logger';
import { ArbitrageCalculator } from '../../utils/calculations';
import { TOKEN_DECIMALS } from '../../config/constants';
import { PharaohDEXService } from './pharaoh';
import { ShadowDEXService } from './shadow';

export class DEXManager {
  private readonly pharaoh: PharaohDEXService;
  private readonly shadow: ShadowDEXService;

  constructor(
    avalancheClient: { public: PublicClient; wallet: WalletClient },
    sonicClient: { public: PublicClient; wallet: WalletClient }
  ) {
    this.pharaoh = new PharaohDEXService(avalancheClient);
    this.shadow = new ShadowDEXService(sonicClient);

    Logger.debug('DEXManager initialized with Pharaoh and Shadow services');
  }

  // Get quotes from all available DEXs
  async getAllQuotes(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint,
    networks?: ('avalanche' | 'sonic')[]
  ): Promise<{
    pharaoh?: SwapQuote;
    shadow?: SwapQuote;
  }> {
    const quotes: { pharaoh?: SwapQuote; shadow?: SwapQuote } = {};
    const targetNetworks = networks ?? ['avalanche', 'sonic'];

    try {
      // Get Pharaoh quote (Avalanche)
      if (targetNetworks.includes('avalanche')) {
        try {
          quotes.pharaoh = await this.pharaoh.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
        } catch (error) {
          Logger.warn('Pharaoh quote failed', { error });
        }
      }

      // Get Shadow quote (Sonic)
      if (targetNetworks.includes('sonic')) {
        try {
          quotes.shadow = await this.shadow.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
        } catch (error) {
          Logger.warn('Shadow quote failed', { error });
        }
      }

      const quotesCount = Object.keys(quotes).length;
      Logger.debug('DEX quotes obtained', {
        tokenIn,
        tokenOut,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        quotesCount,
        pharaohAvailable: !!quotes.pharaoh,
        shadowAvailable: !!quotes.shadow,
      });

      return quotes;
    } catch (error) {
      Logger.error('Failed to get DEX quotes', error);
      throw new SwapError('Failed to get DEX quotes', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        error,
      });
    }
  }

  // Get the best quote across all DEXs
  async getBestQuote(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint,
    networks?: ('avalanche' | 'sonic')[]
  ): Promise<{ quote: SwapQuote; dex: 'pharaoh' | 'shadow' }> {
    const quotes = await this.getAllQuotes(tokenIn, tokenOut, amountIn, networks);

    const availableQuotes: { quote: SwapQuote; dex: 'pharaoh' | 'shadow' }[] = [];

    if (quotes.pharaoh) {
      availableQuotes.push({ quote: quotes.pharaoh, dex: 'pharaoh' });
    }
    if (quotes.shadow) {
      availableQuotes.push({ quote: quotes.shadow, dex: 'shadow' });
    }

    if (availableQuotes.length === 0) {
      throw new SwapError('No DEX quotes available', { tokenIn, tokenOut });
    }

    // Sort by best output amount (considering gas costs)
    availableQuotes.sort((a, b) => {
      // Simple comparison by output amount
      // In production, we'd factor in gas costs and other considerations
      return Number(b.quote.amountOut - a.quote.amountOut);
    });

    const bestQuote = availableQuotes[0]!;

    Logger.debug('Best DEX quote selected', {
      dex: bestQuote.dex,
      amountOut: ArbitrageCalculator.formatAmount(
        bestQuote.quote.amountOut,
        TOKEN_DECIMALS[tokenOut],
        tokenOut
      ),
      priceImpact: `${bestQuote.quote.impact.toFixed(4)}%`,
    });

    return bestQuote;
  }

  // Execute swap on specific DEX
  async executeSwap(
    dex: 'pharaoh' | 'shadow',
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint
  ): Promise<DEXSwapResult> {
    try {
      Logger.trade(`Executing swap on ${dex}`, {
        tokenIn,
        tokenOut,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        dex,
      });

      let result: {
        txHash: Hash;
        amountOut: bigint;
        actualGasUsed: bigint;
      };
      let network: 'avalanche' | 'sonic';
      let priceImpact: number;

      if (dex === 'pharaoh') {
        // Get quote for price impact
        const quote = await this.pharaoh.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
        priceImpact = quote.impact;

        result = await this.pharaoh.executeSwapExactIn(tokenIn, tokenOut, amountIn);
        network = 'avalanche';
      } else {
        // Get quote for price impact
        const quote = await this.shadow.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
        priceImpact = quote.impact;

        result = await this.shadow.executeSwapExactIn(tokenIn, tokenOut, amountIn);
        network = 'sonic';
      }

      const swapResult: DEXSwapResult = {
        dex,
        network,
        txHash: result.txHash,
        amountIn,
        amountOut: result.amountOut,
        actualGasUsed: result.actualGasUsed,
        priceImpact,
      };

      Logger.success(`${dex} swap completed`, {
        network,
        txHash: result.txHash,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        amountOut: ArbitrageCalculator.formatAmount(
          result.amountOut,
          TOKEN_DECIMALS[tokenOut],
          tokenOut
        ),
        gasUsed: result.actualGasUsed.toString(),
        priceImpact: `${priceImpact.toFixed(4)}%`,
      });

      return swapResult;
    } catch (error) {
      Logger.error(`Failed to execute ${dex} swap`, error);
      throw new SwapError(`Failed to execute ${dex} swap`, {
        dex,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        error,
      });
    }
  }

  // Execute swap using the best available DEX
  async executeOptimalSwap(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint,
    networks?: ('avalanche' | 'sonic')[]
  ): Promise<DEXSwapResult> {
    try {
      const bestQuote = await this.getBestQuote(tokenIn, tokenOut, amountIn, networks);

      return await this.executeSwap(bestQuote.dex, tokenIn, tokenOut, amountIn);
    } catch (error) {
      Logger.error('Failed to execute optimal swap', error);
      throw new SwapError('Failed to execute optimal swap', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        error,
      });
    }
  }

  // Get available DEX routes
  async getAvailableRoutes(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint
  ): Promise<DEXRoute[]> {
    const routes: DEXRoute[] = [];

    try {
      // Check Pharaoh availability
      const pharaohAvailable = await this.pharaoh.isSwapAvailable(tokenIn, tokenOut, amountIn);
      let pharaohQuote;
      let pharaohHealth = 0;

      if (pharaohAvailable) {
        try {
          pharaohQuote = await this.pharaoh.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
          pharaohHealth = this.calculateHealthScore(pharaohQuote);
        } catch (error) {
          Logger.debug('Pharaoh quote failed during route check', { error });
        }
      }

      routes.push({
        dex: 'pharaoh',
        network: 'avalanche',
        available: pharaohAvailable,
        quote: pharaohQuote!,
        healthScore: pharaohHealth,
      });

      // Check Shadow availability
      const shadowAvailable = await this.shadow.isSwapAvailable(tokenIn, tokenOut, amountIn);
      let shadowQuote;
      let shadowHealth = 0;

      if (shadowAvailable) {
        try {
          shadowQuote = await this.shadow.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);
          shadowHealth = this.calculateHealthScore(shadowQuote);
        } catch (error) {
          Logger.debug('Shadow quote failed during route check', { error });
        }
      }

      routes.push({
        dex: 'shadow',
        network: 'sonic',
        available: shadowAvailable,
        quote: shadowQuote!,
        healthScore: shadowHealth,
      });

      Logger.debug('Available DEX routes', {
        tokenIn,
        tokenOut,
        routesCount: routes.filter(r => r.available).length,
        pharaohHealth,
        shadowHealth,
      });

      return routes;
    } catch (error) {
      Logger.warn('Failed to get available DEX routes', { error });
      return [];
    }
  }

  // Calculate health score for a quote (0-100)
  private calculateHealthScore(quote: SwapQuote): number {
    let score = 100;

    // Penalize high price impact
    if (quote.impact > 2) score -= 30;
    else if (quote.impact > 1) score -= 15;
    else if (quote.impact > 0.5) score -= 5;

    // Penalize high gas costs (simplified)
    const gasUSD = Number(quote.gasEstimate) * 0.000000001 * 2000; // Rough estimate
    if (gasUSD > 10) score -= 20;
    else if (gasUSD > 5) score -= 10;

    return Math.max(0, score);
  }

  // Compare prices across DEXs
  async comparePrices(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint
  ): Promise<{
    pharaoh?: { price: number; amountOut: bigint; impact: number };
    shadow?: { price: number; amountOut: bigint; impact: number };
    priceDifference?: number;
    bestDEX?: 'pharaoh' | 'shadow';
  }> {
    try {
      const quotes = await this.getAllQuotes(tokenIn, tokenOut, amountIn);
      const result: any = {};

      if (quotes.pharaoh) {
        const price = Number(quotes.pharaoh.amountOut) / Number(amountIn);
        result.pharaoh = {
          price,
          amountOut: quotes.pharaoh.amountOut,
          impact: quotes.pharaoh.impact,
        };
      }

      if (quotes.shadow) {
        const price = Number(quotes.shadow.amountOut) / Number(amountIn);
        result.shadow = {
          price,
          amountOut: quotes.shadow.amountOut,
          impact: quotes.shadow.impact,
        };
      }

      // Calculate price difference
      if (result.pharaoh && result.shadow) {
        result.priceDifference =
          (Math.abs(result.pharaoh.price - result.shadow.price) /
            Math.max(result.pharaoh.price, result.shadow.price)) *
          100;
        result.bestDEX = result.pharaoh.amountOut > result.shadow.amountOut ? 'pharaoh' : 'shadow';
      }

      Logger.debug('DEX price comparison', {
        tokenIn,
        tokenOut,
        pharaohPrice: result.pharaoh?.price.toFixed(6),
        shadowPrice: result.shadow?.price.toFixed(6),
        priceDifference: result.priceDifference?.toFixed(4) + '%',
        bestDEX: result.bestDEX,
      });

      return result;
    } catch (error) {
      Logger.error('Failed to compare DEX prices', error);
      return {};
    }
  }

  // Estimate swap costs for arbitrage planning
  async estimateSwapCosts(
    swaps: Array<{
      dex: 'pharaoh' | 'shadow';
      tokenIn: 'USDC' | 'USDT';
      tokenOut: 'USDC' | 'USDT';
      amount: bigint;
    }>
  ): Promise<{
    totalGasCost: bigint;
    totalPriceImpact: number;
    breakdown: Array<{
      dex: 'pharaoh' | 'shadow';
      gasCost: bigint;
      priceImpact: number;
    }>;
  }> {
    const breakdown: Array<{
      dex: 'pharaoh' | 'shadow';
      gasCost: bigint;
      priceImpact: number;
    }> = [];

    let totalGasCost = BigInt(0);
    let totalPriceImpact = 0;

    for (const swap of swaps) {
      try {
        let quote;

        if (swap.dex === 'pharaoh') {
          quote = await this.pharaoh.getSwapQuoteExactIn(swap.tokenIn, swap.tokenOut, swap.amount);
        } else {
          quote = await this.shadow.getSwapQuoteExactIn(swap.tokenIn, swap.tokenOut, swap.amount);
        }

        // Estimate gas cost in ETH (simplified)
        const gasCost = quote.gasEstimate * BigInt(20000000000); // 20 Gwei

        breakdown.push({
          dex: swap.dex,
          gasCost,
          priceImpact: quote.impact,
        });

        totalGasCost += gasCost;
        totalPriceImpact += quote.impact;
      } catch (error) {
        Logger.warn(`Failed to estimate costs for ${swap.dex} swap`, error);
        // Use conservative estimates
        breakdown.push({
          dex: swap.dex,
          gasCost: BigInt(4000000000000000), // 0.004 ETH
          priceImpact: 1.0, // 1%
        });
        totalGasCost += BigInt(4000000000000000);
        totalPriceImpact += 1.0;
      }
    }

    Logger.debug('Swap costs estimated', {
      swapsCount: swaps.length,
      totalGasCost: (Number(totalGasCost) / 1e18).toFixed(6) + ' ETH',
      totalPriceImpact: totalPriceImpact.toFixed(4) + '%',
    });

    return {
      totalGasCost,
      totalPriceImpact,
      breakdown,
    };
  }

  // Health check for all DEX services
  async healthCheck(): Promise<{
    pharaoh: DEXHealthStatus;
    shadow: DEXHealthStatus;
  }> {
    const results = {
      pharaoh: {
        available: false,
        latency: undefined as number | undefined,
        poolHealth: undefined,
      },
      shadow: {
        available: false,
        latency: undefined as number | undefined,
        poolHealth: undefined,
      },
    };

    // Check Pharaoh health
    try {
      const startTime = Date.now();
      const pharaohHealth = await this.checkPharaohHealth();
      results.pharaoh = {
        available: pharaohHealth.available,
        latency: Date.now() - startTime,
        poolHealth: pharaohHealth.poolInfo,
      };
    } catch (error) {
      Logger.debug('Pharaoh health check failed', { error });
    }

    // Check Shadow health
    try {
      const startTime = Date.now();
      const shadowHealth = await this.checkShadowHealth();
      results.shadow = {
        available: shadowHealth.available,
        latency: Date.now() - startTime,
        poolHealth: shadowHealth.poolInfo,
      };
    } catch (error) {
      Logger.debug('Shadow health check failed', { error });
    }
    Logger.debug('DEX services health check', results);
    return results;
  }

  private async checkPharaohHealth(): Promise<{
    available: boolean;
    poolInfo?: any;
  }> {
    try {
      // Test with small amount
      await this.pharaoh.getSwapQuoteExactIn('USDC', 'USDT', BigInt(1000000)); // 1 USDC
      const poolInfo = await this.pharaoh.getPoolInfo();
      return { available: true, poolInfo };
    } catch {
      return { available: false };
    }
  }

  private async checkShadowHealth(): Promise<{
    available: boolean;
    poolInfo?: any;
  }> {
    try {
      // Test with small amount
      await this.shadow.getSwapQuoteExactIn('USDC', 'USDT', BigInt(1000000)); // 1 USDC
      const poolHealth = await this.shadow.checkPoolHealth();
      return { available: true, poolInfo: poolHealth };
    } catch {
      return { available: false };
    }
  }

  // Get real-time prices from both DEXs
  async getRealTimePrices(): Promise<{
    pharaoh?: { price: number; network: string };
    shadow?: { price: number; network: string };
    spread?: number;
    timestamp: number;
  }> {
    const timestamp = Date.now();
    const result: any = { timestamp };

    try {
      // Get Pharaoh price
      try {
        const pharaohPrice = await this.pharaoh.getCurrentPrice();
        result.pharaoh = {
          price: pharaohPrice.price,
          network: 'avalanche',
        };
      } catch (error) {
        Logger.debug('Failed to get Pharaoh price', { error });
      }

      // Get Shadow price
      try {
        const shadowPrice = await this.shadow.getCurrentPrice();
        result.shadow = {
          price: shadowPrice.price,
          network: 'sonic',
        };
      } catch (error) {
        Logger.debug('Failed to get Shadow price', { error });
      }

      // Calculate spread
      if (result.pharaoh && result.shadow) {
        result.spread =
          (Math.abs(result.pharaoh.price - result.shadow.price) /
            Math.max(result.pharaoh.price, result.shadow.price)) *
          100;
      }

      return result;
    } catch (error) {
      Logger.error('Failed to get real-time prices', error);
      return { timestamp };
    }
  }

  // Monitor multiple swaps in parallel
  async monitorSwaps(swapPromises: Promise<DEXSwapResult>[]): Promise<{
    completed: DEXSwapResult[];
    failed: any[];
    successRate: number;
  }> {
    const results = await Promise.allSettled(swapPromises);

    const completed: DEXSwapResult[] = [];
    const failed: any[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        completed.push(result.value);
      } else {
        failed.push({
          index,
          error: result.reason,
        });
      }
    });

    const successRate = (completed.length / results.length) * 100;

    Logger.info('Swap monitoring completed', {
      total: results.length,
      completed: completed.length,
      failed: failed.length,
      successRate: `${successRate.toFixed(2)}%`,
    });

    return {
      completed,
      failed,
      successRate,
    };
  }

  // Emergency cancel swap (if possible)
  async emergencyCancel(swapResult: DEXSwapResult): Promise<boolean> {
    try {
      Logger.warn('Attempting emergency swap cancellation', {
        dex: swapResult.dex,
        network: swapResult.network,
        txHash: swapResult.txHash,
      });

      // Note: Most DEX swaps cannot be cancelled once confirmed
      // This would be for pending transactions only
      Logger.warn('DEX swap cancellation not supported after confirmation');
      return false;
    } catch (error) {
      Logger.error('Emergency swap cancellation failed', error);
      return false;
    }
  }

  // Get DEX-specific services
  getPharaohService(): PharaohDEXService {
    return this.pharaoh;
  }

  getShadowService(): ShadowDEXService {
    return this.shadow;
  }
}
