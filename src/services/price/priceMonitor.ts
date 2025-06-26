import { PublicClient } from 'viem';
import { PriceData, PriceError, PoolInfo } from '../../types';
import { NETWORKS } from '../../config/networks';
import { COMMON_ABIS, TIME_CONSTANTS } from '../../config/constants';
import { Logger } from '../../utils/logger';
import { ArbitrageCalculator } from '../../utils/calculations';

export class PriceMonitor {
  private readonly priceHistory: Map<string, PriceData[]> = new Map();
  private readonly lastPriceUpdate: Map<string, number> = new Map();
  private isMonitoring = false;

  constructor(
    private readonly avalancheClient: PublicClient,
    private readonly sonicClient: PublicClient
  ) {
    Logger.debug('PriceMonitor initialized for V3 pools');
  }

  // Start monitoring prices
  async startMonitoring(intervalMs: number = 10000): Promise<void> {
    if (this.isMonitoring) {
      Logger.warn('Price monitoring is already active');
      return;
    }

    this.isMonitoring = true;
    Logger.info('Starting V3 price monitoring', { intervalMs });

    // Initial price fetch
    await this.fetchAllPrices();

    // Set up interval monitoring
    const monitoringInterval = setInterval(async () => {
      if (!this.isMonitoring) {
        clearInterval(monitoringInterval);
        return;
      }

      try {
        await this.fetchAllPrices();
      } catch (error) {
        Logger.error('Error in price monitoring cycle', error);
      }
    }, intervalMs);
  }

  // Stop monitoring
  stopMonitoring(): void {
    this.isMonitoring = false;
    Logger.info('Price monitoring stopped');
  }

  // Fetch prices from all V3 pools
  private async fetchAllPrices(): Promise<void> {
    try {
      const [avalanchePrice, sonicPrice] = await Promise.all([
        this.fetchPharaohV3Price(),
        this.fetchShadowV3Price(),
      ]);

      // Store prices in history
      this.storePriceData('pharaoh', avalanchePrice);
      this.storePriceData('shadow', sonicPrice);

      // Log price updates
      Logger.price('V3 Price update', {
        pharaoh: ArbitrageCalculator.formatAmount(avalanchePrice.price0, 6, 'USDC/USDT'),
        shadow: ArbitrageCalculator.formatAmount(sonicPrice.price0, 6, 'USDC/USDT'),
        priceDifference:
          ArbitrageCalculator.calculatePriceDifference(
            avalanchePrice.price0,
            sonicPrice.price0,
            6
          ).toFixed(4) + '%',
      });
    } catch (error) {
      throw new PriceError('Failed to fetch V3 prices from all pools', {
        error,
      });
    }
  }

