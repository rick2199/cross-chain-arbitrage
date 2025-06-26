import { PublicClient, WalletClient, Address, Hash, encodeAbiParameters, Account } from 'viem';
import { BridgeQuote, BridgeError } from '../../types';
import { BRIDGE_CONFIG, COMMON_ABIS, TIME_CONSTANTS } from '../../config/constants';
import { Logger } from '../../utils/logger';
import { retryAsync } from '../../utils/helper';

// CCIP Router ABI (minimal required functions)
const CCIP_ROUTER_ABI = [
  {
    name: 'getFee',
    type: 'function',
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'feeToken', type: 'address' },
          { name: 'extraArgs', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'fee', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'ccipSend',
    type: 'function',
    inputs: [
      { name: 'destinationChainSelector', type: 'uint64' },
      {
        name: 'message',
        type: 'tuple',
        components: [
          { name: 'receiver', type: 'bytes' },
          { name: 'data', type: 'bytes' },
          {
            name: 'tokenAmounts',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'feeToken', type: 'address' },
          { name: 'extraArgs', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'messageId', type: 'bytes32' }],
    stateMutability: 'payable',
  },
  {
    name: 'isChainSupported',
    type: 'function',
    inputs: [{ name: 'chainSelector', type: 'uint64' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

interface CCIPMessage {
  receiver: `0x${string}`;
  data: `0x${string}`;
  tokenAmounts: readonly {
    token: Address;
    amount: bigint;
  }[];
  feeToken: Address;
  extraArgs: `0x${string}`;
}

// Chain selectors para CCIP
const CHAIN_SELECTORS = {
  avalanche: BigInt('6433500567565415381'),
  sonic: BigInt('1673871237479749969'),
} as const;

export class CCIPService {
  private readonly chainSelectors = CHAIN_SELECTORS;

  constructor(
    private readonly avalancheClient: { public: PublicClient; wallet: WalletClient },
    private readonly sonicClient: { public: PublicClient; wallet: WalletClient }
  ) {
    Logger.debug('CCIPService initialized');
  }

  // Get bridge quote for USDC transfer
  async getQuote(
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string
  ): Promise<BridgeQuote> {
    try {
      const fromNetwork = this.getNetworkName(fromChainId);
      const toNetwork = this.getNetworkName(toChainId);
      const fromSelector = this.getChainSelector(fromChainId);
      const toSelector = this.getChainSelector(toChainId);

      if (fromSelector === BigInt(0) || toSelector === BigInt(0)) {
        throw new Error('CCIP not yet supported for Sonic network');
      }

      const tokenAddresses = this.getTokenAddresses();
      const fromToken =
        fromChainId === 43114 ? tokenAddresses.avalanche.usdc : tokenAddresses.sonic.usdc;
      const toToken =
        toChainId === 43114 ? tokenAddresses.avalanche.usdc : tokenAddresses.sonic.usdc;

      const client = fromChainId === 43114 ? this.avalancheClient : this.sonicClient;
      const routerAddress = this.getRouterAddress(fromChainId);

      // Prepare CCIP message
      const message: CCIPMessage = {
        receiver: this.addressToBytes32(recipient ?? client.wallet.account!.address),
        data: '0x',
        tokenAmounts: [
          {
            token: fromToken as Address,
            amount,
          },
        ] as const,
        feeToken: '0x0000000000000000000000000000000000000000' as Address, // Native token for fees
        extraArgs: this.encodeExtraArgs(),
      };

      Logger.debug('Requesting CCIP quote', {
        fromChain: fromNetwork,
        toChain: toNetwork,
        amount: (Number(amount) / 1e6).toFixed(6) + ' USDC',
        recipient,
      });

      // Get fee estimate
      const fee = await retryAsync(async () => {
        return (await client.public.readContract({
          address: routerAddress,
          abi: CCIP_ROUTER_ABI,
          functionName: 'getFee',
          args: [toSelector, message as any],
        })) as bigint;
      });

      const bridgeQuote: BridgeQuote = {
        fromToken,
        toToken,
        fromNetwork,
        toNetwork,
        amount,
        estimatedOutput: amount, // 1:1 for USDC transfers
        estimatedCost: fee,
        estimatedTime: 900, // 15 minutes average for CCIP
        bridgeProvider: 'ccip',
        slippage: 0, // No slippage for CCIP
      };

      Logger.bridge('CCIP quote received', {
        amount: (Number(amount) / 1e6).toFixed(6) + ' USDC',
        estimatedOutput: (Number(bridgeQuote.estimatedOutput) / 1e6).toFixed(6) + ' USDC',
        estimatedCost: (Number(fee) / 1e18).toFixed(6) + ' ETH',
        estimatedTime: `${bridgeQuote.estimatedTime}s`,
      });

      return bridgeQuote;
    } catch (error) {
      Logger.error('Failed to get CCIP quote', error);
      throw new BridgeError('Failed to get CCIP quote', {
        fromChainId,
        toChainId,
        amount: amount.toString(),
        error,
      });
    }
  }

  // Execute CCIP bridge transaction
  async executeBridge(
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string
  ): Promise<{
    txHash: Hash;
    messageId: string;
    estimatedOutput: bigint;
  }> {
    try {
      const fromNetwork = this.getNetworkName(fromChainId);
      const toNetwork = this.getNetworkName(toChainId);
      const toSelector = this.getChainSelector(toChainId);

      if (toSelector === BigInt(0)) {
        throw new Error('CCIP not yet supported for Sonic network');
      }

      const client = fromChainId === 43114 ? this.avalancheClient : this.sonicClient;
      const routerAddress = this.getRouterAddress(fromChainId);
      const tokenAddress =
        fromChainId === 43114
          ? this.getTokenAddresses().avalanche.usdc
          : this.getTokenAddresses().sonic.usdc;

      const actualRecipient = recipient ?? client.wallet.account!.address;

      // Ensure token approval
      await this.ensureTokenApproval(tokenAddress, routerAddress, amount, client);

      // Prepare CCIP message
      const message: CCIPMessage = {
        receiver: this.addressToBytes32(actualRecipient),
        data: '0x',
        tokenAmounts: [
          {
            token: tokenAddress as Address,
            amount,
          },
        ] as const,
        feeToken: '0x0000000000000000000000000000000000000000' as Address,
        extraArgs: this.encodeExtraArgs(),
      };

      // Get current fee
      const fee = (await client.public.readContract({
        address: routerAddress,
        abi: CCIP_ROUTER_ABI,
        functionName: 'getFee',
        args: [toSelector, message as any],
      })) as bigint;

      Logger.bridge('Executing CCIP transaction', {
        fromChain: fromNetwork,
        toChain: toNetwork,
        amount: (Number(amount) / 1e6).toFixed(6) + ' USDC',
        recipient: actualRecipient,
        fee: (Number(fee) / 1e18).toFixed(6) + ' ETH',
      });

      // Execute CCIP send
      const txHash = await client.wallet.writeContract({
        address: routerAddress,
        abi: CCIP_ROUTER_ABI,
        functionName: 'ccipSend',
        args: [toSelector, message as any],
        value: fee,
        account: client.wallet.account as Account,
        chain: client.public.chain,
      });

      // Wait for transaction receipt to get message ID
      const receipt = await client.public.waitForTransactionReceipt({
        hash: txHash,
      });

      // Extract message ID from logs
      const messageId = receipt.logs[0]?.topics[1] ?? '0x';

      Logger.transaction(txHash, fromNetwork, 'CCIP message sent');
      Logger.bridge('CCIP message ID generated', { messageId });

      return {
        txHash,
        messageId: messageId as string,
        estimatedOutput: amount, // 1:1 for USDC
      };
    } catch (error) {
      Logger.error('Failed to execute CCIP transaction', error);
      throw new BridgeError('Failed to execute CCIP transaction', {
        fromChainId,
        toChainId,
        amount: amount.toString(),
        error,
      });
    }
  }

  // Monitor CCIP transaction status
  async monitorBridgeTransaction(
    messageId: string,
    toChainId: number,
    timeoutMs: number = TIME_CONSTANTS.BRIDGE_TIMEOUT
  ): Promise<{ status: 'completed'; txHash?: string }> {
    const startTime = Date.now();
    const pollInterval = 30000; // 30 seconds for CCIP
    const toClient = toChainId === 43114 ? this.avalancheClient : this.sonicClient;

    Logger.bridge('Monitoring CCIP message', { messageId, timeoutMs });

    while (Date.now() - startTime < timeoutMs) {
      try {
        // For now, we'll simulate monitoring by checking block progression
        // In a full implementation, we'd check CCIP's execution logs
        const currentBlock = await toClient.public.getBlockNumber();

        Logger.debug('CCIP message status check', {
          messageId,
          currentBlock: currentBlock.toString(),
          elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        });

        // Simplified completion check - in practice, we'd check actual CCIP logs
        // For now, assume completion after a reasonable time
        if (Date.now() - startTime > 600000) {
          // 10 minutes
          Logger.success('CCIP message assumed completed', {
            messageId,
            totalTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
          });

          return { status: 'completed' };
        }

        // Wait before next poll
        await new Promise(resolve => {
          setTimeout(resolve, pollInterval);
        });
      } catch (error) {
        Logger.warn('Error checking CCIP message status', { messageId, error });
        await new Promise(resolve => {
          setTimeout(resolve, pollInterval);
        });
      }
    }

    throw new BridgeError('CCIP message monitoring timeout', {
      messageId,
      timeoutMs,
      elapsed: Date.now() - startTime,
    });
  }

  // Ensure sufficient token approval for CCIP router
  private async ensureTokenApproval(
    tokenAddress: string,
    spender: string,
    amount: bigint,
    client: { public: PublicClient; wallet: WalletClient }
  ): Promise<void> {
    try {
      const userAddress = client.wallet.account!.address;

      // Check current allowance
      const allowance = (await client.public.readContract({
        address: tokenAddress as Address,
        abi: COMMON_ABIS.ERC20,
        functionName: 'allowance',
        args: [userAddress, spender as Address],
      })) as bigint;

      // If allowance is sufficient, return
      if (allowance >= amount) {
        Logger.debug('Token approval sufficient for CCIP', {
          token: tokenAddress,
          allowance: allowance.toString(),
          required: amount.toString(),
        });
        return;
      }

      Logger.info('Approving token for CCIP router', {
        token: tokenAddress,
        spender,
        amount: amount.toString(),
      });

      // Approve tokens
      const approveTxHash = await client.wallet.writeContract({
        address: tokenAddress as Address,
        abi: COMMON_ABIS.ERC20,
        functionName: 'approve',
        args: [spender as Address, amount],
        account: client.wallet.account as Account,
        chain: client.public.chain,
      });

      // Wait for approval confirmation
      await client.public.waitForTransactionReceipt({
        hash: approveTxHash,
      });

      Logger.success('Token approval confirmed for CCIP', {
        txHash: approveTxHash,
        token: tokenAddress,
        amount: amount.toString(),
      });
    } catch (error) {
      throw new BridgeError('Failed to approve token for CCIP', {
        tokenAddress,
        spender,
        amount: amount.toString(),
        error,
      });
    }
  }

  // Convert address to bytes32 format required by CCIP
  private addressToBytes32(address: string): `0x${string}` {
    // Remove 0x prefix and pad to 32 bytes
    const cleanAddress = address.replace('0x', '').toLowerCase();
    return `0x${'0'.repeat(24)}${cleanAddress}` as `0x${string}`;
  }

  // Encode extra arguments for CCIP message
  private encodeExtraArgs(): `0x${string}` {
    // Default extra args for basic token transfer
    return encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [BigInt(200000), false]);
  }

  // Get router address for given chain
  private getRouterAddress(chainId: number): Address {
    switch (chainId) {
      case 43114:
        return (process.env.CCIP_ROUTER_AVALANCHE ?? '0x') as Address;
      case 146:
        return (process.env.CCIP_ROUTER_SONIC ?? '0x') as Address;
      default:
        throw new Error(`No CCIP router configured for chain ${chainId}`);
    }
  }

  // Get chain selector for CCIP
  private getChainSelector(chainId: number): bigint {
    switch (chainId) {
      case 43114:
        return this.chainSelectors.avalanche;
      case 146:
        return this.chainSelectors.sonic;
      default:
        throw new Error(`No CCIP chain selector for chain ${chainId}`);
    }
  }

  // Get token addresses for different networks
  private getTokenAddresses() {
    return {
      avalanche: {
        usdc: process.env.AVALANCHE_USDC!,
      },
      sonic: {
        usdc: process.env.SONIC_USDC!,
      },
    };
  }

  // Convert chain ID to network name
  private getNetworkName(chainId: number): string {
    switch (chainId) {
      case 43114:
        return 'avalanche';
      case 146:
        return 'sonic';
      default:
        throw new Error(`Unsupported chain ID: ${chainId}`);
    }
  }

  // Estimate bridge fees
  async estimateBridgeFee(fromChainId: number, toChainId: number, amount: bigint): Promise<bigint> {
    try {
      const quote = await this.getQuote(fromChainId, toChainId, amount);
      return quote.estimatedCost;
    } catch (error) {
      Logger.warn('Failed to get precise CCIP fee, using estimate', { error });
      // Return conservative estimate (approximately $10 in ETH)
      return BigInt(3000000000000000); // 0.003 ETH
    }
  }

  // Check if CCIP route is available
  async isRouteAvailable(fromChainId: number, toChainId: number): Promise<boolean> {
    try {
      const fromClient = fromChainId === 43114 ? this.avalancheClient : this.sonicClient;
      const routerAddress = this.getRouterAddress(fromChainId);
      const toSelector = this.getChainSelector(toChainId);

      if (toSelector === BigInt(0)) {
        return false;
      }

      // Check if destination chain is supported
      const isSupported = (await fromClient.public.readContract({
        address: routerAddress,
        abi: CCIP_ROUTER_ABI,
        functionName: 'isChainSupported',
        args: [toSelector],
      })) as boolean;

      return isSupported;
    } catch (error) {
      Logger.warn('CCIP route availability check failed', { fromChainId, toChainId, error });
      return false;
    }
  }

  // Get supported tokens for CCIP - FIX para el tipo readonly
  getSupportedTokens(): readonly string[] {
    return BRIDGE_CONFIG.CCIP.supportedTokens;
  }

  // Check if token is supported by CCIP
  isTokenSupported(tokenSymbol: string): boolean {
    return this.getSupportedTokens().includes(tokenSymbol);
  }
}
