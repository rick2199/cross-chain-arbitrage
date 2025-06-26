import { Hash } from 'viem';

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: string;
  blockExplorer: string;
  contracts: {
    usdc: string;
    usdt: string;
    dexPool: string;
    router?: string;
    factory?: string;
  };
}

export interface PriceData {
  price0: bigint; // USDC price in terms of USDT
  price1: bigint; // USDT price in terms of USDC
  timestamp: number;
  blockNumber: bigint;
  pool: string;
  network: string;
  liquidity: bigint;
  sqrtPriceX96?: bigint; // For V3 pools
}

export interface ArbitrageOpportunity {
  id: string;
  direction: 'avalanche-to-sonic' | 'sonic-to-avalanche';
  buyPool: {
    network: string;
    pool: string;
    price: bigint;
    token: 'USDC' | 'USDT';
  };
  sellPool: {
    network: string;
    pool: string;
    price: bigint;
    token: 'USDC' | 'USDT';
  };
  amount: bigint;
  estimatedGasCost: bigint;
  estimatedBridgeCost: bigint;
  grossProfit: bigint;
  netProfit: bigint;
  profitPercentage: number;
  profitable: boolean;
  timestamp: number;
}

export interface BridgeQuote {
  fromToken: string;
  toToken: string;
  fromNetwork: string;
  toNetwork: string;
  amount: bigint;
  estimatedOutput: bigint;
  estimatedCost: bigint;
  estimatedTime: number; // in seconds
  bridgeProvider: 'debridge' | 'ccip';
  slippage: number;
}

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  impact: number; // price impact percentage
  gasEstimate: bigint;
  pool: string;
  network: string;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  totalGasCost: bigint;
  totalBridgeCost: bigint;
  estimatedDuration: number; // in seconds
  expectedProfit: bigint;
}

export interface ExecutionStep {
  type: 'swap' | 'bridge' | 'wait';
  network: string;
  description: string;
  txHash?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  estimatedGas?: bigint;
  actualGas?: bigint;
  timestamp?: number;
}

export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing?: number;
  liquidity: bigint;
  sqrtPriceX96?: bigint;
  tick?: number;
}

export interface TokenBalance {
  token: string;
  balance: bigint;
  decimals: number;
  symbol: string;
  network: string;
}

export interface GasPrice {
  network: string;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  timestamp: number;
}

export interface ArbitrageConfig {
  profitThresholdUSD: number;
  minTradeAmountUSD: number;
  maxTradeAmountUSD: number;
  slippageTolerance: number;
  maxGasPriceGwei: number;
  monitoringIntervalMs: number;
  emergencyStopLoss: number; // percentage
}

export interface ArbitrageMetrics {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: bigint;
  totalLoss: bigint;
  netProfit: bigint;
  averageProfit: bigint;
  largestProfit: bigint;
  largestLoss: bigint;
  uptime: number; // percentage
  lastUpdate: number;
}

export interface ArbitrageEvent {
  type:
    | 'opportunity_found'
    | 'execution_started'
    | 'execution_completed'
    | 'execution_failed'
    | 'price_update';
  timestamp: number;
  data: any;
}

export class ArbitrageError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: any
  ) {
    super(message);
    this.name = 'ArbitrageError';
  }
}

export class BridgeError extends ArbitrageError {
  constructor(message: string, context?: any) {
    super(message, 'BRIDGE_ERROR', context);
    this.name = 'BridgeError';
  }
}

export class SwapError extends ArbitrageError {
  constructor(message: string, context?: any) {
    super(message, 'SWAP_ERROR', context);
    this.name = 'SwapError';
  }
}

export class PriceError extends ArbitrageError {
  constructor(message: string, context?: any) {
    super(message, 'PRICE_ERROR', context);
    this.name = 'PriceError';
  }
}

export interface SwapParams {
  router: string;
  sender: string;
  recipient: string;
  fromAsset: string;
  toAsset: string;
  deadline: string;
  amountOutMin: string;
  swapFee: string;
  amountIn: string;
}

export interface DEXSwapResult {
  dex: 'pharaoh' | 'shadow';
  network: 'avalanche' | 'sonic';
  txHash: Hash;
  amountIn: bigint;
  amountOut: bigint;
  actualGasUsed: bigint;
  priceImpact: number;
}

export interface DEXRoute {
  dex: 'pharaoh' | 'shadow';
  network: 'avalanche' | 'sonic';
  available: boolean;
  quote?: SwapQuote;
  healthScore: number;
}

export interface DEXHealthStatus {
  available: boolean;
  latency: number | undefined;
  poolHealth?: any;
}

export interface ArbitrageExecutionResult {
  opportunityId: string;
  success: boolean;
  executionPlan: ExecutionPlan;
  completedSteps: ExecutionStep[];
  failedStep?: ExecutionStep;
  netProfit: bigint;
  totalGasCost: bigint;
  totalBridgeCost: bigint;
  executionTime: number;
  transactions: Hash[];
  error?: any;
}
