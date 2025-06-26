import { PublicClient, WalletClient, Hash } from 'viem';
import { BridgeQuote, BridgeError } from '../../types';
import { Logger } from '../../utils/logger';
import { DeBridgeService } from './deBridge';
import { CCIPService } from './ccip';

export interface BridgeExecutionResult {
  provider: 'debridge' | 'ccip' | 'simulation';
  txHash: Hash;
  orderId?: string;
  messageId?: string;
  estimatedOutput: bigint;
  monitoringPromise: Promise<any>;
}

export interface BridgeRoute {
  token: 'USDC' | 'USDT';
  provider: 'debridge' | 'ccip' | 'simulation';
  available: boolean;
  estimatedCost: bigint;
  estimatedTime: number;
  reason?: string;
}

export class BridgeManager {
  private readonly debridge: DeBridgeService;
  private readonly ccip: CCIPService;
  private simulationMode: boolean;

  private readonly supportedChains = {
    debridge: [43114, 146],
    ccip: [43114, 146],
  };

  constructor(
    avalancheClient: { public: PublicClient; wallet: WalletClient },
    sonicClient: { public: PublicClient; wallet: WalletClient },
    simulationMode: boolean = true
  ) {
    this.debridge = new DeBridgeService(avalancheClient, sonicClient);
    this.ccip = new CCIPService(avalancheClient, sonicClient);
    this.simulationMode = simulationMode;

    Logger.debug('BridgeManager initialized with DeBridge', {
      debridgeSupported: this.supportedChains.debridge,
      ccipSupported: this.supportedChains.ccip,
      simulationMode,
    });
  }

  private getBestBridgeStrategy(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number
  ): { provider: 'debridge' | 'ccip' | 'simulation'; available: boolean; reason: string } {
    const isFromSupported = (provider: 'debridge' | 'ccip') =>
      this.supportedChains[provider].includes(fromChainId);
    const isToSupported = (provider: 'debridge' | 'ccip') =>
      this.supportedChains[provider].includes(toChainId);

    const debridgeAvailable = isFromSupported('debridge') && isToSupported('debridge');
    const ccipAvailable = isFromSupported('ccip') && isToSupported('ccip');

    // PROJECT REQUIREMENT: Use CCIP for USDC
    if (token === 'USDC' && ccipAvailable) {
      return {
        provider: 'ccip',
        available: true,
        reason: 'CCIP required for USDC per project specifications',
      };
    }

    // DeBridge for USDT (cheapest viable bridge)
    if (token === 'USDT' && debridgeAvailable) {
      return {
        provider: 'debridge',
        available: true,
        reason: 'DeBridge optimal for USDT - cheapest viable bridge',
      };
    }

    // Fallback logic
    if (debridgeAvailable) {
      return { provider: 'debridge', available: true, reason: 'DeBridge fallback' };
    }

    if (ccipAvailable) {
      return { provider: 'ccip', available: true, reason: 'CCIP fallback' };
    }

    return {
      provider: 'simulation',
      available: false,
      reason: `No bridge supports ${fromChainId} → ${toChainId}`,
    };
  }

  // Get quotes with DeBridge support
  async getAllQuotes(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string
  ): Promise<BridgeQuote[]> {
    const quotes: BridgeQuote[] = [];
    const strategy = this.getBestBridgeStrategy(token, fromChainId, toChainId);

    Logger.debug('Getting bridge quotes with DeBridge strategy', strategy);

    try {
      if (strategy.provider === 'simulation' || !strategy.available) {
        // Use simulation quote
        const simulationQuote = this.createSimulationQuote(token, fromChainId, toChainId, amount);
        quotes.push(simulationQuote);
      } else {
        // Try real bridge quotes
        try {
          if (strategy.provider === 'debridge') {
            const debridgeQuote = await this.debridge.getQuote(
              fromChainId,
              toChainId,
              amount,
              token
            );
            quotes.push(debridgeQuote);
          } else if (strategy.provider === 'ccip') {
            const ccipQuote = await this.ccip.getQuote(fromChainId, toChainId, amount, recipient);
            quotes.push(ccipQuote);
          }
        } catch (realBridgeError) {
          Logger.warn(`Real bridge (${strategy.provider}) failed, falling back to simulation`, {
            error: realBridgeError,
            strategy,
          });

          const simulationQuote = this.createSimulationQuote(token, fromChainId, toChainId, amount);
          quotes.push(simulationQuote);
        }
      }

      Logger.bridge('Bridge quotes obtained with DeBridge', {
        token,
        quotesCount: quotes.length,
        strategy: strategy.provider,
        reason: strategy.reason,
      });

      return quotes;
    } catch (error) {
      Logger.error('Failed to get any bridge quotes', error);

      // Final fallback - always provide a simulation quote
      const fallbackQuote = this.createSimulationQuote(token, fromChainId, toChainId, amount);

      return [fallbackQuote];
    }
  }

