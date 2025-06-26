import { PublicClient, WalletClient, Address, Hash, Account } from 'viem';
import { BridgeQuote, BridgeError } from '../../types';
import { TIME_CONSTANTS, TOKEN_DECIMALS, BRIDGE_CONFIG, COMMON_ABIS } from '../../config/constants';
import { Logger } from '../../utils/logger';
import { retryAsync } from '../../utils/helper';
import { ArbitrageCalculator } from '../../utils/calculations';

interface DeBridgeQuoteRequest {
  srcChainId: number;
  srcChainTokenIn: string;
  srcChainTokenInAmount: string;
  dstChainId: number;
  dstChainTokenOut: string;
  prependOperatingExpenses?: boolean;
  affiliateFeePercent?: string;
  bridgeSlippage?: string;
}

interface DeBridgeQuoteResponse {
  estimation: {
    srcChainTokenIn: {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      amount: string;
    };
    srcChainTokenOut: {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      amount: string;
      maxTheoreticalAmount: string;
    };
    dstChainTokenOut: {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      amount: string;
      recommendedAmount: string;
      maxTheoreticalAmount: string;
    };
    costsDetails: Array<{
      chain: string;
      tokenIn: {
        address: string;
        symbol: string;
        amount: string;
      };
    }>;
  };
  tx: {
    to: string;
    data: string;
    value: string;
    gasPrice?: string;
    gasLimit?: string;
  };
  orderId?: string;
}

interface DeBridgeOrderStatus {
  orderId: string;
  status:
    | 'Created'
    | 'Fulfilled'
    | 'SentUnlock'
    | 'OrderCompleted'
    | 'ClaimCompleted'
    | 'Cancelled';
  srcChainId: number;
  dstChainId: number;
  srcTransactionHash: string;
  dstTransactionHash?: string;
  claimTransactionHash?: string;
}

export class DeBridgeService {
  private readonly apiUrl: string;
  private readonly fixedFee: bigint;

  constructor(
    private readonly avalancheClient: { public: PublicClient; wallet: WalletClient },
    private readonly sonicClient: { public: PublicClient; wallet: WalletClient }
  ) {
    this.apiUrl = process.env.DEBRIDGE_API_URL!;
    this.fixedFee = BRIDGE_CONFIG.DEBRIDGE.fixedFee;

    Logger.debug('DeBridgeService initialized', {
      apiUrl: this.apiUrl,
      fixedFee: (Number(this.fixedFee) / 1e18).toFixed(6) + ' ETH',
      supportedTokens: BRIDGE_CONFIG.DEBRIDGE.supportedTokens,
    });
  }

