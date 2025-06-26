import dotenv from 'dotenv';
import { createClients } from './config/networks';
import { ARBITRAGE_CONFIG, MIN_BALANCES, TOKEN_DECIMALS } from './config/constants';
import { Logger } from './utils/logger';
import { ArbitrageCalculator } from './utils/calculations';
import { PriceMonitor } from './services/price/priceMonitor';
import { ArbitrageEngine } from './services/arbitrage/arbitrageEngine';
import { ArbitrageOpportunity, ArbitrageMetrics, PriceData } from './types';

dotenv.config();

export class CrossChainArbitrage {
  private readonly clients: ReturnType<typeof createClients>;
  private readonly priceMonitor: PriceMonitor;
  private readonly arbitrageEngine: ArbitrageEngine;
  private isRunning = false;
  private readonly metrics: ArbitrageMetrics;
  private readonly startTime: number;
  private simulationMode: boolean;
  private readonly useFallbackPricing: boolean;
  private testingMode = false;
  private testExecutionComplete = false;

  constructor(simulationMode: boolean = true, testingMode: boolean = false) {
    this.simulationMode = simulationMode;
    this.testingMode = testingMode;
    this.useFallbackPricing = process.env.USE_FALLBACK_PRICING === 'true';

    // Initialize logger
    Logger.init();

    // Create blockchain clients with error handling
    try {
      this.clients = createClients();
      Logger.success('Blockchain clients initialized successfully');
    } catch (error) {
      Logger.error('Failed to initialize blockchain clients', error);
      throw error;
    }

    // Initialize price monitor
    this.priceMonitor = new PriceMonitor(this.clients.avalanche.public, this.clients.sonic.public);

    // Initialize arbitrage engine
    this.arbitrageEngine = new ArbitrageEngine(
      this.clients.avalanche,
      this.clients.sonic,
      simulationMode
    );

    // Initialize metrics
    this.metrics = {
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: BigInt(0),
      totalLoss: BigInt(0),
      netProfit: BigInt(0),
      averageProfit: BigInt(0),
      largestProfit: BigInt(0),
      largestLoss: BigInt(0),
      uptime: 100,
      lastUpdate: Date.now(),
    };

    this.startTime = Date.now();

    const mode = simulationMode ? 'SIMULATION' : 'LIVE TRADING';
    const fallback = this.useFallbackPricing ? ' (FALLBACK PRICING)' : '';
    Logger.info(`CrossChainArbitrage system initialized in ${mode} mode${fallback} with DeBridge`);
  }

  // Start the arbitrage system with DeBridge
  async start(): Promise<void> {
    Logger.info('🚀 Starting Cross-Chain Arbitrage System with DeBridge');

    // Display configuration
    this.displayConfiguration();

    // Check initial balances
    try {
      await this.checkBalances();
    } catch (error) {
      Logger.warn('Balance check failed, continuing anyway', error);
    }

    // Health check with DeBridge
    await this.performHealthCheckWithDeBridge();

    // Get pool information
    try {
      await this.displayPoolInfo();
    } catch (error) {
      Logger.warn('Pool info failed, using fallback data', error);
    }

    // Start price monitoring with fallbacks
    try {
      await this.priceMonitor.startMonitoring(ARBITRAGE_CONFIG.monitoringIntervalMs);
      Logger.success('Price monitoring started successfully');
    } catch (error) {
      Logger.error('Price monitoring failed to start', error);
      if (!this.useFallbackPricing) {
        throw error;
      }
      Logger.info('Continuing with fallback pricing mode');
    }

    // Start main monitoring loop
    this.isRunning = true;
    await this.monitoringLoop();
  }

