import dotenv from 'dotenv';
import { createPublicClient, createWalletClient, http, Chain } from 'viem';
import { avalanche } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { NetworkConfig } from '../types';
dotenv.config();

export const sonic: Chain = {
  id: 146,
  name: 'Sonic',
  nativeCurrency: {
    decimals: 18,
    name: 'Sonic',
    symbol: 'S',
  },
  rpcUrls: {
    default: {
      http: [process.env.SONIC_RPC_URL!],
    },
    public: {
      http: [process.env.SONIC_RPC_URL!],
    },
  },
  blockExplorers: {
    default: {
      name: 'SonicScan',
      url: 'https://sonicscan.org',
    },
  },
};

// Network configurations
export const NETWORKS: Record<string, NetworkConfig> = {
  avalanche: {
    chainId: 43114,
    name: 'Avalanche',
    rpcUrl: process.env.AVALANCHE_RPC_URL!,
    nativeCurrency: 'AVAX',
    blockExplorer: 'https://snowtrace.io',
    contracts: {
      usdc: process.env.AVALANCHE_USDC!,
      usdt: process.env.AVALANCHE_USDT!,
      dexPool: process.env.PHARAOH_USDC_USDT_POOL!,
      router: process.env.CCIP_ROUTER_AVALANCHE!,
      factory: process.env.PHARAOH_FACTORY!,
    },
  },
  sonic: {
    chainId: 146,
    name: 'Sonic',
    rpcUrl: process.env.SONIC_RPC_URL!,
    nativeCurrency: 'S',
    blockExplorer: 'https://sonicscan.org',
    contracts: {
      usdc: process.env.SONIC_USDC!,
      usdt: process.env.SONIC_USDT!,
      dexPool: process.env.SHADOW_USDC_USDT_POOL!,
      router: process.env.CCIP_ROUTER_SONIC!,
      factory: process.env.SHADOW_FACTORY!,
    },
  },
};
// Client factory
export const createClients: any = (): ReturnType<typeof createClients> => {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

  // Avalanche clients
  const avalanchePublic = createPublicClient({
    chain: avalanche,
    transport: http(NETWORKS.avalanche?.rpcUrl),
  });

  const avalancheWallet = createWalletClient({
    account,
    chain: avalanche,
    transport: http(NETWORKS.avalanche?.rpcUrl),
  });

  // Sonic clients
  const sonicPublic = createPublicClient({
    chain: sonic,
    transport: http(NETWORKS.sonic?.rpcUrl),
  });

  const sonicWallet = createWalletClient({
    account,
    chain: sonic,
    transport: http(NETWORKS.sonic?.rpcUrl),
  });

  return {
    avalanche: {
      public: avalanchePublic,
      wallet: avalancheWallet,
    },
    sonic: {
      public: sonicPublic,
      wallet: sonicWallet,
    },
    account,
  };
};

// Helper function to get network config
export const getNetworkConfig = (networkName: string): NetworkConfig => {
  const config = NETWORKS[networkName];
  if (!config) {
    throw new Error(`Network ${networkName} not found in configuration`);
  }
  return config;
};

// Helper function to get client for network
export const getClientForNetwork = (
  networkName: string,
  clients: ReturnType<typeof createClients>
): ReturnType<typeof createClients>['avalanche'] | ReturnType<typeof createClients>['sonic'] => {
  switch (networkName) {
    case 'avalanche':
      return clients.avalanche;
    case 'sonic':
      return clients.sonic;
    default:
      throw new Error(`No client available for network: ${networkName}`);
  }
};