  // Get bridge quote using DeBridge API
  async getQuote(
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    tokenSymbol?: 'USDC' | 'USDT'
  ): Promise<BridgeQuote> {
    try {
      const token = tokenSymbol ?? 'USDT';
      const tokenAddresses = this.getTokenAddresses();

      const fromToken = this.getTokenAddress(fromChainId, token, tokenAddresses);
      const toToken = this.getTokenAddress(toChainId, token, tokenAddresses);

      Logger.debug('Requesting DeBridge quote', {
        fromChain: this.getNetworkName(fromChainId),
        toChain: this.getNetworkName(toChainId),
        token,
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[token], token),
      });

      // Build DeBridge quote request
      const quoteRequest: DeBridgeQuoteRequest = {
        srcChainId: this.getDeBridgeChainId(fromChainId),
        srcChainTokenIn: fromToken,
        srcChainTokenInAmount: amount.toString(),
        dstChainId: this.getDeBridgeChainId(toChainId),
        dstChainTokenOut: toToken,
        prependOperatingExpenses: false,
        bridgeSlippage: '50', // 0.5% slippage in basis points
      };

      const response = await retryAsync(async () => {
        const res = await fetch(`${this.apiUrl}/dln/order/quote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'CrossChainArbitrage/1.0',
          },
          body: JSON.stringify(quoteRequest),
        });

        if (!res.ok) {
          const errorText = await res.text();
          Logger.error('DeBridge API error', {
            status: res.status,
            statusText: res.statusText,
            error: errorText,
          });
          throw new Error(`DeBridge API error: ${res.status} - ${errorText}`);
        }

        return res.json() as Promise<DeBridgeQuoteResponse>;
      });

      // Parse response and create bridge quote
      const estimatedOutput = BigInt(response.estimation.dstChainTokenOut.amount);

      // Calculate total costs (DeBridge fees + gas costs)
      const bridgeFee = this.calculateBridgeFee(response.estimation.costsDetails);
      const estimatedCost = bridgeFee + this.fixedFee;

      const bridgeQuote: BridgeQuote = {
        fromToken,
        toToken,
        fromNetwork: this.getNetworkName(fromChainId),
        toNetwork: this.getNetworkName(toChainId),
        amount,
        estimatedOutput,
        estimatedCost,
        estimatedTime: 180, // 3 minutes average for DeBridge
        bridgeProvider: 'debridge',
        slippage: 0.5, // 0.5% typical slippage
      };

      Logger.bridge('DeBridge quote received successfully', {
        token,
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[token], token),
        estimatedOutput: ArbitrageCalculator.formatAmount(
          estimatedOutput,
          TOKEN_DECIMALS[token],
          token
        ),
        estimatedCost: (Number(estimatedCost) / 1e18).toFixed(6) + ' ETH',
        estimatedTime: '3 minutes',
      });

      return bridgeQuote;
    } catch (error) {
      Logger.error('Failed to get DeBridge quote', error);
      throw new BridgeError('Failed to get DeBridge quote', {
        fromChainId,
        toChainId,
        amount: amount.toString(),
        tokenSymbol: tokenSymbol ?? 'USDT',
        error,
      });
    }
  }

  // Execute bridge transaction using DeBridge
  async executeBridge(
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    recipient?: string,
    maxSlippage?: number,
    tokenSymbol?: 'USDC' | 'USDT'
  ): Promise<{
    txHash: Hash;
    orderId: string;
    estimatedOutput: bigint;
    tokenUsed: 'USDC' | 'USDT';
  }> {
    try {
      const token = tokenSymbol ?? 'USDT';
      const actualRecipient = recipient ?? this.getAccountAddress();

      // Get transaction data from DeBridge API
      const tokenAddresses = this.getTokenAddresses();
      const fromToken = this.getTokenAddress(fromChainId, token, tokenAddresses);
      const toToken = this.getTokenAddress(toChainId, token, tokenAddresses);

      // Build order request
      const quoteRequest: DeBridgeQuoteRequest = {
        srcChainId: this.getDeBridgeChainId(fromChainId),
        srcChainTokenIn: fromToken,
        srcChainTokenInAmount: amount.toString(),
        dstChainId: this.getDeBridgeChainId(toChainId),
        dstChainTokenOut: toToken,
        prependOperatingExpenses: false,
        bridgeSlippage: maxSlippage ? (maxSlippage * 10000).toString() : '50',
      };

      const response = await retryAsync(async () => {
        const res = await fetch(`${this.apiUrl}/dln/order/create-tx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'CrossChainArbitrage/1.0',
          },
          body: JSON.stringify({
            ...quoteRequest,
            senderAddress: actualRecipient,
            receiverAddress: actualRecipient,
          }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`DeBridge API error: ${res.status} - ${errorText}`);
        }

        return res.json() as Promise<DeBridgeQuoteResponse>;
      });

      // Select appropriate client
      const client = fromChainId === 43114 ? this.avalancheClient : this.sonicClient;

      // Ensure token approval for DeBridge contract
      await this.ensureTokenApproval(fromToken, response.tx.to as Address, amount, client, token);