  // Health check with DeBridge
  private async performHealthCheckWithDeBridge(): Promise<void> {
    Logger.info('🏥 Performing system health check with DeBridge...');

    try {
      const healthStatus = await this.arbitrageEngine.healthCheck();

      Logger.info('System health status with DeBridge', {
        engine: healthStatus.engineStatus,
        bridges: {
          debridge: healthStatus.bridgeStatus?.debridge?.available
            ? '✅ Available'
            : '⚠️ Not available',
          ccip: healthStatus.bridgeStatus?.ccip?.available ? '✅ Available' : '⚠️ Not available',
        },
        dexes: {
          pharaoh: healthStatus.dexStatus?.pharaoh?.available
            ? '✅ Available'
            : '⚠️ Will use estimation',
          shadow: healthStatus.dexStatus?.shadow?.available
            ? '✅ Available'
            : '⚠️ Will use estimation',
        },
      });

      // Show bridge capabilities
      const bridgeManager = this.arbitrageEngine.getBridgeManager();
      const debridgeStats = await bridgeManager.getDeBridgeService().getBridgeStats();

      Logger.info('🌉 DeBridge Capabilities', {
        supportedNetworks: debridgeStats.supportedNetworks.join(', '),
        supportedTokens: debridgeStats.supportedTokens.join(', '),
        averageTime: `${debridgeStats.averageTime}s`,
        estimatedFee: debridgeStats.estimatedFee,
        advantages: debridgeStats.advantages.slice(0, 3).join(', '),
      });

      // Don't fail on service unavailability in simulation mode
      if (this.simulationMode) {
        Logger.info('Running in simulation mode - service failures will use fallbacks');
      }
    } catch (error) {
      Logger.warn('Health check failed, using fallback mode', error);
    }
  }

  // Display configuration
  private displayConfiguration(): void {
    const mode = this.simulationMode ? '🧪 SIMULATION' : '🔴 LIVE TRADING';
    const testing = this.testingMode ? ' + 🧪 FORCE TESTING' : '';
    const fallback = this.useFallbackPricing ? ' + FALLBACK PRICING' : '';

    Logger.info('⚙️  System Configuration', {
      mode: mode + testing + fallback,
      wallet: `${this.clients.account.address.slice(0, 6)}...${this.clients.account.address.slice(-4)}`,
      profitThreshold: this.testingMode
        ? 'BYPASSED IN TESTING'
        : `$${ARBITRAGE_CONFIG.profitThresholdUSD}`,
      monitoringInterval: `${ARBITRAGE_CONFIG.monitoringIntervalMs}ms`,
      bridgeProvider: 'DeBridge (USDT) + CCIP/DeBridge (USDC)',
      dexProviders: 'Pharaoh (Avalanche) + Shadow (Sonic)',
    });

    if (this.testingMode) {
      Logger.warn(
        '🧪 TESTING MODE ENABLED: Will force execute with real prices regardless of profit!'
      );
    }

    if (this.useFallbackPricing) {
      Logger.info('🔧 Using fallback pricing mode - this will generate test opportunities');
    }

    Logger.info('🌉 Bridge Strategy:');
    Logger.info('  • USDT: DeBridge (Avalanche ↔ Sonic, ~3 min, 0.001 ETH)');
    Logger.info('  • USDC: DeBridge/CCIP fallback (low fees, fast execution)');
    Logger.info('  • Advantages: Low fixed fees, fast execution, proven reliability');
  }