  // Fetch price from Pharaoh pool (Avalanche)
  private async fetchPharaohV3Price(): Promise<PriceData> {
    try {
      const poolAddress = NETWORKS.avalanche?.contracts.dexPool as `0x${string}`;

      Logger.debug('Fetching Pharaoh V3 price', { poolAddress });

      // Get V3 data using slot0
      const [slot0, liquidity, token0, token1] = await Promise.all([
        this.avalancheClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'slot0',
        }) as Promise<[bigint, number, number, number, number, number, boolean]>,
        this.avalancheClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'liquidity',
        }) as Promise<bigint>,
        this.avalancheClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token0',
        }) as Promise<string>,
        this.avalancheClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token1',
        }) as Promise<string>,
      ]);

      const [sqrtPriceX96, tick] = slot0;
      const currentBlock = await this.avalancheClient.getBlockNumber();

      Logger.debug('Pharaoh V3 pool data', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        liquidity: liquidity.toString(),
        token0,
        token1,
      });

      // Convert sqrtPriceX96 to actual price for USDC/USDT (both 6 decimals)
      const price0 = this.sqrtPriceX96ToPrice(sqrtPriceX96, 6, 6);
      const price1 = price0 > BigInt(0) ? BigInt(10 ** 12) / price0 : BigInt(0);

      return {
        price0,
        price1,
        timestamp: Date.now(),
        blockNumber: currentBlock,
        pool: poolAddress,
        network: 'avalanche',
        liquidity,
        sqrtPriceX96,
      };
    } catch (error) {
      Logger.error('Failed to fetch Pharaoh V3 price', error);
      throw new PriceError('Failed to fetch Pharaoh V3 price', {
        network: 'avalanche',
        pool: NETWORKS.avalanche?.contracts.dexPool,
        error,
      });
    }
  }

  // Fetch price from Shadow V3 pool (Sonic)
  private async fetchShadowV3Price(): Promise<PriceData> {
    try {
      const poolAddress = NETWORKS.sonic?.contracts.dexPool as `0x${string}`;

      Logger.debug('Fetching Shadow V3 price', { poolAddress });

      // Get V3 data using slot0
      const [slot0, liquidity, token0, token1] = await Promise.all([
        this.sonicClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'slot0',
        }) as Promise<[bigint, number, number, number, number, number, boolean]>,
        this.sonicClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'liquidity',
        }) as Promise<bigint>,
        this.sonicClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token0',
        }) as Promise<string>,
        this.sonicClient.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token1',
        }) as Promise<string>,
      ]);

      const [sqrtPriceX96, tick] = slot0;
      const currentBlock = await this.sonicClient.getBlockNumber();

      Logger.debug('Shadow V3 pool data', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        tick,
        liquidity: liquidity.toString(),
        token0,
        token1,
      });

      // Convert sqrtPriceX96 to actual price for USDC/USDT (both 6 decimals)
      const price0 = this.sqrtPriceX96ToPrice(sqrtPriceX96, 6, 6);
      const price1 = price0 > BigInt(0) ? BigInt(10 ** 12) / price0 : BigInt(0);

      return {
        price0,
        price1,
        timestamp: Date.now(),
        blockNumber: currentBlock,
        pool: poolAddress,
        network: 'sonic',
        liquidity,
        sqrtPriceX96,
      };
    } catch (error) {
      Logger.error('Failed to fetch Shadow V3 price', error);
      throw new PriceError('Failed to fetch Shadow V3 price', {
        network: 'sonic',
        pool: NETWORKS.sonic?.contracts.dexPool,
        error,
      });
    }
  }

  // Convert V3 sqrtPriceX96 to readable price
  private sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): bigint {
    try {
      if (sqrtPriceX96 === BigInt(0)) {
        Logger.warn('sqrtPriceX96 is 0, using fallback price');
        return BigInt(1000000); // 1.0 fallback for USDC/USDT
      }

      Logger.debug('Converting V3 price', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        decimals0,
        decimals1,
      });

      // V3 Price formula: price = (sqrtPriceX96 / 2^96)^2
      const Q96 = BigInt(2) ** BigInt(96);

      // To avoid overflow, we need to be careful with the calculation
      // For stable pairs, we use a different approach

      // Convert to float for calculation, then back to bigint
      const sqrtPriceFloat = Number(sqrtPriceX96) / Number(Q96);
      const priceFloat = sqrtPriceFloat * sqrtPriceFloat;

      // Adjust for decimals difference (both USDC and USDT have 6 decimals, so no adjustment)
      const decimalAdjustment = Math.pow(10, decimals1 - decimals0);
      const adjustedPriceFloat = priceFloat * decimalAdjustment;

      // Convert to 6-decimal representation (for USDC/USDT)
      const finalPrice = adjustedPriceFloat * Math.pow(10, 6);

      // Convert back to bigint
      const priceBigInt = BigInt(Math.floor(finalPrice));

      Logger.debug('V3 price calculation steps', {
        sqrtPriceFloat: sqrtPriceFloat.toFixed(10),
        priceFloat: priceFloat.toFixed(10),
        adjustedPriceFloat: adjustedPriceFloat.toFixed(10),
        finalPrice: finalPrice.toFixed(0),
        priceBigInt: priceBigInt.toString(),
      });

      // Sanity check for stable pairs - price should be between 0.5 and 2.0
      if (priceBigInt < BigInt(500000) || priceBigInt > BigInt(2000000)) {
        Logger.warn('V3 price outside expected range for stable pair, investigating...', {
          sqrtPriceX96: sqrtPriceX96.toString(),
          calculatedPrice: priceBigInt.toString(),
          priceInDecimal: (Number(priceBigInt) / 1000000).toFixed(6),
          expectedRange: '0.5 - 2.0',
        });

        // Let's try the alternative calculation method
        const alternativePrice = this.alternativeV3PriceCalculation(sqrtPriceX96);
        if (alternativePrice > BigInt(0)) {
          return alternativePrice;
        }
      }

      // If price is reasonable, return it
      if (priceBigInt > BigInt(0)) {
        return priceBigInt;
      }

      // Fallback to stable price
      Logger.warn('Calculated price was 0, using stable fallback');
      return BigInt(1000000); // 1.0 fallback
    } catch (error) {
      Logger.warn('Error calculating V3 price, using fallback', error);
      return BigInt(1000000); // 1.0 fallback
    }
  }

  // Alternative V3 price calculation method using integer math
  private alternativeV3PriceCalculation(sqrtPriceX96: bigint): bigint {
    try {
      // Use pure integer math to avoid precision loss
      const Q96 = BigInt(2) ** BigInt(96);

      // For the specific some specific case of USDC/USDT, we can use a different approach
      // We calculate it step by step

      // First, we check if this is token0/token1 or token1/token0
      // The actual price might be the inverse

      // Calculate price = (sqrtPriceX96)^2 / (2^96)^2
      // But we do it in steps to avoid overflow

      // Step 1: sqrtPriceX96^2
      const sqrtPriceSquared = sqrtPriceX96 * sqrtPriceX96;

      // Step 2: 2^192
      const Q192 = Q96 * Q96;

      // Step 3: price ratio (this will be very small for USDC/USDT)
      const priceRatio = sqrtPriceSquared / Q192;

      // For stable pairs, if the ratio is very small, we might need the inverse
      if (priceRatio === BigInt(0)) {
        // Try the inverse calculation
        // price = 2^192 / (sqrtPriceX96)^2, but scaled appropriately
        const inversePriceRatio = Q192 / sqrtPriceSquared;
        const inversePrice = inversePriceRatio * BigInt(1000000); // Scale to 6 decimals

        Logger.debug('Using inverse V3 price calculation', {
          sqrtPriceX96: sqrtPriceX96.toString(),
          inversePriceRatio: inversePriceRatio.toString(),
          inversePrice: inversePrice.toString(),
          priceInDecimal: (Number(inversePrice) / 1000000).toFixed(6),
        });

        return inversePrice;
      }

      // Scale to 6 decimals
      const scaledPrice = priceRatio * BigInt(1000000);

      Logger.debug('Alternative V3 price calculation', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        priceRatio: priceRatio.toString(),
        scaledPrice: scaledPrice.toString(),
        priceInDecimal: (Number(scaledPrice) / 1000000).toFixed(6),
      });

      return scaledPrice;
    } catch (error) {
      Logger.warn('Alternative V3 price calculation failed', error);
      return BigInt(0);
    }
  }

  // Store price data in history
  private storePriceData(poolKey: string, priceData: PriceData): void {
    if (!this.priceHistory.has(poolKey)) {
      this.priceHistory.set(poolKey, []);
    }

    const history = this.priceHistory.get(poolKey)!;
    history.push(priceData);

    // Keep only last 100 price points
    if (history.length > 100) {
      history.shift();
    }

    this.lastPriceUpdate.set(poolKey, Date.now());
  }

  // Get latest price for a pool
  getLatestPrice(poolKey: string): PriceData | null {
    const history = this.priceHistory.get(poolKey);
    if (!history || history.length === 0) {
      return null;
    }

    const latestPrice = history[history.length - 1];

    // Check if price is stale
    const age = Date.now() - (latestPrice?.timestamp ?? 0);
    if (age > TIME_CONSTANTS.PRICE_STALENESS_THRESHOLD) {
      Logger.warn('V3 price data is stale', {
        poolKey,
        age: `${age}ms`,
        threshold: `${TIME_CONSTANTS.PRICE_STALENESS_THRESHOLD}ms`,
      });
    }

    return latestPrice!;
  }

  // Get all latest prices
  getAllLatestPrices(): {
    pharaoh: PriceData | null;
    shadow: PriceData | null;
  } {
    return {
      pharaoh: this.getLatestPrice('pharaoh'),
      shadow: this.getLatestPrice('shadow'),
    };
  }

  // Get price history for a pool
  getPriceHistory(poolKey: string, maxAge?: number): PriceData[] {
    const history = this.priceHistory.get(poolKey) ?? [];

    if (!maxAge) {
      return [...history];
    }

    const cutoff = Date.now() - maxAge;
    return history.filter(p => p.timestamp >= cutoff);
  }

  // Calculate price difference between pools
  getPriceDifference(): number | null {
    const pharaoPrice = this.getLatestPrice('pharaoh');
    const shadowPrice = this.getLatestPrice('shadow');

    if (!pharaoPrice || !shadowPrice) {
      return null;
    }

    return ArbitrageCalculator.calculatePriceDifference(pharaoPrice.price0, shadowPrice.price0, 6);
  }

  // Check if price data is fresh
  isPriceDataFresh(maxAge: number = TIME_CONSTANTS.PRICE_STALENESS_THRESHOLD): boolean {
    const pharaoPrice = this.getLatestPrice('pharaoh');
    const shadowPrice = this.getLatestPrice('shadow');

    if (!pharaoPrice || !shadowPrice) {
      return false;
    }

    const now = Date.now();
    const pharaoAge = now - pharaoPrice.timestamp;
    const shadowAge = now - shadowPrice.timestamp;

    return pharaoAge <= maxAge && shadowAge <= maxAge;
  }

  // Calculate time-weighted average price
  getTWAP(poolKey: string, timeWindowMs: number = 300000): bigint | null {
    const history = this.getPriceHistory(poolKey, timeWindowMs);

    if (history.length === 0) {
      return null;
    }

    const pricePoints = history.map(p => ({
      price: p.price0,
      timestamp: p.timestamp,
    }));

    return ArbitrageCalculator.calculateTWAP(pricePoints, timeWindowMs);
  }

  // Get V3 pool information
  async getPoolInfo(network: 'avalanche' | 'sonic'): Promise<PoolInfo> {
    const config = NETWORKS[network];
    const client = network === 'avalanche' ? this.avalancheClient : this.sonicClient;
    const poolAddress = config?.contracts.dexPool as `0x${string}`;

    try {
      Logger.debug(`Getting V3 pool info for ${network}`, { poolAddress });

      const [token0, token1, fee, liquidity, slot0] = await Promise.all([
        client.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token0',
        }),
        client.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'token1',
        }),
        client.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'fee',
        }),
        client.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'liquidity',
        }),
        client.readContract({
          address: poolAddress,
          abi: COMMON_ABIS.UNISWAP_V3_POOL,
          functionName: 'slot0',
        }) as Promise<[bigint, number, number, number, number, number, boolean]>,
      ]);

      return {
        address: poolAddress,
        token0: token0 as string,
        token1: token1 as string,
        fee: fee as number,
        liquidity: liquidity as bigint,
        sqrtPriceX96: slot0[0],
        tick: slot0[1],
      };
    } catch (error) {
      Logger.error(`Failed to get V3 pool info for ${network}`, error);
      throw new PriceError('Failed to get V3 pool info', {
        network,
        poolAddress,
        error,
      });
    }
  }
}
