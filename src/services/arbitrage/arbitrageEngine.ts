import { PublicClient, WalletClient, Hash } from 'viem';
import {
  ArbitrageOpportunity,
  ExecutionPlan,
  ExecutionStep,
  ArbitrageError,
  DEXSwapResult,
  ArbitrageExecutionResult,
} from '../../types';
import { TOKEN_DECIMALS } from '../../config/constants';
import { Logger } from '../../utils/logger';
import { ArbitrageCalculator } from '../../utils/calculations';
import { generateId } from '../../utils/helper';
import { BridgeManager, BridgeExecutionResult } from '../bridge/bridgeManager';
import { DEXManager } from '../dex/dexManager';

export class ArbitrageEngine {
  private readonly bridgeManager: BridgeManager;
  private readonly dexManager: DEXManager;
  private isExecuting = false;
  private readonly executionHistory: ArbitrageExecutionResult[] = [];

  constructor(
    avalancheClient: { public: PublicClient; wallet: WalletClient },
    sonicClient: { public: PublicClient; wallet: WalletClient },
    simulationMode: boolean = true
  ) {
    this.bridgeManager = new BridgeManager(avalancheClient, sonicClient, simulationMode);
    this.dexManager = new DEXManager(avalancheClient, sonicClient);

    Logger.debug('ArbitrageEngine initialized with DeBridge', {
      simulationMode,
      bridgeProviders: ['DeBridge', 'CCIP'],
      dexProviders: ['Pharaoh', 'Shadow'],
    });
  }

  private async createExecutionPlan(opportunity: ArbitrageOpportunity): Promise<ExecutionPlan> {
    const steps: ExecutionStep[] = [];
    let totalGasCost = BigInt(0);
    let totalBridgeCost = BigInt(0);
    let estimatedDuration = 0;

    if (opportunity.direction === 'avalanche-to-sonic') {
      // Step 1: Swap USDC → USDT on Pharaoh (Avalanche)
      steps.push({
        type: 'swap',
        network: 'avalanche',
        description: 'Swap USDC → USDT on Pharaoh',
        status: 'pending',
      });

      // Step 2: Bridge USDT: Avalanche → Sonic (DeBridge)
      steps.push({
        type: 'bridge',
        network: 'avalanche',
        description: 'Bridge USDT from Avalanche to Sonic via DeBridge',
        status: 'pending',
      });

      // Step 3: Wait for bridge completion
      steps.push({
        type: 'wait',
        network: 'sonic',
        description: 'Wait for USDT bridge completion on Sonic',
        status: 'pending',
      });

      // Step 4: Swap USDT → USDC on Shadow (Sonic)
      steps.push({
        type: 'swap',
        network: 'sonic',
        description: 'Swap USDT → USDC on Shadow',
        status: 'pending',
      });

      // Step 5: Bridge USDC: Sonic → Avalanche (DeBridge or CCIP)
      steps.push({
        type: 'bridge',
        network: 'sonic',
        description: 'Bridge USDC from Sonic to Avalanche via DeBridge',
        status: 'pending',
      });

      // Step 6: Wait for final bridge completion
      steps.push({
        type: 'wait',
        network: 'avalanche',
        description: 'Wait for USDC bridge completion on Avalanche',
        status: 'pending',
      });
    } else {
      // Step 1: Bridge USDC: Avalanche → Sonic (DeBridge or CCIP)
      steps.push({
        type: 'bridge',
        network: 'avalanche',
        description: 'Bridge USDC from Avalanche to Sonic via DeBridge',
        status: 'pending',
      });

      // Step 2: Wait for bridge completion
      steps.push({
        type: 'wait',
        network: 'sonic',
        description: 'Wait for USDC bridge completion on Sonic',
        status: 'pending',
      });

      // Step 3: Swap USDC → USDT on Shadow (Sonic)
      steps.push({
        type: 'swap',
        network: 'sonic',
        description: 'Swap USDC → USDT on Shadow',
        status: 'pending',
      });

      // Step 4: Bridge USDT: Sonic → Avalanche (DeBridge)
      steps.push({
        type: 'bridge',
        network: 'sonic',
        description: 'Bridge USDT from Sonic to Avalanche via DeBridge',
        status: 'pending',
      });

      // Step 5: Wait for bridge completion
      steps.push({
        type: 'wait',
        network: 'avalanche',
        description: 'Wait for USDT bridge completion on Avalanche',
        status: 'pending',
      });

      // Step 6: Swap USDT → USDC on Pharaoh (Avalanche)
      steps.push({
        type: 'swap',
        network: 'avalanche',
        description: 'Swap USDT → USDC on Pharaoh',
        status: 'pending',
      });
    }

    // Estimate costs with DeBridge bridge
    const bridgeCosts = await this.bridgeManager.estimateArbitrageBridgeCosts(
      opportunity.direction
    );

    totalBridgeCost = bridgeCosts.totalCost;
    totalGasCost = opportunity.estimatedGasCost;
    estimatedDuration = 360;

    Logger.debug('Execution plan created with DeBridge', {
      stepsCount: steps.length,
      direction: opportunity.direction,
      estimatedDuration: `${estimatedDuration}s`,
      bridgeCosts: {
        first: bridgeCosts.breakdown.firstBridge.provider,
        second: bridgeCosts.breakdown.secondBridge.provider,
        total: (Number(totalBridgeCost) / 1e18).toFixed(6) + ' ETH',
      },
    });

    return {
      steps,
      totalGasCost,
      totalBridgeCost,
      estimatedDuration,
      expectedProfit: opportunity.netProfit,
    };
  }