  // Analyze opportunity with DeBridge cost estimates
  private async analyzeOpportunityWithDeBridge(
    direction: 'avalanche-to-sonic' | 'sonic-to-avalanche',
    prices: { pharaoh: PriceData | null; shadow: PriceData | null }
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const { pharaoh, shadow } = prices;
      if (!pharaoh || !shadow) return null;

      // TESTING MODE OVERRIDE: Force opportunity creation with ANY price difference
      let buyPool, sellPool;

      if (this.testingMode) {
        // FORCE the direction that has ANY price difference
        const pharaohPrice = Number(pharaoh.price0) / 1000000;
        const shadowPrice = Number(shadow.price0) / 1000000;
        const actualDifference =
          Math.abs(pharaohPrice - shadowPrice) / Math.min(pharaohPrice, shadowPrice);

        Logger.warn('🧪 TESTING MODE: Forcing opportunity creation', {
          pharaohPrice: pharaohPrice.toFixed(6),
          shadowPrice: shadowPrice.toFixed(6),
          actualDifference: (actualDifference * 100).toFixed(4) + '%',
          forcedDirection: direction,
        });

        // Force the direction regardless of which is actually profitable
        if (direction === 'avalanche-to-sonic') {
          buyPool = { ...pharaoh, network: 'avalanche', token: 'USDC' as const };
          sellPool = { ...shadow, network: 'sonic', token: 'USDC' as const };
        } else {
          buyPool = { ...shadow, network: 'sonic', token: 'USDC' as const };
          sellPool = { ...pharaoh, network: 'avalanche', token: 'USDC' as const };
        }
      } else {
        // Normal profit-based logic
        if (direction === 'avalanche-to-sonic') {
          if (pharaoh.price0 >= shadow.price0) return null;
          buyPool = { ...pharaoh, network: 'avalanche', token: 'USDC' as const };
          sellPool = { ...shadow, network: 'sonic', token: 'USDC' as const };
        } else {
          if (shadow.price0 >= pharaoh.price0) return null;
          buyPool = { ...shadow, network: 'sonic', token: 'USDC' as const };
          sellPool = { ...pharaoh, network: 'avalanche', token: 'USDC' as const };
        }
      }

      // Use smaller trade amount for testing with DeBridge
      const tradeAmount = ArbitrageCalculator.usdToTokenAmount(1, TOKEN_DECIMALS.USDC); // $1

      // Get real bridge cost estimates from DeBridge
      const bridgeManager = this.arbitrageEngine.getBridgeManager();
      const bridgeCosts = await bridgeManager.estimateArbitrageBridgeCosts(direction);

      const estimatedGasCost = BigInt(4000000000000000); // 0.004 ETH

      // Calculate profits (force positive in testing mode)
      let grossProfit = ArbitrageCalculator.calculateArbitrageProfit(
        buyPool.price0,
        sellPool.price0,
        tradeAmount,
        TOKEN_DECIMALS.USDC
      );

      // TESTING MODE: Ensure we have some "gross profit" to work with
      if (this.testingMode && grossProfit <= BigInt(0)) {
        // Force a small positive gross profit for testing
        grossProfit = BigInt(50000); // $0.05 artificial profit
        Logger.warn('🧪 TESTING: Artificial gross profit applied for execution test', {
          artificialProfit: ArbitrageCalculator.formatAmount(
            grossProfit,
            TOKEN_DECIMALS.USDC,
            'USDC'
          ),
        });
      }

      const netProfit = ArbitrageCalculator.calculateNetProfit(
        grossProfit,
        estimatedGasCost,
        bridgeCosts.totalCost
      );

      const profitPercentage = ArbitrageCalculator.calculateProfitPercentage(
        netProfit,
        tradeAmount
      );

      const opportunity: ArbitrageOpportunity = {
        id: `${direction}-${Date.now()}`,
        direction,
        buyPool: {
          network: buyPool.network,
          pool: buyPool.pool,
          price: buyPool.price0,
          token: buyPool.token,
        },
        sellPool: {
          network: sellPool.network,
          pool: sellPool.pool,
          price: sellPool.price0,
          token: sellPool.token,
        },
        amount: tradeAmount,
        estimatedGasCost,
        estimatedBridgeCost: bridgeCosts.totalCost,
        grossProfit,
        netProfit,
        profitPercentage,
        // TESTING MODE: Always mark as profitable for execution
        profitable: this.testingMode ? true : netProfit > BigInt(100000),
        timestamp: Date.now(),
      };

      // TESTING MODE: Skip normal validation
      if (this.testingMode) {
        Logger.warn('🧪 TESTING: Bypassing opportunity validation', {
          direction,
          netProfit: ArbitrageCalculator.formatAmount(netProfit, TOKEN_DECIMALS.USDC, 'USDC'),
          bridgeCost: (Number(bridgeCosts.totalCost) / 1e18).toFixed(6) + ' ETH',
          forced: true,
        });
        return opportunity;
      }

      // Normal validation for production
      if (ArbitrageCalculator.validateOpportunity(opportunity)) {
        Logger.debug('Opportunity analyzed with DeBridge', {
          direction,
          bridgeProviders: `${bridgeCosts.breakdown.firstBridge.provider} + ${bridgeCosts.breakdown.secondBridge.provider}`,
          bridgeCost: (Number(bridgeCosts.totalCost) / 1e18).toFixed(6) + ' ETH',
          netProfit: ArbitrageCalculator.formatAmount(netProfit, TOKEN_DECIMALS.USDC, 'USDC'),
          profitable: opportunity.profitable,
        });
        return opportunity;
      }

      return null;
    } catch (error) {
      Logger.warn('Error analyzing opportunity with DeBridge', { direction, error });
      return null;
    }
  }

  // Enhanced monitoring loop with DeBridge
  private async monitoringLoop(): Promise<void> {
    Logger.info('📊 Starting monitoring loop with DeBridge');

    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (this.isRunning) {
      try {
        // Check for arbitrage opportunities with DeBridge
        await this.checkArbitrageOpportunitiesWithDeBridge();

        // Update metrics
        this.updateMetrics();

        // Reset error counter on success
        consecutiveErrors = 0;

        // Log periodic status (but less frequent if we completed our test)
        if (this.testingMode && this.testExecutionComplete) {
          if (Date.now() - this.startTime > 60000) {
            // Log every minute after test
            Logger.info('Test execution completed, system continues monitoring...');
          }
        } else if (Date.now() - this.startTime > 30000 && this.metrics.totalTrades === 0) {
          Logger.info('System running normally with DeBridge, monitoring for opportunities...');
        }

        // Wait for next cycle
        await this.sleep(ARBITRAGE_CONFIG.monitoringIntervalMs);
      } catch (error) {
        consecutiveErrors++;
        Logger.error(
          `Error in monitoring loop (${consecutiveErrors}/${maxConsecutiveErrors})`,
          error
        );

        if (consecutiveErrors >= maxConsecutiveErrors) {
          Logger.error('Too many consecutive errors, stopping system');
          break;
        }

        // Wait shorter time on error to retry quickly
        await this.sleep(5000);
      }
    }
  }

  // Check opportunities with DeBridge bridge
  private async checkArbitrageOpportunitiesWithDeBridge(): Promise<void> {
    // Check if already executing
    if (this.arbitrageEngine.isCurrentlyExecuting()) {
      Logger.debug('Arbitrage execution in progress, skipping opportunity check');
      return;
    }

    // Skip if we've already done our test execution
    if (this.testingMode && this.testExecutionComplete) {
      Logger.debug('Testing execution already completed, monitoring continues...');
      return;
    }

    // Get latest prices with fallback
    let prices;
    try {
      prices = this.priceMonitor.getAllLatestPrices();
    } catch (error) {
      Logger.warn('Price monitor failed, using fallback prices', error);
      prices = this.createFallbackPrices();
    }

    if (!prices.pharaoh || !prices.shadow) {
      if (this.useFallbackPricing) {
        Logger.debug('Using fallback price generation');
        prices = this.createFallbackPrices();
      } else {
        Logger.debug('Waiting for price data from both pools');
        return;
      }
    }

    // Calculate price difference
    const priceDifference = this.calculatePriceDifferenceFromPrices(prices);

    if (priceDifference === null) {
      Logger.debug('Unable to calculate price difference');
      return;
    }

    Logger.debug(`Price difference: ${(priceDifference * 100).toFixed(4)}%`);

    // TESTING MODE: Bypass the minimum price difference check
    if (this.testingMode) {
      Logger.warn('🧪 TESTING MODE: Bypassing price difference validation', {
        actualDifference: (priceDifference * 100).toFixed(4) + '%',
        normalThreshold: '0.0005%',
        forcing: 'execution with real prices',
      });
    } else {
      // Normal validation - require meaningful difference
      if (Math.abs(priceDifference) < 0.0001) {
        Logger.debug('Price difference too small for arbitrage with bridge costs');
        return;
      }
    }

    // Check for opportunities in both directions using DeBridge
    const opportunities = await Promise.allSettled([
      this.analyzeOpportunityWithDeBridge('avalanche-to-sonic', prices),
      this.analyzeOpportunityWithDeBridge('sonic-to-avalanche', prices),
    ]);

    const validOpportunities = opportunities
      .filter(
        (result): result is PromiseFulfilledResult<ArbitrageOpportunity | null> =>
          result.status === 'fulfilled' && result.value !== null
      )
      .map(result => result.value!);

    // Execute opportunities
    for (const opportunity of validOpportunities) {
      // TESTING MODE: Execute the first valid opportunity
      if (this.testingMode) {
        Logger.warn('🧪 TESTING MODE: Forcing execution with REAL prices', {
          netProfit: ArbitrageCalculator.formatAmount(
            opportunity.netProfit,
            TOKEN_DECIMALS.USDC,
            'USDC'
          ),
          direction: opportunity.direction,
          purpose: 'Testing execution mechanics with current market prices',
          realPrices: {
            pharaoh: ArbitrageCalculator.formatAmount(
              prices.pharaoh!.price0,
              TOKEN_DECIMALS.USDC,
              'USDC/USDT'
            ),
            shadow: ArbitrageCalculator.formatAmount(
              prices.shadow!.price0,
              TOKEN_DECIMALS.USDC,
              'USDC/USDT'
            ),
          },
        });

        Logger.info('🌉 Executing with DeBridge', {
          estimatedBridgeTime: '1-5 minutes',
          bridgeCost: (Number(opportunity.estimatedBridgeCost) / 1e18).toFixed(6) + ' ETH',
          testingMode: true,
          usingRealPrices: true,
        });

        if (this.simulationMode) {
          await this.simulateExecutionWithDeBridge(opportunity);
        } else {
          await this.executeRealArbitrageWithDeBridge(opportunity);
        }

        // Mark test as complete
        this.testExecutionComplete = true;
        Logger.success('🧪 TESTING: Execution test completed!');
        break; // Only do one test
      } else {
        // Normal profitable execution
        if (opportunity.profitable) {
          Logger.opportunity(
            opportunity.netProfit,
            opportunity.profitPercentage,
            opportunity.direction
          );

          Logger.info('🌉 Executing with DeBridge');

          if (this.simulationMode) {
            await this.simulateExecutionWithDeBridge(opportunity);
          } else {
            await this.executeRealArbitrageWithDeBridge(opportunity);
          }
        }
      }
    }
  }

  // Simulate execution with DeBridge
  private async simulateExecutionWithDeBridge(opportunity: ArbitrageOpportunity): Promise<void> {
    Logger.trade(`Simulating execution of ${opportunity.direction} with DeBridge`, {
      amount: ArbitrageCalculator.formatAmount(opportunity.amount, TOKEN_DECIMALS.USDC, 'USDC'),
      grossProfit: ArbitrageCalculator.formatAmount(
        opportunity.grossProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
      netProfit: ArbitrageCalculator.formatAmount(
        opportunity.netProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
      profitPercentage: `${opportunity.profitPercentage.toFixed(4)}%`,
      bridgeProvider: 'DeBridge',
      estimatedTime: '1-5 minutes',
      testingMode: this.testingMode,
    });

    // Simulate faster execution time with DeBridge
    await this.sleep(3000); // 3 seconds simulation

    // Always succeed in simulation with DeBridge
    this.metrics.totalTrades++;
    this.metrics.successfulTrades++;
    this.metrics.totalProfit += opportunity.netProfit;
    this.metrics.netProfit += opportunity.netProfit;

    if (opportunity.netProfit > this.metrics.largestProfit) {
      this.metrics.largestProfit = opportunity.netProfit;
    }

    Logger.success('Trade simulation completed successfully with DeBridge', {
      estimatedProfit: ArbitrageCalculator.formatAmount(
        opportunity.netProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
      direction: opportunity.direction,
      bridgeProvider: 'DeBridge',
      executionTime: '3.0s (simulated)',
      realWorldTime: '1-5 minutes expected',
      testingMode: this.testingMode,
    });
  }

  // Execute real arbitrage with DeBridge
  private async executeRealArbitrageWithDeBridge(opportunity: ArbitrageOpportunity): Promise<void> {
    try {
      Logger.info('🔴 Executing REAL arbitrage with DeBridge', {
        amount: ArbitrageCalculator.formatAmount(opportunity.amount, TOKEN_DECIMALS.USDC, 'USDC'),
        expectedProfit: ArbitrageCalculator.formatAmount(
          opportunity.netProfit,
          TOKEN_DECIMALS.USDC,
          'USDC'
        ),
        direction: opportunity.direction,
        testingMode: this.testingMode,
      });

      const result = await this.arbitrageEngine.executeArbitrage(opportunity);

      // Update metrics
      this.metrics.totalTrades++;
      if (result.success) {
        this.metrics.successfulTrades++;
        this.metrics.totalProfit += result.netProfit;
        this.metrics.netProfit += result.netProfit;

        if (result.netProfit > this.metrics.largestProfit) {
          this.metrics.largestProfit = result.netProfit;
        }
      } else {
        this.metrics.failedTrades++;
        if (result.netProfit < BigInt(0)) {
          this.metrics.totalLoss += -result.netProfit;
          this.metrics.netProfit += result.netProfit;

          if (-result.netProfit > this.metrics.largestLoss) {
            this.metrics.largestLoss = -result.netProfit;
          }
        }
      }
    } catch (error) {
      Logger.error('Real arbitrage execution failed', error);
      this.metrics.totalTrades++;
      this.metrics.failedTrades++;
    }
  }

  // Create fallback prices for testing
  private createFallbackPrices(): { pharaoh: PriceData; shadow: PriceData } {
    const basePrice = BigInt(1000000); // 1.0 in 6 decimals
    const spread = BigInt(2000); // 0.002 (0.2%) spread

    // Create slight price difference to simulate opportunity
    const pharaohPrice = basePrice - spread;
    const shadowPrice = basePrice + spread;

    const currentTime = Date.now();

    return {
      pharaoh: {
        price0: pharaohPrice,
        price1: BigInt(1000000000000) / pharaohPrice,
        timestamp: currentTime,
        blockNumber: BigInt(50000000),
        pool: process.env.PHARAOH_USDC_USDT_POOL!,
        network: 'avalanche',
        liquidity: BigInt(100000000000),
      },
      shadow: {
        price0: shadowPrice,
        price1: BigInt(1000000000000) / shadowPrice,
        timestamp: currentTime,
        blockNumber: BigInt(10000000),
        pool: process.env.SHADOW_USDC_USDT_POOL!,
        network: 'sonic',
        liquidity: BigInt(100000000000),
      },
    };
  }

  // Calculate price difference from price data
  private calculatePriceDifferenceFromPrices(prices: {
    pharaoh: PriceData | null;
    shadow: PriceData | null;
  }): number | null {
    if (!prices.pharaoh || !prices.shadow) {
      return null;
    }

    return ArbitrageCalculator.calculatePriceDifference(
      prices.pharaoh.price0,
      prices.shadow.price0,
      6
    );
  }

  // Stop the system
  stop(): void {
    Logger.info('🛑 Stopping arbitrage system...');
    this.isRunning = false;
    this.priceMonitor.stopMonitoring();
    this.displayFinalMetricsWithDeBridge();
  }

  // Check wallet balances
  private async checkBalances(): Promise<void> {
    try {
      Logger.info('💰 Checking wallet balances...');

      const address = this.clients.account.address;

      const [avaxBalance, sBalance] = await Promise.all([
        this.clients.avalanche.public.getBalance({ address }),
        this.clients.sonic.public.getBalance({ address }),
      ]);

      Logger.amount('AVAX', avaxBalance, TOKEN_DECIMALS.AVAX, 'Avalanche balance');
      Logger.amount('S', sBalance, TOKEN_DECIMALS.S, 'Sonic balance');

      if (avaxBalance < MIN_BALANCES.AVALANCHE_AVAX) {
        Logger.warn('Low AVAX balance for gas fees');
      }
      if (sBalance < MIN_BALANCES.SONIC_S) {
        Logger.warn('Low S balance for gas fees');
      }
    } catch (error) {
      Logger.warn('Failed to check balances', error);
    }
  }

  // Display pool information
  private async displayPoolInfo(): Promise<void> {
    try {
      Logger.info('🏊 Fetching pool information...');

      const [avalancheResult, sonicResult] = await Promise.allSettled([
        this.priceMonitor.getPoolInfo('avalanche'),
        this.priceMonitor.getPoolInfo('sonic'),
      ]);

      if (avalancheResult.status === 'fulfilled') {
        Logger.info('Pharaoh Pool (Avalanche)', {
          address: avalancheResult.value.address,
          liquidity: ArbitrageCalculator.formatAmount(
            avalancheResult.value.liquidity,
            TOKEN_DECIMALS.USDC,
            'USDC'
          ),
        });
      } else {
        Logger.warn('Failed to get Pharaoh pool info, using fallback');
      }

      if (sonicResult.status === 'fulfilled') {
        Logger.info('Shadow Pool (Sonic)', {
          address: sonicResult.value.address,
          liquidity: ArbitrageCalculator.formatAmount(
            sonicResult.value.liquidity,
            TOKEN_DECIMALS.USDC,
            'USDC'
          ),
        });
      } else {
        Logger.warn('Failed to get Shadow pool info, using fallback');
      }
    } catch (error) {
      Logger.warn('Pool info display failed', error);
    }
  }

  // Update metrics
  private updateMetrics(): void {
    this.metrics.lastUpdate = Date.now();
    if (this.metrics.totalTrades > 0) {
      this.metrics.averageProfit =
        this.metrics.totalProfit / BigInt(this.metrics.successfulTrades || 1);
    }
  }

  // Display final metrics
  private displayFinalMetricsWithDeBridge(): void {
    const mode = this.simulationMode ? 'SIMULATION' : 'LIVE TRADING';
    const testing = this.testingMode ? ' (TESTING)' : '';

    Logger.success(`📈 Final ${mode}${testing} Results with DeBridge`, {
      totalRuntime: `${((Date.now() - this.startTime) / 1000 / 60).toFixed(2)} minutes`,
      totalTrades: this.metrics.totalTrades,
      successRate: `${((this.metrics.successfulTrades / Math.max(this.metrics.totalTrades, 1)) * 100).toFixed(2)}%`,
      netProfit: ArbitrageCalculator.formatAmount(
        this.metrics.netProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
      largestProfit: ArbitrageCalculator.formatAmount(
        this.metrics.largestProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
      bridgeProvider: 'DeBridge',
      averageExecutionTime: '1-5 minutes (estimated)',
    });
  }

  // Sleep utility
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utility methods
  enableLiveTrading(): void {
    if (this.isRunning) {
      Logger.warn('Cannot change mode while system is running');
      return;
    }
    this.simulationMode = false;
    this.arbitrageEngine.setSimulationMode(false);
    Logger.warn('🔴 LIVE TRADING MODE ENABLED - Real funds will be used with DeBridge!');
  }

  enableSimulationMode(): void {
    if (this.isRunning) {
      Logger.warn('Cannot change mode while system is running');
      return;
    }
    this.simulationMode = true;
    this.arbitrageEngine.setSimulationMode(true);
    Logger.info('🧪 SIMULATION MODE ENABLED - No real funds will be used');
  }

  isSimulationMode(): boolean {
    return this.simulationMode;
  }

  enableTestingMode(): void {
    this.testingMode = true;
    Logger.warn('🧪 TESTING MODE ENABLED - Will execute regardless of profit for validation');
  }
}

// Main execution function
async function main() {
  const simulationMode = process.env.SIMULATION_MODE === 'true'; // Enable live trading
  const testingMode = process.env.ENABLE_TEST_MODE === 'true'; // Enable testing mode

  Logger.info('🔧 Starting in LIVE TESTING mode with DeBridge');

  const arbitrage = new CrossChainArbitrage(simulationMode, testingMode);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    Logger.info('Received SIGINT, shutting down gracefully...');
    arbitrage.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    Logger.info('Received SIGTERM, shutting down gracefully...');
    arbitrage.stop();
    process.exit(0);
  });

  try {
    await arbitrage.start();
  } catch (error) {
    Logger.error('Fatal error in main execution', error);

    // Provide helpful guidance
    Logger.info('\n🔧 Troubleshooting Tips:');
    Logger.info('1. Check your .env file has correct pool addresses');
    Logger.info('2. Verify RPC URLs are working');
    Logger.info('3. Try running the pool diagnostic script');
    Logger.info('4. Set USE_FALLBACK_PRICING=true in .env for testing');
    Logger.info('5. DeBridge API should be accessible');

    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    Logger.error('Unhandled error in main', error);
    process.exit(1);
  });
}
