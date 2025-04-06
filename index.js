const { Uploader } = require('@irys/upload');
const { Ethereum } = require('@irys/upload-ethereum');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const yaml = require('js-yaml');

// Hardcoded network settings (updated)
const NETWORK_SETTINGS = {
  name: "IRYS NETWORK",
  rpc_url: "https://testnet-rpc.irys.xyz/v1/execution-rpc",
  chain_id: 1270,  // Irys testnet chain ID
  currency_symbol: "IRYS",
  block_explorer_url: "https://storage-explorer.irys.xyz",
  site_key: "0x4AAAAAAA6vnrvBCtS4FAl-",  // Turnstile site key
  contract_address: "0xEFeB425135d5cDBEfFA5c9B8C16E81C7833dA02E",  // Payment receiver address
  payment_amount: 0.005  // ETH amount to pay for playing
};

// Set up logging
const logFile = 'app.log';
const logger = {
  formatTimestamp: () => {
    const now = new Date();
    const date = now.toLocaleDateString('en-US');
    const time = now.toLocaleTimeString('en-US');
    return `[ ${date} ${time} ]`;
  },
  info: (message) => {
    const timestamp = logger.formatTimestamp();
    const logMessage = `${timestamp} - INFO - ${message}`;
    console.log(logMessage);
    fs.appendFileSync(logFile, logMessage + '\n');
  },
  error: (message, error) => {
    const timestamp = logger.formatTimestamp();
    const errorDetail = error ? `: ${error.message}` : '';
    const logMessage = `${timestamp} - ERROR - ${message}${errorDetail}`;
    console.error(logMessage);
    fs.appendFileSync(logFile, logMessage + '\n');
    if (error && error.stack) {
      fs.appendFileSync(logFile, `${timestamp} - STACK - ${error.stack}\n`);
    }
  }
};

class IrysAutomation {
  constructor(configPath = 'config.yaml') {
    this.config = this.loadConfig(configPath);
    this.provider = new ethers.providers.JsonRpcProvider(NETWORK_SETTINGS.rpc_url);
    
    // Set up game parameters from the hardcoded network settings
    this.gameContract = NETWORK_SETTINGS.contract_address;
    this.gamePaymentValue = ethers.utils.parseEther(NETWORK_SETTINGS.payment_amount.toString());
    
    // Load wallets
    this.wallets = this.loadWallets();
  }

  loadConfig(configPath) {
    try {
      const fileContents = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(fileContents);
      logger.info(`Configuration loaded from ${configPath}`);
      return config;
    } catch (error) {
      logger.error(`Error loading configuration from ${configPath}`, error);
      throw error;
    }
  }

  loadWallets() {
    const wallets = [];
    try {
      const filePath = this.config.wallets.private_key_file;
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const lines = fileContents.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith('#')) {
          continue;
        }

        // Add 0x prefix if missing
        const privateKey = trimmedLine.startsWith('0x') ? trimmedLine : `0x${trimmedLine}`;
        
        // Create wallet from private key
        const wallet = new ethers.Wallet(privateKey, this.provider);
        const address = wallet.address;
        
        wallets.push({
          address,
          privateKey,
          wallet // Store ethers wallet object for convenience
        });
      }
      