  // Execute bridge step with DeBridge
  private async executeBridgeStep(
    step: ExecutionStep,
    amount: bigint
  ): Promise<BridgeExecutionResult> {
    const fromChainId = step.network === 'avalanche' ? 43114 : 146;
    const toChainId = step.network === 'avalanche' ? 146 : 43114;

    // Determine token based on step description
    let token: 'USDC' | 'USDT';

    if (step.description.includes('USDT')) {
      token = 'USDT';
    } else {
      token = 'USDC';
    }

    Logger.bridge(
      `Executing bridge step: ${token} ${step.network} → ${
        toChainId === 43114 ? 'avalanche' : 'sonic'
      }`,
      {
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[token], token),
        bridgeProvider: step.description.includes('DeBridge') ? 'DeBridge' : 'Auto-selected',
      }
    );

    return await this.bridgeManager.executeBridge(token, fromChainId, toChainId, amount);
  }

  // Set simulation mode
  setSimulationMode(enabled: boolean): void {
    this.bridgeManager.setSimulationMode(enabled);
    Logger.info(`Arbitrage engine simulation mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Get bridge service for direct access
  getBridgeManager(): BridgeManager {
    return this.bridgeManager;
  }

  // Health check
  async healthCheck(): Promise<{
    engineStatus: 'ready' | 'executing' | 'error';
    bridgeStatus: any;
    dexStatus: any;
    lastExecution?: ArbitrageExecutionResult;
  }> {
    try {
      const [bridgeStatus, dexStatus] = await Promise.all([
        this.bridgeManager.healthCheck(),
        this.dexManager.healthCheck(),
      ]);

      const engineStatus = this.isExecuting ? 'executing' : 'ready';
      const lastExecution =
        this.executionHistory.length > 0
          ? this.executionHistory[this.executionHistory.length - 1]
          : undefined;

      Logger.debug('Arbitrage engine health check with DeBridge', {
        engineStatus,
        debridge: bridgeStatus.debridge?.available ? '✅' : '❌',
        ccip: bridgeStatus.ccip?.available ? '✅' : '❌',
        pharaoh: dexStatus.pharaoh?.available ? '✅' : '❌',
        shadow: dexStatus.shadow?.available ? '✅' : '❌',
      });

      return {
        engineStatus,
        bridgeStatus,
        dexStatus,
        lastExecution: lastExecution!,
      };
    } catch (error) {
      Logger.error('Arbitrage engine health check failed', error);
      return {
        engineStatus: 'error',
        bridgeStatus: null,
        dexStatus: null,
      };
    }
  }

  // Execute complete arbitrage opportunity
  async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    if (this.isExecuting) {
      throw new ArbitrageError('Arbitrage execution already in progress', 'EXECUTION_IN_PROGRESS');
    }

    this.isExecuting = true;
    const startTime = Date.now();
    const executionId = generateId('arb');

    Logger.arbitrage('Starting arbitrage execution with DeBridge', {
      id: executionId,
      direction: opportunity.direction,
      amount: ArbitrageCalculator.formatAmount(opportunity.amount, TOKEN_DECIMALS.USDC, 'USDC'),
      expectedProfit: ArbitrageCalculator.formatAmount(
        opportunity.netProfit,
        TOKEN_DECIMALS.USDC,
        'USDC'
      ),
    });

    try {
      // Create execution plan
      const executionPlan = await this.createExecutionPlan(opportunity);

      // Validate opportunity is still profitable
      await this.validateOpportunity(opportunity);

      // Execute the plan
      const result = await this.executePlan(executionPlan, opportunity);

      result.executionTime = Date.now() - startTime;

      // Store in history
      this.executionHistory.push(result);

      if (result.success) {
        Logger.success('Arbitrage execution completed successfully with DeBridge', {
          id: executionId,
          netProfit: ArbitrageCalculator.formatAmount(
            result.netProfit,
            TOKEN_DECIMALS.USDC,
            'USDC'
          ),
          executionTime: `${(result.executionTime / 1000).toFixed(2)}s`,
          transactions: result.transactions.length,
          bridgeProvider: 'DeBridge',
        });
      } else {
        Logger.error('Arbitrage execution failed', {
          id: executionId,
          failedStep: result.failedStep?.type,
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      Logger.error('Arbitrage execution error', error);

      const result: ArbitrageExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        executionPlan: await this.createExecutionPlan(opportunity),
        completedSteps: [],
        netProfit: BigInt(0),
        totalGasCost: BigInt(0),
        totalBridgeCost: BigInt(0),
        executionTime: Date.now() - startTime,
        transactions: [],
        error,
      };

      this.executionHistory.push(result);
      return result;
    } finally {
      this.isExecuting = false;
    }
  }

  private async executePlan(
    plan: ExecutionPlan,
    opportunity: ArbitrageOpportunity
  ): Promise<ArbitrageExecutionResult> {
    const completedSteps: ExecutionStep[] = [];
    const transactions: Hash[] = [];
    let actualGasCost = BigInt(0);
    const actualBridgeCost = BigInt(0);
    let currentAmount = opportunity.amount;

    try {
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        if (!step) continue;
        step.status = 'executing';
        step.timestamp = Date.now();

        Logger.info(`Executing step ${i + 1}/${plan.steps.length}: ${step.description}`);

        try {
          if (step.type === 'swap') {
            const swapResult = await this.executeSwapStep(step, opportunity, currentAmount);
            step.txHash = swapResult.txHash;
            step.actualGas = swapResult.actualGasUsed;
            actualGasCost += swapResult.actualGasUsed * BigInt(20000000000); // 20 Gwei estimate
            transactions.push(swapResult.txHash);
            currentAmount = swapResult.amountOut;
          } else if (step.type === 'bridge') {
            const bridgeResult = await this.executeBridgeStep(step, currentAmount);
            step.txHash = bridgeResult.txHash;
            transactions.push(bridgeResult.txHash);
            currentAmount = bridgeResult.estimatedOutput;

            // Monitor bridge completion
            await bridgeResult.monitoringPromise;
          } else if (step.type === 'wait') {
            // Wait step is handled by bridge monitoring
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second buffer for DeBridge
          }

          step.status = 'completed';
          completedSteps.push({ ...step });

          Logger.success(`Step ${i + 1} completed: ${step.description}`, {
            txHash: step.txHash,
            gasUsed: step.actualGas?.toString(),
          });
        } catch (stepError) {
          step.status = 'failed';
          Logger.error(`Step ${i + 1} failed: ${step.description}`, stepError);

          return {
            opportunityId: opportunity.id,
            success: false,
            executionPlan: plan,
            completedSteps,
            failedStep: step,
            netProfit: BigInt(0),
            totalGasCost: actualGasCost,
            totalBridgeCost: actualBridgeCost,
            executionTime: 0,
            transactions,
            error: stepError,
          };
        }
      }

      // Calculate final profit
      const netProfit = currentAmount - opportunity.amount - actualGasCost;

      return {
        opportunityId: opportunity.id,
        success: true,
        executionPlan: plan,
        completedSteps,
        netProfit,
        totalGasCost: actualGasCost,
        totalBridgeCost: actualBridgeCost,
        executionTime: 0,
        transactions,
      };
    } catch (error) {
      return {
        opportunityId: opportunity.id,
        success: false,
        executionPlan: plan,
        completedSteps,
        netProfit: BigInt(0),
        totalGasCost: actualGasCost,
        totalBridgeCost: actualBridgeCost,
        executionTime: 0,
        transactions,
        error,
      };
    }
  }

  private async executeSwapStep(
    step: ExecutionStep,
    opportunity: ArbitrageOpportunity,
    amount: bigint
  ): Promise<DEXSwapResult> {
    const isAvalanche = step.network === 'avalanche';
    const dex = isAvalanche ? 'pharaoh' : 'shadow';

    if (opportunity.direction === 'avalanche-to-sonic') {
      if (isAvalanche) {
        // Swap USDC → USDT on Pharaoh
        return await this.dexManager.executeSwap(dex, 'USDC', 'USDT', amount);
      } else {
        // Swap USDT → USDC on Shadow
        return await this.dexManager.executeSwap(dex, 'USDT', 'USDC', amount);
      }
    } else {
      if (isAvalanche) {
        // Swap USDT → USDC on Pharaoh
        return await this.dexManager.executeSwap(dex, 'USDT', 'USDC', amount);
      } else {
        // Swap USDC → USDT on Shadow
        return await this.dexManager.executeSwap(dex, 'USDC', 'USDT', amount);
      }
    }
  }

  // Validate opportunity is still profitable
  private async validateOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    // Check if prices haven't moved against us significantly
    const currentQuotes = await this.dexManager.getAllQuotes('USDC', 'USDT', opportunity.amount);

    if (!currentQuotes.pharaoh || !currentQuotes.shadow) {
      throw new ArbitrageError('Current quotes not available', 'QUOTES_UNAVAILABLE');
    }

    const currentPriceDiff = ArbitrageCalculator.calculatePriceDifference(
      currentQuotes.pharaoh?.amountOut ?? BigInt(0),
      currentQuotes.shadow?.amountOut ?? BigInt(0),
      TOKEN_DECIMALS.USDC
    );

    const originalPriceDiff = ArbitrageCalculator.calculatePriceDifference(
      opportunity.buyPool.price,
      opportunity.sellPool.price,
      TOKEN_DECIMALS.USDC
    );

    // If price difference has decreased by more than 50%, abort
    if (currentPriceDiff < originalPriceDiff * 0.5) {
      throw new ArbitrageError(
        'Price difference has decreased significantly',
        'PRICE_MOVED_AGAINST_US',
        {
          originalDiff: originalPriceDiff,
          currentDiff: currentPriceDiff,
        }
      );
    }

    Logger.debug('Opportunity validation passed', {
      originalPriceDiff: `${(originalPriceDiff * 100).toFixed(4)}%`,
      currentPriceDiff: `${(currentPriceDiff * 100).toFixed(4)}%`,
    });
  }

  // Simulate arbitrage execution (for testing)
  async simulateArbitrage(opportunity: ArbitrageOpportunity): Promise<{
    feasible: boolean;
    estimatedProfit: bigint;
    estimatedCosts: bigint;
    estimatedTime: number;
    risks: string[];
  }> {
    try {
      const risks: string[] = [];

      // Check bridge availability with DeBridge
      const bridgeHealth = await this.bridgeManager.healthCheck();
      if (!bridgeHealth.debridge.available) {
        risks.push('DeBridge not available');
      }
      if (!bridgeHealth.ccip.available) {
        risks.push('CCIP not available');
      }

      // Check DEX availability
      const dexHealth = await this.dexManager.healthCheck();
      if (!dexHealth.pharaoh.available) {
        risks.push('Pharaoh DEX not available');
      }
      if (!dexHealth.shadow.available) {
        risks.push('Shadow DEX not available');
      }

      // Estimate actual costs with DeBridge
      const bridgeCosts = await this.bridgeManager.estimateArbitrageBridgeCosts(
        opportunity.direction
      );

      const swapCosts = await this.dexManager.estimateSwapCosts([
        {
          dex: opportunity.direction === 'avalanche-to-sonic' ? 'pharaoh' : 'shadow',
          tokenIn: 'USDC',
          tokenOut: 'USDT',
          amount: opportunity.amount,
        },
        {
          dex: opportunity.direction === 'avalanche-to-sonic' ? 'shadow' : 'pharaoh',
          tokenIn: 'USDT',
          tokenOut: 'USDC',
          amount: opportunity.amount,
        },
      ]);

      const totalCosts = bridgeCosts.totalCost + swapCosts.totalGasCost;
      const estimatedProfit = opportunity.grossProfit - totalCosts;
      const feasible = estimatedProfit > BigInt(0) && risks.length === 0;

      // Risk assessment
      if (swapCosts.totalPriceImpact > 2.0) {
        risks.push('High price impact on swaps');
      }
      if (Number(totalCosts) / Number(opportunity.amount) > 0.1) {
        risks.push('High cost ratio');
      }

      Logger.debug('Arbitrage simulation completed with DeBridge', {
        feasible,
        estimatedProfit: ArbitrageCalculator.formatAmount(
          estimatedProfit,
          TOKEN_DECIMALS.USDC,
          'USDC'
        ),
        totalCosts: ArbitrageCalculator.formatAmount(totalCosts, TOKEN_DECIMALS.USDC, 'USDC'),
        risks: risks.length,
        bridgeProvider: 'DeBridge',
      });

      return {
        feasible,
        estimatedProfit,
        estimatedCosts: totalCosts,
        estimatedTime: 360, // 6 minutes with DeBridge
        risks,
      };
    } catch (error) {
      Logger.error('Arbitrage simulation failed', error);
      return {
        feasible: false,
        estimatedProfit: BigInt(0),
        estimatedCosts: BigInt(0),
        estimatedTime: 0,
        risks: ['Simulation failed'],
      };
    }
  }

  // Emergency stop execution
  async emergencyStop(reason: string): Promise<void> {
    Logger.warn('Emergency stop triggered', { reason });
    this.isExecuting = false;

    // In a full implementation, we must:
    // 1. Cancel pending transactions where possible
    // 2. Save current state
    // 3. Initiate recovery procedures
  }

  // Get execution status
  isCurrentlyExecuting(): boolean {
    return this.isExecuting;
  }

  // Get execution history
  getExecutionHistory(limit?: number): ArbitrageExecutionResult[] {
    const history = [...this.executionHistory].reverse(); // Most recent first
    return limit ? history.slice(0, limit) : history;
  }

  // Get execution statistics
  getExecutionStats(): {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: number;
    totalProfit: bigint;
    totalGasCost: bigint;
    averageExecutionTime: number;
  } {
    const successful = this.executionHistory.filter(r => r.success);
    const failed = this.executionHistory.filter(r => !r.success);

    const totalProfit = successful.reduce((sum, r) => sum + r.netProfit, BigInt(0));
    const totalGasCost = this.executionHistory.reduce((sum, r) => sum + r.totalGasCost, BigInt(0));
    const averageExecutionTime =
      this.executionHistory.length > 0
        ? this.executionHistory.reduce((sum, r) => sum + r.executionTime, 0) /
          this.executionHistory.length
        : 0;

    return {
      totalExecutions: this.executionHistory.length,
      successfulExecutions: successful.length,
      failedExecutions: failed.length,
      successRate:
        this.executionHistory.length > 0
          ? (successful.length / this.executionHistory.length) * 100
          : 0,
      totalProfit,
      totalGasCost,
      averageExecutionTime,
    };
  }

  // Get service instances for direct access
  getDEXManager(): DEXManager {
    return this.dexManager;
  }
}