      Logger.bridge('Executing DeBridge transaction', {
        token,
        fromChain: this.getNetworkName(fromChainId),
        toChain: this.getNetworkName(toChainId),
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[token], token),
        to: response.tx.to,
        estimatedOutput: ArbitrageCalculator.formatAmount(
          BigInt(response.estimation.dstChainTokenOut.amount),
          TOKEN_DECIMALS[token],
          token
        ),
      });

      // Execute transaction using DeBridge transaction data
      const txHash = await client.wallet.sendTransaction({
        to: response.tx.to as Address,
        data: response.tx.data as `0x${string}`,
        value: BigInt(response.tx.value || '0'),
        gas: response.tx.gasLimit ? BigInt(response.tx.gasLimit) : undefined,
        gasPrice: response.tx.gasPrice ? BigInt(response.tx.gasPrice) : undefined,
        account: client.wallet.account as Account,
        chain: client.public.chain,
      });

      Logger.transaction(
        txHash,
        this.getNetworkName(fromChainId),
        `DeBridge ${token} bridge initiated`
      );

      return {
        txHash,
        orderId: response.orderId ?? `debridge_${Date.now()}`,
        estimatedOutput: BigInt(response.estimation.dstChainTokenOut.amount),
        tokenUsed: token,
      };
    } catch (error) {
      Logger.error('Failed to execute DeBridge transaction', error);
      throw new BridgeError('Failed to execute DeBridge transaction', {
        fromChainId,
        toChainId,
        amount: amount.toString(),
        tokenSymbol: tokenSymbol ?? 'USDT',
        error,
      });
    }
  }

  // Monitor bridge transaction status
  async monitorBridgeTransaction(
    orderId: string,
    timeoutMs: number = TIME_CONSTANTS.BRIDGE_TIMEOUT
  ): Promise<any> {
    const startTime = Date.now();
    const pollInterval = 15000; // 15 seconds for DeBridge

    Logger.bridge('Monitoring DeBridge transaction', {
      orderId,
      timeoutMs,
      expectedDuration: '1-5 minutes',
    });

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check order status via DeBridge API
        const statusResponse = await fetch(`${this.apiUrl}/dln/order/${orderId}`, {
          method: 'GET',
          headers: {
            'User-Agent': 'CrossChainArbitrage/1.0',
          },
        });

        if (statusResponse.ok) {
          const orderStatus: DeBridgeOrderStatus = await statusResponse.json();

          Logger.debug('DeBridge order status check', {
            orderId,
            status: orderStatus.status,
            srcTxHash: orderStatus.srcTransactionHash,
            dstTxHash: orderStatus.dstTransactionHash,
            elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
          });

          // Check if order is completed
          if (orderStatus.status === 'OrderCompleted' || orderStatus.status === 'ClaimCompleted') {
            Logger.success('DeBridge order completed', {
              orderId,
              status: orderStatus.status,
              srcTxHash: orderStatus.srcTransactionHash,
              dstTxHash: orderStatus.dstTransactionHash,
              totalTime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
            });

            return {
              status: 'completed',
              provider: 'debridge',
              srcTxHash: orderStatus.srcTransactionHash,
              dstTxHash: orderStatus.dstTransactionHash,
            };
          }

          // Check for failed states
          if (orderStatus.status === 'Cancelled') {
            throw new Error(`DeBridge order cancelled: ${orderId}`);
          }
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        Logger.warn('Error checking DeBridge order status', { orderId, error });
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new BridgeError('DeBridge order monitoring timeout', {
      orderId,
      timeoutMs,
      elapsed: Date.now() - startTime,
    });
  }

  // Ensure sufficient token approval
  private async ensureTokenApproval(
    tokenAddress: string,
    spender: string,
    amount: bigint,
    client: { public: PublicClient; wallet: WalletClient },
    tokenSymbol: 'USDC' | 'USDT'
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
        Logger.debug('Token approval sufficient for DeBridge', {
          token: tokenSymbol,
          tokenAddress,
          spender,
          allowance: ArbitrageCalculator.formatAmount(
            allowance,
            TOKEN_DECIMALS[tokenSymbol],
            tokenSymbol
          ),
          required: ArbitrageCalculator.formatAmount(
            amount,
            TOKEN_DECIMALS[tokenSymbol],
            tokenSymbol
          ),
        });
        return;
      }

      Logger.info('Approving token for DeBridge', {
        token: tokenSymbol,
        tokenAddress,
        spender,
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[tokenSymbol], tokenSymbol),
      });

      // Approve tokens with buffer for efficiency
      const approveAmount = amount * BigInt(2);
      const approveTxHash = await client.wallet.writeContract({
        address: tokenAddress as Address,
        abi: COMMON_ABIS.ERC20,
        functionName: 'approve',
        args: [spender as Address, approveAmount],
        account: client.wallet.account as Account,
        chain: client.public.chain,
      });

      // Wait for approval confirmation
      await client.public.waitForTransactionReceipt({
        hash: approveTxHash,
      });

      Logger.success('Token approval confirmed for DeBridge', {
        txHash: approveTxHash,
        token: tokenSymbol,
        tokenAddress,
        approvedAmount: ArbitrageCalculator.formatAmount(
          approveAmount,
          TOKEN_DECIMALS[tokenSymbol],
          tokenSymbol
        ),
      });
    } catch (error) {
      throw new BridgeError('Failed to approve token for DeBridge', {
        tokenAddress,
        tokenSymbol,
        spender,
        amount: amount.toString(),
        error,
      });
    }
  }

  // Calculate bridge fees from cost details
  private calculateBridgeFee(
    costsDetails: Array<{
      chain: string;
      tokenIn: {
        address: string;
        symbol: string;
        amount: string;
      };
    }>
  ): bigint {
    try {
      let totalFee = BigInt(0);

      for (const cost of costsDetails) {
        // Convert fee amount to wei (assuming it's in native token)
        const feeAmount = BigInt(cost.tokenIn.amount);
        totalFee += feeAmount;
      }

      return totalFee;
    } catch (error) {
      Logger.warn('Failed to calculate bridge fee from details, using default', { error });
      return this.fixedFee;
    }
  }

  // Check if bridge route is available
  async isRouteAvailable(
    fromChainId: number,
    toChainId: number,
    tokenSymbol: 'USDC' | 'USDT' = 'USDT'
  ): Promise<boolean> {
    try {
      // DeBridge supports most major chains, but let's check if the tokens exist
      const tokenAddresses = this.getTokenAddresses();
      const fromToken = this.getTokenAddress(fromChainId, tokenSymbol, tokenAddresses);
      const toToken = this.getTokenAddress(toChainId, tokenSymbol, tokenAddresses);

      if (!fromToken || !toToken || fromToken === '0x' || toToken === '0x') {
        Logger.debug('DeBridge route not available - invalid token addresses', {
          fromChainId,
          toChainId,
          tokenSymbol,
          fromToken,
          toToken,
        });
        return false;
      }

      // Try to get a small quote to test availability
      try {
        await this.getQuote(fromChainId, toChainId, BigInt(1000000), tokenSymbol);
        return true;
      } catch (error) {
        Logger.debug('DeBridge route test failed', {
          fromChainId,
          toChainId,
          tokenSymbol,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return false;
      }
    } catch (error) {
      Logger.warn('DeBridge route availability check failed', {
        fromChainId,
        toChainId,
        tokenSymbol,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  // Estimate bridge fees
  async estimateBridgeFee(
    fromChainId: number,
    toChainId: number,
    amount: bigint,
    tokenSymbol: 'USDC' | 'USDT' = 'USDT'
  ): Promise<bigint> {
    try {
      const quote = await this.getQuote(fromChainId, toChainId, amount, tokenSymbol);
      return quote.estimatedCost;
    } catch (error) {
      Logger.warn('Failed to get precise DeBridge fee, using estimate', {
        tokenSymbol,
        error,
      });
      // Return conservative estimate
      return this.fixedFee;
    }
  }

  // Helper methods
  private getAccountAddress(): string {
    return this.avalancheClient.wallet.account?.address ?? this.sonicClient.wallet.account!.address;
  }

  private getTokenAddresses(): any {
    return {
      avalanche: {
        usdc: process.env.AVALANCHE_USDC!,
        usdt: process.env.AVALANCHE_USDT!,
      },
      sonic: {
        usdc: process.env.SONIC_USDC!,
        usdt: process.env.SONIC_USDT!,
      },
    };
  }

  private getTokenAddress(
    chainId: number,
    tokenSymbol: 'USDC' | 'USDT',
    tokenAddresses: any
  ): string {
    const network = chainId === 43114 ? 'avalanche' : 'sonic';
    const token = tokenSymbol.toLowerCase();
    const address = tokenAddresses[network][token];
    if (!address) {
      throw new Error(`${tokenSymbol} address not found for ${network} (chainId: ${chainId})`);
    }
    return address;
  }

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

  private getDeBridgeChainId(standardChainId: number): number {
    // DeBridge uses standard chain IDs for most networks
    // But some networks might have different mappings
    switch (standardChainId) {
      case 43114:
        return 43114; // Avalanche
      case 146:
        return 146; // Sonic (might need adjustment)
      default:
        return standardChainId;
    }
  }

  // Get supported tokens and stats
  getSupportedTokens(): ('USDC' | 'USDT')[] {
    return ['USDC', 'USDT']; // DeBridge supports both
  }

  isTokenSupported(tokenSymbol: string): boolean {
    return ['USDC', 'USDT'].includes(tokenSymbol);
  }

  async getBridgeStats(): Promise<{
    supportedTokens: string[];
    supportedNetworks: string[];
    averageTime: number;
    estimatedFee: string;
    advantages: string[];
  }> {
    return {
      supportedTokens: ['USDC', 'USDT', 'ETH', 'WBTC', 'DAI'],
      supportedNetworks: ['Avalanche', 'Sonic', 'Ethereum', 'Polygon', 'BSC', 'Arbitrum'],
      averageTime: 180, // 3 minutes
      estimatedFee: '0.001 ETH + gas fees',
      advantages: [
        'Low fixed fees (0.001 ETH)',
        'Fast execution (1-5 minutes)',
        'Supports USDT natively',
        'High liquidity and reliability',
        'Decentralized infrastructure',
        'Multi-chain support (40+ networks)',
        'Battle-tested with $2B+ volume',
        'Optimal for stablecoin transfers',
      ],
    };
  }
}