  // Create simulation quote for unsupported routes
  private createSimulationQuote(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number,
    amount: bigint
  ): BridgeQuote {
    // Conservative simulation estimates based on DeBridge
    const estimatedCost = this.getSimulationBridgeCost(fromChainId);
    const slippageFee = amount / BigInt(1000); // 0.1% simulation slippage
    const estimatedOutput = amount - slippageFee;

    return {
      fromToken: this.getTokenAddress(fromChainId, token),
      toToken: this.getTokenAddress(toChainId, token),
      fromNetwork: this.getNetworkName(fromChainId),
      toNetwork: this.getNetworkName(toChainId),
      amount,
      estimatedOutput,
      estimatedCost,
      estimatedTime: 180, // 3 minutes simulation (DeBridge speed)
      bridgeProvider: 'debridge', // Keep as debridge for compatibility
      slippage: 0.1, // 0.1% simulation slippage
    };
  }

  // Execute bridge with DeBridge support
  async executeBridge(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string,
    forceProvider?: 'debridge' | 'ccip'
  ): Promise<BridgeExecutionResult> {
    const strategy = forceProvider
      ? { provider: forceProvider, available: true, reason: 'Forced provider' }
      : this.getBestBridgeStrategy(token, fromChainId, toChainId);

    Logger.bridge('Executing bridge with DeBridge strategy', {
      provider: strategy.provider,
      token,
      amount: (Number(amount) / (token === 'USDC' ? 1e6 : 1e6)).toFixed(6) + ` ${token}`,
      fromChain: this.getNetworkName(fromChainId),
      toChain: this.getNetworkName(toChainId),
      reason: strategy.reason,
    });

    try {
      if (strategy.provider === 'simulation' || this.simulationMode) {
        return await this.executeSimulationBridge(token, fromChainId, toChainId, amount);
      }

      if (strategy.provider === 'debridge') {
        const result = await this.debridge.executeBridge(
          fromChainId,
          toChainId,
          amount,
          recipient,
          0.01,
          token
        );
        return {
          provider: 'debridge',
          txHash: result.txHash,
          orderId: result.orderId,
          estimatedOutput: result.estimatedOutput,
          monitoringPromise: this.debridge.monitorBridgeTransaction(result.orderId),
        };
      } else if (strategy.provider === 'ccip') {
        const result = await this.ccip.executeBridge(fromChainId, toChainId, amount, recipient);
        return {
          provider: 'ccip',
          txHash: result.txHash,
          messageId: result.messageId,
          estimatedOutput: result.estimatedOutput,
          monitoringPromise: this.ccip.monitorBridgeTransaction(result.messageId, toChainId),
        };
      }

      throw new Error('No valid bridge provider');
    } catch (error) {
      Logger.warn('Real bridge execution failed, falling back to simulation', { error });
      return await this.executeSimulationBridge(token, fromChainId, toChainId, amount);
    }
  }

  // Execute simulation bridge
  private async executeSimulationBridge(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number,
    amount: bigint
  ): Promise<BridgeExecutionResult> {
    // Simulate bridge execution
    const simulatedTxHash = `0x${'0'.repeat(56)}simulation${Date.now().toString(16)}` as Hash;
    const slippageFee = amount / BigInt(1000); // 0.1%
    const estimatedOutput = amount - slippageFee;

    Logger.bridge('Executing simulated bridge', {
      token,
      fromChain: this.getNetworkName(fromChainId),
      toChain: this.getNetworkName(toChainId),
      txHash: simulatedTxHash,
      estimatedOutput: (Number(estimatedOutput) / 1e6).toFixed(6) + ` ${token}`,
    });

    const monitoringPromise = this.simulateBridgeMonitoring(token, estimatedOutput);

    return {
      provider: 'simulation',
      txHash: simulatedTxHash,
      orderId: `sim_${Date.now()}`,
      estimatedOutput,
      monitoringPromise,
    };
  }

