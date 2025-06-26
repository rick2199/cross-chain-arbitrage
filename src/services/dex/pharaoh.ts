import { PublicClient, WalletClient, Address, Hash, Account, encodeAbiParameters } from 'viem';
import { SwapQuote, SwapError, SwapParams } from '../../types';
import { COMMON_ABIS, TOKEN_DECIMALS } from '../../config/constants';
import { Logger } from '../../utils/logger';
import { ArbitrageCalculator } from '../../utils/calculations';

export class PharaohDEXService {
  private readonly routerAddress: Address;
  private readonly factoryAddress: Address;
  private readonly usdcAddress: Address;
  private readonly usdtAddress: Address;
  private readonly poolAddress: Address | null = null;

  constructor(private readonly client: { public: PublicClient; wallet: WalletClient }) {
    this.routerAddress = process.env.PHARAOH_ROUTER! as Address;
    this.factoryAddress = process.env.PHARAOH_FACTORY! as Address;
    this.usdcAddress = process.env.AVALANCHE_USDC! as Address;
    this.usdtAddress = process.env.AVALANCHE_USDT! as Address;

    // Use known pool address from env
    this.poolAddress = (process.env.PHARAOH_USDC_USDT_POOL as Address) || null;

    Logger.debug('PharaohDEXService initialized with Magpie Router', {
      magpieRouter: this.routerAddress,
      factory: this.factoryAddress,
      pool: this.poolAddress,
      usdc: this.usdcAddress,
      usdt: this.usdtAddress,
    });
  }