      logger.info(`Loaded ${wallets.length} wallets from private keys`);
      return wallets;
    } catch (error) {
      logger.error('Error loading private keys', error);
      return [];
    }
  }

  async getCaptchaToken() {
    try {
      // Create task
      const createTaskPayload = {
        clientKey: this.config.captcha.api_key,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: 'https://irys.xyz/faucet',
          websiteKey: NETWORK_SETTINGS.site_key
        }
      };
      
      // Create the task
      const createTaskResponse = await axios.post(
        'https://api.capsolver.com/createTask',
        createTaskPayload
      );
      
      if (!createTaskResponse.data.taskId) {
        logger.error(`Failed to create captcha task: ${JSON.stringify(createTaskResponse.data)}`);
        return null;
      }
      
      const taskId = createTaskResponse.data.taskId;
      logger.info(`Created captcha task: ${taskId}`);
      
      // Get the result
      const maxAttempts = 15; // Prevent infinite loop
      let attempts = 0;
      
      while (attempts < maxAttempts) {
        const getResultPayload = {
          clientKey: this.config.captcha.api_key,
          taskId
        };
        
        const result = await axios.post(
          'https://api.capsolver.com/getTaskResult',
          getResultPayload
        );
        
        if (result.data.status === 'ready') {
          logger.info('Captcha solution received');
          return result.data.solution?.token;
        } else if (result.data.status === 'failed') {
          logger.error(`Captcha task failed: ${JSON.stringify(result.data)}`);
          return null;
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
      }
      
      logger.error('Captcha solving timed out');
      return null;
    } catch (error) {
      logger.error('Error solving captcha', error);
      return null;
    }
  }

  async claimFaucet(walletAddress) {
    const url = 'https://irys.xyz/api/faucet';
    const headers = {
      'accept': '*/*',
      'content-type': 'application/json',
      'origin': 'https://irys.xyz',
      'referer': 'https://irys.xyz/faucet',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    
    // Get captcha token
    const captchaToken = await this.getCaptchaToken();
    if (!captchaToken) {
      logger.error('Failed to get captcha token');
      return false;
    }
    
    const data = {
      captchaToken,
      walletAddress
    };
    
    try {
      const response = await axios.post(url, data, { headers });
      const result = response.data;
      
      if (result && result.success) {
        logger.info(`Faucet claim successful for ${walletAddress}. TX: ${result.data.transactionHash}`);
        return true;
      } else {
        logger.error(`Failed to claim faucet for ${walletAddress}: ${JSON.stringify(result)}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error claiming faucet for ${walletAddress}`, error);
      return false;
    }
  }

  async payForGame(walletInfo) {
    try {
      const { address, wallet } = walletInfo;
      
      // Get current nonce
      const nonce = await this.provider.getTransactionCount(address);
      
      // Estimate gas limit dynamically
      const estimateGasParams = {
        from: address,
        to: this.gameContract,
        value: this.gamePaymentValue
      };
      
      const gasLimit = await this.provider.estimateGas(estimateGasParams);
      
      // Get current gas price from network
      const gasPrice = await this.provider.getGasPrice();
      
      // Add a small buffer to gas limit (10%)
      const bufferedGasLimit = gasLimit.mul(110).div(100);
      
      // Build transaction with dynamically estimated gas
      const tx = {
        to: this.gameContract,
        value: this.gamePaymentValue,
        gasLimit: bufferedGasLimit,
        gasPrice: gasPrice,
        nonce,
        chainId: NETWORK_SETTINGS.chain_id
      };
      
      // Log gas details
      logger.info(`Gas Details for wallet ${address}:`);
      logger.info(`- Gas Limit: ${bufferedGasLimit.toString()}`);
      logger.info(`- Gas Price: ${gasPrice.toString()} wei`);
      logger.info(`- Estimated Total Gas Cost: ${bufferedGasLimit.mul(gasPrice).toString()} wei`);
      
      // Sign and send transaction
      const signedTx = await wallet.signTransaction(tx);
      const txResponse = await this.provider.sendTransaction(signedTx);
      
      logger.info(`Payment transaction sent: ${txResponse.hash}`);
      
      // Wait for transaction confirmation
      const receipt = await txResponse.wait();
      if (receipt.status === 1) {
        logger.info(`Payment confirmed for wallet ${address}`);
        return txResponse.hash;
      } else {
        logger.error(`Payment failed for wallet ${address}`);
        return null;
      }
    } catch (error) {
      logger.error(`Error paying for game`, error);
      return null;
    }
  }

  simulateSnakeGame() {
    // Simulate playing the Snake game and return a score
    const minScore = this.config.game.min_score;
    const maxScore = this.config.game.max_score;
    const score = Math.floor(Math.random() * (maxScore - minScore + 1)) + minScore;
    
    // Simulate game time
    const minPlayTime = this.config.game.min_play_time;
    const maxPlayTime = this.config.game.max_play_time;
    const gameTime = Math.floor(Math.random() * (maxPlayTime - minPlayTime + 1)) + minPlayTime;
    
    logger.info(`Simulating Snake game for ${gameTime} seconds, aiming for score ${score}`);
    return new Promise(resolve => {
      setTimeout(() => {
        resolve(score);
      }, gameTime * 1000);
    });
  }

  async submitGameScore(walletInfo, score) {
    try {
      const { address, privateKey } = walletInfo;
      
      // Initialize Irys uploader with the known working method
      logger.info(`Initializing Irys uploader for ${address}`);
      const irysUploader = await Uploader(Ethereum).withWallet(privateKey);
      
      // Prepare score data
      const timestamp = Date.now();
      const scoreData = JSON.stringify({
        game: 'snake',
        score: score,
        date: new Date().toISOString()
      });
      
      // Prepare tags
      const shortenedAddress = address.startsWith('0x') && address.length > 10 
      ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}`
      : address;
      const tags = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Application-Id', value: 'Irys-Arcade' },
        { name: 'Score-Entry', value: 'true' },
        { name: 'Game-Name', value: 'snake' },
        { name: 'Player-Wallet', value: address },
        { name: 'Player-Name', value: shortenedAddress },
        { name: 'Score', value: score.toString() },
        { name: 'Game-Version', value: '1.0' },
        { name: 'Timestamp', value: timestamp.toString() }
      ];
      
      // Upload the score data using the Irys SDK
      logger.info(`Preparing to upload score ${score} for wallet ${address}`);
      
      try {
        // Get price for upload
        const dataSize = Buffer.from(scoreData).byteLength;
        const price = await irysUploader.getPrice(dataSize);
        logger.info(`Price for uploading score: ${price}`);
        
        // Upload the score
        const response = await irysUploader.upload(scoreData, { tags });
        
        const txId = response.id;
        logger.info(`Score ${score} successfully submitted for wallet ${address}. Transaction ID: ${txId}`);
        return true;
      } catch (error) {
        logger.error(`Error during Irys upload`, error);
        return false;
      }
    } catch (error) {
      logger.error(`Error submitting game score`, error);
      return false;
    }
  }

  async playGameForWallet(walletInfo) {
    try {
      const { address } = walletInfo;
      logger.info(`Starting game cycle for wallet ${address}`);
      
      // 1. Pay for the game
      const paymentTx = await this.payForGame(walletInfo);
      if (!paymentTx) {
        logger.error(`Failed to pay for game for wallet ${address}`);
        return false;
      }
      
      // 2. Wait a bit for payment confirmation
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 3. Simulate playing the game
      const score = await this.simulateSnakeGame();
      
      // 4. Submit the score
      const submitted = await this.submitGameScore(walletInfo, score);
      if (submitted) {
        logger.info(`Game cycle completed successfully for wallet ${address} with score ${score}`);
        return true;
      } else {
        logger.error(`Failed to submit score for wallet ${address}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error in game cycle for wallet ${address}`, error);
      return false;
    }
  }

  countdown(hours = 25) {
    return new Promise(resolve => {
      const totalSeconds = hours * 3600;
      const startTime = Date.now();
      const endTime = startTime + (totalSeconds * 1000);
      
      const interval = setInterval(() => {
        const now = Date.now();
        
        if (now >= endTime) {
          clearInterval(interval);
          console.log('\nCountdown finished! Starting new run...');
          resolve();
          return;
        }
        
        const remaining = Math.floor((endTime - now) / 1000);
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;
        const timer = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        process.stdout.write(`Time until next run: ${timer}\r`);
      }, 1000);
    });
  }

  async run() {
    while (true) {
      const runFaucet = this.config.features.faucet_enabled;
      const runGame = this.config.features.game_enabled;
      const gamesPerWallet = this.config.general.games_per_wallet || 1;
      
      // Track successes
      let faucetSuccesses = 0;
      let gameSuccesses = 0;
      
      // Process each wallet
      for (let i = 0; i < this.wallets.length; i++) {
        const wallet = this.wallets[i];
        const address = wallet.address;
        logger.info(`Processing wallet ${i + 1}/${this.wallets.length}: ${address}`);
        
        // Claim faucet if enabled
        if (runFaucet) {
          logger.info(`Attempting faucet claim for ${address}`);
          const faucetClaimed = await this.claimFaucet(address);
          if (faucetClaimed) {
            faucetSuccesses++;
            // Wait between claims
            await new Promise(resolve => 
              setTimeout(resolve, this.config.faucet.delay_between_claims * 1000)
            );
          }
        }
        
        // Play game if enabled - multiple times as configured
        if (runGame) {
          logger.info(`Starting ${gamesPerWallet} games for wallet ${address}`);
          
          for (let gameNum = 1; gameNum <= gamesPerWallet; gameNum++) {
            logger.info(`Starting game ${gameNum}/${gamesPerWallet} for wallet ${address}`);
            const gameCompleted = await this.playGameForWallet(wallet);
            
            if (gameCompleted) {
              gameSuccesses++;
              // Wait between games if not the last game
              if (gameNum < gamesPerWallet) {
                await new Promise(resolve => 
                  setTimeout(resolve, this.config.game.delay_between_games * 1000)
                );
              }
            } else {
              logger.error(`Game ${gameNum}/${gamesPerWallet} failed for wallet ${address}`);
              // If a game fails, we might want to skip remaining games for this wallet
              break;
            }
          }
        }
      }
      
      // Log results
      if (runFaucet) {
        logger.info(`Faucet claims completed. Success: ${faucetSuccesses}/${this.wallets.length}`);
      }
      if (runGame) {
        const totalGames = this.wallets.length * gamesPerWallet;
        logger.info(`Games completed. Success: ${gameSuccesses}/${totalGames}`);
      }
      
      // Wait for next run
      const waitHours = this.config.general.hours_between_runs;
      logger.info(`Run completed. Waiting ${waitHours} hours until next run`);
      await this.countdown(waitHours);
    }
  }
}

// Main execution
async function main() {
  try {
    const automation = new IrysAutomation();
    await automation.run();
  } catch (error) {
    logger.error('Critical error in main process', error);
    process.exit(1);
  }
}

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  logger.info('Process interrupted by user. Exiting...');
  process.exit(0);
});

// Run the automation
main();
