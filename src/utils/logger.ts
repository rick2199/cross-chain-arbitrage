export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export class Logger {
  private static logLevel: LogLevel = LogLevel.INFO;
  private static readonly colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
  };

  static setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  private static formatTimestamp(): string {
    return new Date().toISOString();
  }

  private static formatMessage(level: string, message: string, data?: any): string {
    const timestamp = this.formatTimestamp();
    let dataStr = '';

    if (data) {
      try {
        // Use custom replacer function to handle BigInt
        dataStr = ` ${JSON.stringify(
          data,
          (_, value) => {
            if (typeof value === 'bigint') {
              return value.toString();
            }
            return value;
          },
          2
        )}`;
      } catch (error) {
        dataStr = ` [Error serializing data: ${error}]`;
      }
    }

    return `[${timestamp}] ${level}: ${message}${dataStr}`;
  }

  private static colorize(color: keyof typeof Logger.colors, text: string): string {
    return `${this.colors[color]}${text}${this.colors.reset}`;
  }

  static error(message: string, error?: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      const formattedMessage = this.formatMessage('ERROR', message, error);
      console.error(this.colorize('red', formattedMessage));
    }
  }

  static warn(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      const formattedMessage = this.formatMessage('WARN', message, data);
      console.warn(this.colorize('yellow', formattedMessage));
    }
  }

  static info(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('INFO', message, data);
      console.log(this.colorize('blue', formattedMessage));
    }
  }

  static debug(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      const formattedMessage = this.formatMessage('DEBUG', message, data);
      console.log(this.colorize('cyan', formattedMessage));
    }
  }

  static success(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('SUCCESS', message, data);
      console.log(this.colorize('green', formattedMessage));
    }
  }

  static arbitrage(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('🔄 ARBITRAGE', message, data);
      console.log(this.colorize('magenta', formattedMessage));
    }
  }

  static price(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('💰 PRICE', message, data);
      console.log(this.colorize('cyan', formattedMessage));
    }
  }

  static bridge(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('🌉 BRIDGE', message, data);
      console.log(this.colorize('yellow', formattedMessage));
    }
  }

  static trade(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      const formattedMessage = this.formatMessage('📈 TRADE', message, data);
      console.log(this.colorize('green', formattedMessage));
    }
  }

  // Utility method for performance timing
  static time(label: string): void {
    console.time(this.colorize('white', `⏱️  ${label}`));
  }

  static timeEnd(label: string): void {
    console.timeEnd(this.colorize('white', `⏱️  ${label}`));
  }

  // Method to log wallet address with privacy
  static wallet(address: string, message?: string): void {
    const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
    const logMessage = message ? `${message} (${shortAddress})` : shortAddress;
    this.info(`💳 Wallet: ${logMessage}`);
  }

  // Method to log transaction hashes
  static transaction(hash: string, network: string, message?: string): void {
    const shortHash = `${hash.slice(0, 10)}...${hash.slice(-8)}`;
    const logMessage = message ? `${message}` : 'Transaction';
    this.info(`📝 ${logMessage}: ${shortHash} on ${network}`);
  }

  // Method to log amounts with proper formatting
  static amount(token: string, amount: bigint, decimals: number, message?: string): void {
    const formattedAmount = (Number(amount) / 10 ** decimals).toFixed(6);
    const logMessage = message ? `${message}:` : 'Amount:';
    this.info(`💵 ${logMessage} ${formattedAmount} ${token}`);
  }

  // Method to log gas usage
  static gas(gasUsed: bigint, gasPrice: bigint, network: string): void {
    const gasCost = gasUsed * gasPrice;
    const gasCostEth = Number(gasCost) / 10 ** 18;
    this.info(
      `⛽ Gas used: ${gasUsed.toString()} units, Cost: ${gasCostEth.toFixed(6)} ETH (${network})`
    );
  }

  // Method to log opportunities
  static opportunity(profit: bigint, percentage: number, direction: string): void {
    const profitUsd = Number(profit) / 10 ** 6; // Assuming USDC
    this.arbitrage(
      `Opportunity found: $${profitUsd.toFixed(4)} (${percentage.toFixed(2)}%) - ${direction}`
    );
  }

  // Initialize logger with environment configuration
  static init(): void {
    const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();

    switch (envLogLevel) {
      case 'error':
        this.setLogLevel(LogLevel.ERROR);
        break;
      case 'warn':
        this.setLogLevel(LogLevel.WARN);
        break;
      case 'info':
        this.setLogLevel(LogLevel.INFO);
        break;
      case 'debug':
        this.setLogLevel(LogLevel.DEBUG);
        break;
      default:
        this.setLogLevel(LogLevel.INFO);
    }

    this.info(`Logger initialized with level: ${LogLevel[this.logLevel]}`);
  }
}