  // Simulate bridge monitoring (faster like DeBridge)
  private async simulateBridgeMonitoring(token: string, estimatedOutput: bigint): Promise<any> {
    // Simulate 1-3 minutes bridge time for DeBridge speeds
    const bridgeTime = 60000 + Math.random() * 120000; // 1-3 minutes

    Logger.debug(`Simulating DeBridge-speed bridge monitoring for ${bridgeTime.toFixed(0)}ms`);

    await new Promise(resolve => setTimeout(resolve, bridgeTime));

    Logger.success('Simulated DeBridge bridge completed', {
      token,
      output: (Number(estimatedOutput) / 1e6).toFixed(6) + ` ${token}`,
      duration: `${(bridgeTime / 1000).toFixed(1)}s`,
    });

    return { status: 'completed', simulatedOutput: estimatedOutput };
  }

  // Get simulation bridge cost (DeBridge estimates)
  private getSimulationBridgeCost(fromChainId: number): bigint {
    if (fromChainId === 43114) {
      return BigInt(1 * 10 ** 15); // 0.001 ETH (DeBridge fixed fee)
    } else if (fromChainId === 146) {
      return BigInt(1 * 10 ** 15); // 0.001 ETH equivalent
    }
    return BigInt(1 * 10 ** 15); // 0.001 ETH fallback
  }

  // Helper methods
  private getTokenAddress(chainId: number, token: 'USDC' | 'USDT'): string {
    if (chainId === 43114) {
      return token === 'USDC' ? process.env.AVALANCHE_USDC! : process.env.AVALANCHE_USDT!;
    } else if (chainId === 146) {
      return token === 'USDC' ? process.env.SONIC_USDC! : process.env.SONIC_USDT!;
    }
    return '0x';
  }

  private getNetworkName(chainId: number): string {
    switch (chainId) {
      case 43114:
        return 'avalanche';
      case 146:
        return 'sonic';
      default:
        return `chain_${chainId}`;
    }
  }

  async getBestQuote(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string
  ): Promise<BridgeQuote> {
    const quotes = await this.getAllQuotes(token, fromChainId, toChainId, amount, recipient);

    if (quotes.length === 0) {
      throw new BridgeError('No bridge quotes available', { token, fromChainId, toChainId });
    }

    // Sort by total cost
    quotes.sort((a, b) => {
      const aCost = a.estimatedCost + (amount - a.estimatedOutput);
      const bCost = b.estimatedCost + (amount - b.estimatedOutput);
      return Number(aCost - bCost);
    });

    return quotes[0]!;
  }

  // Get available routes
  async getAvailableRoutes(
    token: 'USDC' | 'USDT',
    fromChainId: number,
    toChainId: number
  ): Promise<BridgeRoute[]> {
    const routes: BridgeRoute[] = [];
    const strategy = this.getBestBridgeStrategy(token, fromChainId, toChainId);

    // Always add the recommended strategy
    routes.push({
      token,
      provider: strategy.provider,
      available: strategy.available,
      estimatedCost: this.getSimulationBridgeCost(fromChainId),
      estimatedTime:
        strategy.provider === 'debridge' ? 180 : strategy.provider === 'simulation' ? 180 : 900,
      reason: strategy.reason,
    });

    Logger.debug('Available bridge routes with DeBridge', {
      token,
      routesCount: routes.length,
      mainRoute: strategy,
    });

    return routes;
  }

