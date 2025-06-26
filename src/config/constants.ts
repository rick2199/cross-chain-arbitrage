import { ArbitrageConfig } from '../types';

export const ARBITRAGE_CONFIG: ArbitrageConfig = {
  profitThresholdUSD: parseFloat(process.env.PROFIT_THRESHOLD_USD ?? '0.50'),
  minTradeAmountUSD: parseFloat(process.env.MIN_TRADE_AMOUNT_USD ?? '1.00'),
  maxTradeAmountUSD: parseFloat(process.env.MAX_TRADE_AMOUNT_USD ?? '50.00'),
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE ?? '0.005'),
  maxGasPriceGwei: 50,
  monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS ?? '10000'),
  emergencyStopLoss: 0.05,
};

export const TOKEN_DECIMALS = {
  USDC: 6,
  USDT: 6,
  AVAX: 18,
  S: 18,
  ETH: 18,
} as const;

export const BRIDGE_CONFIG = {
  DEBRIDGE: {
    name: 'DeBridge',
    apiUrl: process.env.DEBRIDGE_API_URL!,
    fixedFee: BigInt(10 ** 15),
    supportedTokens: ['USDT', 'USDC', 'ETH', 'WBTC', 'DAI'],
    supportedNetworks: [43114, 146, 1, 137, 56, 42161],
    averageTime: 180,
    maxSlippage: 0.005,
  },
  CCIP: {
    name: 'Chainlink CCIP',
    supportedTokens: ['USDC'],
    networks: ['avalanche', 'sonic'],
    averageTime: 900,
    estimatedCost: BigInt(75 * 10 ** 17),
  },
} as const;

export const MAX_SLIPPAGE = {
  SWAP: 0.01,
  BRIDGE: 0.005,
} as const;

export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
  EXPONENTIAL_BACKOFF: true,
} as const;

export const TIME_CONSTANTS = {
  BLOCK_TIME_AVALANCHE: 2000,
  BLOCK_TIME_SONIC: 1000,
  BRIDGE_TIMEOUT: 300000,
  PRICE_STALENESS_THRESHOLD: 30000,
  DEBRIDGE_POLL_INTERVAL: 15000,
  DEBRIDGE_MAX_TIME: 300000,
} as const;

export const MIN_BALANCES = {
  AVALANCHE_AVAX: BigInt(5 * 10 ** 16), // 0.05 AVAX
  SONIC_S: BigInt(5 * 10 ** 17), // 0.5 S
  ETH_FOR_BRIDGES: BigInt(2 * 10 ** 15), // 0.002 ETH
} as const;

export const COMMON_ABIS = {
  ERC20: [
    {
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
    {
      name: 'transfer',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ name: '', type: 'bool' }],
    },
    {
      name: 'approve',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ name: '', type: 'bool' }],
    },
    {
      name: 'allowance',
      type: 'function',
      stateMutability: 'view',
      inputs: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
      ],
      outputs: [{ name: '', type: 'uint256' }],
    },
    {
      name: 'decimals',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint8' }],
    },
    {
      name: 'symbol',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'string' }],
    },
  ],
  UNISWAP_V3_POOL: [
    {
      name: 'slot0',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: 'sqrtPriceX96', type: 'uint160' },
        { name: 'tick', type: 'int24' },
        { name: 'observationIndex', type: 'uint16' },
        { name: 'observationCardinality', type: 'uint16' },
        { name: 'observationCardinalityNext', type: 'uint16' },
        { name: 'feeProtocol', type: 'uint8' },
        { name: 'unlocked', type: 'bool' },
      ],
    },
    {
      name: 'liquidity',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint128' }],
    },
    {
      name: 'token0',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
    {
      name: 'token1',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
    {
      name: 'fee',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint24' }],
    },
  ],
  MAGPIE_ROUTER: [
    {
      name: 'swapWithUserSignature',
      type: 'function',
      inputs: [{ name: '', type: 'bytes' }],
      outputs: [{ name: 'amountOut', type: 'uint256' }],
      stateMutability: 'payable',
    },
    {
      name: 'estimateSwapGas',
      type: 'function',
      inputs: [{ name: '', type: 'bytes' }],
      outputs: [
        { name: 'amountOut', type: 'uint256' },
        { name: 'gasUsed', type: 'uint256' },
      ],
      stateMutability: 'payable',
    },
  ],
} as const;