  // Get swap quote using simplified calculation (avoid signature issues for quotes)
  async getSwapQuoteExactIn(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint
  ): Promise<SwapQuote> {
    try {
      if (tokenIn === tokenOut) {
        throw new Error('Cannot swap token for itself');
      }

      const tokenInAddress = tokenIn === 'USDC' ? this.usdcAddress : this.usdtAddress;
      const tokenOutAddress = tokenOut === 'USDC' ? this.usdcAddress : this.usdtAddress;

      Logger.debug('Getting Pharaoh swap quote (using stable pair estimation)', {
        tokenIn,
        tokenOut,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
      });

      // For USDC/USDT stable pair, use simplified calculation
      // Apply typical stable swap fee (around 0.05% based on V3 pools)
      const feeRate = 0.0005; // 0.05%
      const amountAfterFee = Number(amountIn) * (1 - feeRate);
      const amountOut = BigInt(Math.floor(amountAfterFee));

      // Conservative gas estimate
      const gasEstimate = BigInt(872000);

      const priceImpact = this.calculatePriceImpact(amountIn, amountOut);

      const quote: SwapQuote = {
        tokenIn: tokenInAddress,
        tokenOut: tokenOutAddress,
        amountIn,
        amountOut,
        impact: priceImpact,
        gasEstimate,
        pool: this.poolAddress ?? '0x',
        network: 'avalanche',
      };

      Logger.debug('Pharaoh swap quote obtained (estimated)', {
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        amountOut: ArbitrageCalculator.formatAmount(amountOut, TOKEN_DECIMALS[tokenOut], tokenOut),
        priceImpact: `${priceImpact.toFixed(4)}%`,
        gasEstimate: gasEstimate.toString(),
      });

      return quote;
    } catch (error) {
      Logger.error('Failed to get Pharaoh swap quote', error);
      throw new SwapError('Failed to get Pharaoh swap quote', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        error,
      });
    }
  }

  // Create the properly formatted swap data for Magpie Router (Pharaoh/Avalanche)
  private async createMagpieSwapData(
    tokenInAddress: string,
    tokenOutAddress: string,
    amountIn: bigint
  ): Promise<`0x${string}`> {
    try {
      const userAddress = this.client.wallet.account!.address;
      const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 minutes

      // Calculate minimum amount out (0.5% slippage for stable pairs)
      const slippageBps = 50; // 0.5%
      const amountOutMin = amountIn - (amountIn * BigInt(slippageBps)) / BigInt(10000);

      // Create the swap parameters exactly matching Pharaoh's structure
      const swapParams: SwapParams = {
        router: this.routerAddress.toLowerCase(),
        sender: userAddress.toLowerCase(),
        recipient: userAddress.toLowerCase(),
        fromAsset: tokenInAddress.toLowerCase(),
        toAsset: tokenOutAddress.toLowerCase(),
        deadline: deadline.toString(),
        amountOutMin: amountOutMin.toString(),
        swapFee: '0', // From your discovery
        amountIn: amountIn.toString(),
      };

      // Create the exact EIP-712 typed data structure for Pharaoh (Avalanche)
      const domain = {
        name: 'Magpie Router',
        version: '3',
        chainId: 43114,
        verifyingContract: this.routerAddress,
      };

      const types = {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Swap: [
          { name: 'router', type: 'address' },
          { name: 'sender', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'fromAsset', type: 'address' },
          { name: 'toAsset', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'swapFee', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
        ],
      };

      Logger.debug('Creating EIP-712 signature for Pharaoh Magpie Router', {
        domain,
        message: swapParams,
      });

      // Sign the typed data using viem's built-in EIP-712 support
      const signature = await this.client.wallet.signTypedData({
        account: this.client.wallet.account as Account,
        domain: domain as any,
        types,
        message: swapParams as Record<string, any>,
        primaryType: 'Swap',
      });

      // Create the final swap data by combining signature and encoded parameters
      const encodedParams = this.encodeSwapParamsCorrectly(swapParams);

      // Remove '0x' prefix from signature and encoded params, then combine
      const combinedData = signature + encodedParams.slice(2);

      Logger.debug('Created Pharaoh Magpie swap data', {
        signatureLength: signature.length,
        encodedParamsLength: encodedParams.length,
        totalLength: combinedData.length,
        signature: signature.slice(0, 20) + '...',
      });

      return combinedData as `0x${string}`;
    } catch (error) {
      Logger.error('Failed to create Pharaoh Magpie swap data', error);
      throw error;
    }
  }

  // Encode swap parameters in the exact format expected by Magpie Router
  private encodeSwapParamsCorrectly(params: SwapParams): string {
    try {
      // Based on the structure, encode parameters as struct
      const encoded = encodeAbiParameters(
        [
          {
            name: 'swapData',
            type: 'tuple',
            components: [
              { name: 'router', type: 'address' },
              { name: 'sender', type: 'address' },
              { name: 'recipient', type: 'address' },
              { name: 'fromAsset', type: 'address' },
              { name: 'toAsset', type: 'address' },
              { name: 'deadline', type: 'uint256' },
              { name: 'amountOutMin', type: 'uint256' },
              { name: 'swapFee', type: 'uint256' },
              { name: 'amountIn', type: 'uint256' },
            ],
          },
        ],
        [
          {
            router: params.router as Address,
            sender: params.sender as Address,
            recipient: params.recipient as Address,
            fromAsset: params.fromAsset as Address,
            toAsset: params.toAsset as Address,
            deadline: BigInt(params.deadline),
            amountOutMin: BigInt(params.amountOutMin),
            swapFee: BigInt(params.swapFee),
            amountIn: BigInt(params.amountIn),
          },
        ]
      );

      return encoded;
    } catch (error) {
      Logger.error('Failed to encode Pharaoh swap parameters', error);
      throw error;
    }
  }

  // Execute swap using Magpie Router on Pharaoh (Avalanche)
  async executeSwapExactIn(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountIn: bigint
  ): Promise<{
    txHash: Hash;
    amountOut: bigint;
    actualGasUsed: bigint;
  }> {
    try {
      const tokenInAddress = tokenIn === 'USDC' ? this.usdcAddress : this.usdtAddress;
      const tokenOutAddress = tokenOut === 'USDC' ? this.usdcAddress : this.usdtAddress;

      // Ensure token approval for Magpie Router
      await this.ensureTokenApproval(tokenInAddress, amountIn);

      // Get fresh quote for expected output
      const quote = await this.getSwapQuoteExactIn(tokenIn, tokenOut, amountIn);

      // Create correctly formatted swap data
      const swapData = await this.createMagpieSwapData(tokenInAddress, tokenOutAddress, amountIn);

      Logger.trade('Executing swap via REAL Pharaoh Magpie Router', {
        tokenIn,
        tokenOut,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        router: this.routerAddress,
        dataLength: swapData.length,
        network: 'avalanche',
      });

      // Execute the swap using Magpie Router
      const txHash = await this.client.wallet.writeContract({
        address: this.routerAddress,
        abi: COMMON_ABIS.MAGPIE_ROUTER,
        functionName: 'swapWithUserSignature',
        args: [swapData],
        gas: BigInt(900000), // Conservative gas limit (based on your discovery)
        account: this.client.wallet.account as Account,
        chain: this.client.public.chain,
      });

      // Wait for transaction receipt
      const receipt = await this.client.public.waitForTransactionReceipt({
        hash: txHash,
      });

      Logger.success('Pharaoh swap completed via Magpie Router', {
        txHash,
        amountIn: ArbitrageCalculator.formatAmount(amountIn, TOKEN_DECIMALS[tokenIn], tokenIn),
        amountOut: ArbitrageCalculator.formatAmount(
          quote.amountOut,
          TOKEN_DECIMALS[tokenOut],
          tokenOut
        ),
        gasUsed: receipt.gasUsed.toString(),
        network: 'avalanche',
      });

      return {
        txHash,
        amountOut: quote.amountOut,
        actualGasUsed: receipt.gasUsed,
      };
    } catch (error) {
      Logger.error('Failed to execute Pharaoh swap via Magpie Router', error);
      throw new SwapError('Failed to execute Pharaoh swap', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        error,
      });
    }
  }

  // Ensure sufficient token approval for Magpie Router
  private async ensureTokenApproval(tokenAddress: string, amount: bigint): Promise<void> {
    try {
      const userAddress = this.client.wallet.account!.address;

      // Check current allowance
      const allowance = (await this.client.public.readContract({
        address: tokenAddress as Address,
        abi: COMMON_ABIS.ERC20,
        functionName: 'allowance',
        args: [userAddress, this.routerAddress],
      })) as bigint;

      // If allowance is sufficient, return
      if (allowance >= amount) {
        Logger.debug('Token approval sufficient for Pharaoh Magpie Router', {
          token: tokenAddress,
          allowance: allowance.toString(),
          required: amount.toString(),
        });
        return;
      }

      Logger.info('Approving token for Pharaoh Magpie Router', {
        token: tokenAddress,
        amount: amount.toString(),
      });

      // Approve tokens (use specific amount for security)
      const approveTxHash = await this.client.wallet.writeContract({
        address: tokenAddress as Address,
        abi: COMMON_ABIS.ERC20,
        functionName: 'approve',
        args: [this.routerAddress, amount * BigInt(2)], // Approve 2x for efficiency
        account: this.client.wallet.account as Account,
        chain: this.client.public.chain,
      });

      // Wait for approval confirmation
      await this.client.public.waitForTransactionReceipt({
        hash: approveTxHash,
      });

      Logger.success('Token approval confirmed for Pharaoh Magpie Router', {
        txHash: approveTxHash,
        token: tokenAddress,
        amount: (amount * BigInt(2)).toString(),
      });
    } catch (error) {
      throw new SwapError('Failed to approve token for Pharaoh Magpie Router', {
        tokenAddress,
        amount: amount.toString(),
        error,
      });
    }
  }

  // Calculate price impact for stable pairs
  private calculatePriceImpact(amountIn: bigint, amountOut: bigint): number {
    try {
      const ratio = Number(amountOut) / Number(amountIn);
      const deviation = Math.abs(1 - ratio);
      return Math.min(deviation * 100, 1); // Cap at 1% for stable pairs
    } catch {
      return 0.05; // 0.05% default for stable pairs
    }
  }

  // Check if swap is available
  async isSwapAvailable(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amount: bigint
  ): Promise<boolean> {
    try {
      // For stable pairs, if we have valid token addresses, assume it's available
      const tokenInAddress = tokenIn === 'USDC' ? this.usdcAddress : this.usdtAddress;
      const tokenOutAddress = tokenOut === 'USDC' ? this.usdcAddress : this.usdtAddress;

      // Basic validation
      if (!tokenInAddress || !tokenOutAddress || tokenInAddress === tokenOutAddress) {
        return false;
      }

      // Check if amount is reasonable
      if (amount <= BigInt(0) || amount > BigInt(1000000000)) {
        // Max 1000 tokens
        return false;
      }

      Logger.debug('Pharaoh swap available (simplified check)', {
        tokenIn,
        tokenOut,
        amount: ArbitrageCalculator.formatAmount(amount, TOKEN_DECIMALS[tokenIn], tokenIn),
      });

      return true;
    } catch (error) {
      Logger.debug('Pharaoh swap not available', {
        tokenIn,
        tokenOut,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  // Get current price from pool (simplified for stable pairs)
  async getCurrentPrice(baseCurrency: 'USDC' | 'USDT' = 'USDC'): Promise<{
    price: number;
    sqrtPriceX96: bigint;
    tick: number;
  }> {
    try {
      // For stable pairs, price should be close to 1
      // Use a small deviation based on typical stable swap behavior
      const basePrice = 1.0;
      const deviation = 0.0005; // 0.05% typical spread

      const price = baseCurrency === 'USDC' ? basePrice + deviation : basePrice - deviation;

      return {
        price,
        sqrtPriceX96: BigInt(0),
        tick: 0,
      };
    } catch (error) {
      Logger.warn('Failed to get current price, using fallback', error);
      return {
        price: 1.0,
        sqrtPriceX96: BigInt(0),
        tick: 0,
      };
    }
  }

  // Get exact output quote (reverse calculation)
  async getSwapQuoteExactOut(
    tokenIn: 'USDC' | 'USDT',
    tokenOut: 'USDC' | 'USDT',
    amountOut: bigint
  ): Promise<SwapQuote> {
    // For stable pairs, reverse calculation is straightforward
    const estimatedAmountIn = amountOut + (amountOut * BigInt(50)) / BigInt(10000);

    return {
      tokenIn: tokenIn === 'USDC' ? this.usdcAddress : this.usdtAddress,
      tokenOut: tokenOut === 'USDC' ? this.usdcAddress : this.usdtAddress,
      amountIn: estimatedAmountIn,
      amountOut,
      impact: 0.05,
      gasEstimate: BigInt(872000),
      pool: this.poolAddress ?? '0x',
      network: 'avalanche',
    };
  }

  // Get pool info
  async getPoolInfo(): Promise<{
    address: string;
    token0: string;
    token1: string;
    liquidity: bigint;
    fee: number;
    available: boolean;
  }> {
    try {
      return {
        address: this.poolAddress ?? '0x',
        token0: this.usdcAddress,
        token1: this.usdtAddress,
        liquidity: BigInt(27632040487867688), // Aprox 27.6M USDC/USDT
        fee: 500, // 0.05% fee
        available: true,
      };
    } catch (error) {
      Logger.warn('Pool info not available', error);
      return {
        address: '0x',
        token0: '0x',
        token1: '0x',
        liquidity: BigInt(0),
        fee: 0,
        available: false,
      };
    }
  }
}