  // Estimate arbitrage bridge costs
  async estimateArbitrageBridgeCosts(
    direction: 'avalanche-to-sonic' | 'sonic-to-avalanche'
  ): Promise<{
    totalCost: bigint;
    breakdown: {
      firstBridge: { provider: string; cost: bigint; token: string };
      secondBridge: { provider: string; cost: bigint; token: string };
    };
  }> {
    try {
      let firstBridge, secondBridge;

      if (direction === 'avalanche-to-sonic') {
        // USDT: Avalanche → Sonic (DeBridge)
        const usdtStrategy = this.getBestBridgeStrategy('USDT', 43114, 146);
        firstBridge = {
          provider: usdtStrategy.provider,
          cost: BigInt(1 * 10 ** 15), // 0.001 ETH for DeBridge
          token: 'USDT',
        };

        // USDC: Sonic → Avalanche (DeBridge or CCIP)
        const usdcStrategy = this.getBestBridgeStrategy('USDC', 146, 43114);
        secondBridge = {
          provider: usdcStrategy.provider,
          cost: BigInt(1 * 10 ** 15), // 0.001 ETH for DeBridge
          token: 'USDC',
        };
      } else {
        // USDC: Avalanche → Sonic (DeBridge or CCIP)
        const usdcStrategy = this.getBestBridgeStrategy('USDC', 43114, 146);
        firstBridge = {
          provider: usdcStrategy.provider,
          cost: BigInt(1 * 10 ** 15), // 0.001 ETH for DeBridge
          token: 'USDC',
        };

        // USDT: Sonic → Avalanche (DeBridge)
        const usdtStrategy = this.getBestBridgeStrategy('USDT', 146, 43114);
        secondBridge = {
          provider: usdtStrategy.provider,
          cost: BigInt(1 * 10 ** 15), // 0.001 ETH for DeBridge
          token: 'USDT',
        };
      }

      const totalCost = firstBridge.cost + secondBridge.cost;

      Logger.debug('Estimated arbitrage bridge costs with DeBridge', {
        direction,
        totalCost: (Number(totalCost) / 1e18).toFixed(6) + ' ETH',
        firstBridge: {
          ...firstBridge,
          cost: (Number(firstBridge.cost) / 1e18).toFixed(6) + ' ETH',
        },
        secondBridge: {
          ...secondBridge,
          cost: (Number(secondBridge.cost) / 1e18).toFixed(6) + ' ETH',
        },
      });

      return { totalCost, breakdown: { firstBridge, secondBridge } };
    } catch (error) {
      Logger.warn('Failed to estimate bridge costs, using conservative fallback', { error });
      return {
        totalCost: BigInt(2 * 10 ** 15), // 0.002 ETH (much cheaper with DeBridge)
        breakdown: {
          firstBridge: { provider: 'debridge', cost: BigInt(1 * 10 ** 15), token: 'unknown' },
          secondBridge: { provider: 'debridge', cost: BigInt(1 * 10 ** 15), token: 'unknown' },
        },
      };
    }
  }

  // Health check
  async healthCheck(): Promise<{
    debridge: { available: boolean; reason?: string };
    ccip: { available: boolean; reason?: string };
    simulation: { available: boolean };
  }> {
    const avalancheToSonic = this.getBestBridgeStrategy('USDT', 43114, 146);
    const sonicToAvalanche = this.getBestBridgeStrategy('USDC', 146, 43114);

    const healthStatus = {
      debridge: {
        available:
          avalancheToSonic.provider === 'debridge' || sonicToAvalanche.provider === 'debridge',
        reason:
          avalancheToSonic.provider === 'debridge'
            ? 'Supports Avalanche ↔ Sonic with low fees'
            : 'Route not available',
      },
      ccip: {
        available: sonicToAvalanche.provider === 'ccip' || avalancheToSonic.provider === 'ccip',
        reason:
          sonicToAvalanche.provider === 'ccip'
            ? 'Supports Sonic ↔ Avalanche with low fees'
            : 'Route not available',
      },
      simulation: {
        available: true,
      },
    };

    Logger.debug('Bridge services health check with DeBridge', healthStatus);

    return healthStatus;
  }

  // Monitor multiple bridge transactions
  async monitorMultipleBridges(
    bridgeResults: BridgeExecutionResult[]
  ): Promise<{ completed: number; failed: number; results: any[] }> {
    const results: any[] = [];
    let completed = 0;
    let failed = 0;

    Logger.bridge('Monitoring multiple bridge transactions', {
      count: bridgeResults.length,
    });

    for (const bridge of bridgeResults) {
      try {
        const result = await bridge.monitoringPromise;
        results.push({ success: true, provider: bridge.provider, result });
        completed++;

        Logger.success(`${bridge.provider} bridge completed`, {
          txHash: bridge.txHash,
          orderId: bridge.orderId,
          messageId: bridge.messageId,
        });
      } catch (error) {
        results.push({ success: false, provider: bridge.provider, error });
        failed++;

        Logger.error(`${bridge.provider} bridge failed`, {
          txHash: bridge.txHash,
          error,
        });
      }
    }

    Logger.bridge('Bridge monitoring completed', {
      total: bridgeResults.length,
      completed,
      failed,
    });

    return { completed, failed, results };
  }

  // Set simulation mode
  setSimulationMode(enabled: boolean): void {
    this.simulationMode = enabled;
    Logger.info(`Bridge simulation mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Get bridge service instances
  getDeBridgeService(): DeBridgeService {
    return this.debridge;
  }

  getCCIPService(): CCIPService {
    return this.ccip;
  }
}
