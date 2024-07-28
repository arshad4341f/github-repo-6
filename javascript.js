const Web3 = require('web3');
const { ChainId, Fetcher, Route, Trade, TokenAmount, TradeType, Percent } = require('@uniswap/sdk');
const axios = require('axios');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const dotenv = require('dotenv');

// Load environment variables from a .env file
dotenv.config();

// Setup Web3 and connect to the blockchain
const web3 = new Web3(process.env.INFURA_OR_NODE_URL);
const myAccount = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
web3.eth.accounts.wallet.add(myAccount);

// Define ABI and addresses for Aave and USDT
const AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI = require('./AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI.json');
const AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS;
const AAVE_LENDING_POOL_ABI = require('./AAVE_LENDING_POOL_ABI.json');
const USDT_ABI = require('./USDT_ABI.json');
const USDT_ADDRESS = process.env.USDT_ADDRESS;

// DEX APIs and WebSocket endpoints
const DEX_APIS = {
  uniswapV2: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2',
  uniswapV3: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
  // Add more DEX endpoints as needed
};

const WEBSOCKET_ENDPOINTS = {
  uniswapV2: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
  uniswapV3: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
  // Add more WebSocket endpoints as needed
};

// Fetch pairs from Uniswap subgraphs
async function fetchPairs(dex) {
  const query = `{ pairs(first: 1000) { id token0 { id } token1 { id } reserve0 reserve1 } }`;
  const response = await axios.post(DEX_APIS[dex], { query });
  return response.data.data.pairs;
}

// WebSocket setup to receive real-time data
function setupWebSocket(dex, callback) {
  const ws = new WebSocket(WEBSOCKET_ENDPOINTS[dex]);
  ws.on('open', () => {
    console.log(`Connected to ${dex} WebSocket`);
    // Subscribe to token pair updates (replace with appropriate subscription logic for the dex)
    ws.send(JSON.stringify({ method: 'subscribe', params: ['newPendingTransactions'], id: 1, jsonrpc: '2.0' }));
  });
  ws.on('message', (data) => {
    const parsedData = JSON.parse(data);
    if (parsedData && parsedData.params && parsedData.params.result) {
      callback(parsedData.params.result);
    }
  });
  ws.on('error', (error) => {
    console.error(`WebSocket error on ${dex}:`, error);
  });
  ws.on('close', () => {
    console.log(`WebSocket connection to ${dex} closed`);
    // Reconnect after a delay
    setTimeout(() => setupWebSocket(dex, callback), 1000); // Reduced delay for quicker reconnection
  });
}

// Fetch real-time gas price from the Infura API
async function fetchRealTimeGasPrice() {
  const response = await axios.get(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}/eth_gasPrice`);
  return parseFloat(web3.utils.fromWei(response.data.result, 'gwei'));
}

// Function to fetch price data from various DEXs using The Graph API
async function fetchPriceFromGraphAPI(dex, token0Address, token1Address) {
  const query = `{ pair(id: "${token0Address.toLowerCase()}-${token1Address.toLowerCase()}") { token0 { id } token1 { id } reserve0 reserve1 } }`;
  const response = await axios.post(DEX_APIS[dex], { query });
  const pair = response.data.data.pair;
  if (pair) {
    const price = parseFloat(pair.reserve1) / parseFloat(pair.reserve0);
    return price;
  }
  throw new Error(`Failed to fetch price from ${dex}`);
}

// Function to fetch price data from multiple DEXs
async function getPriceData(token0Address, token1Address) {
  const pricePromises = Object.keys(DEX_APIS).map(dex => fetchPriceFromGraphAPI(dex, token0Address, token1Address));
  const prices = await Promise.all(pricePromises);
  return prices.reduce((acc, price, index) => {
    acc[Object.keys(DEX_APIS)[index]] = price;
    return acc;
  }, {});
}

// Function to calculate potential profit considering fees and slippage
async function calculateProfit(price1, price2, amount) {
  const tradingFee = 0.003; // Example trading fee of 0.3%
  const gasPriceGwei = await fetchRealTimeGasPrice();
  const gasPriceEth = web3.utils.fromWei(gasPriceGwei.toString(), 'gwei');
  const gasFee = gasPriceEth * 21000; // Example gas fee in ETH for a simple transaction
  const profit = (price1 - price2) * amount;
  const netProfit = profit - (profit * tradingFee * 2) - gasFee;
  return netProfit;
}

// Function to detect arbitrage opportunities
async function detectArbitrage() {
  try {
    const pairsV2 = await fetchPairs('uniswapV2');
    const pairsV3 = await fetchPairs('uniswapV3');
    const pairs = [...pairsV2, ...pairsV3];
    for (const pair of pairs) {
      const prices = await getPriceData(pair.token0.id, pair.token1.id);
      console.log('Prices:', prices);
      // Identify arbitrage opportunities
      const priceEntries = Object.entries(prices);
      for (let i = 0; i < priceEntries.length; i++) {
        for (let j = i + 1; j < priceEntries.length; j++) {
          const [dex1, price1] = priceEntries[i];
          const [dex2, price2] = priceEntries[j];
          const amount = 10; // Example amount to trade
          if (price1 > price2) {
            const profit = await calculateProfit(price1, price2, amount);
            if (profit > 0.5) { // Ensure profit is more than $0.5
              console.log(`Arbitrage opportunity detected between ${dex1} and ${dex2}! Profit: ${profit}`);
              // Execute flash loan and arbitrage trade
              await executeFlashLoanAndTrade(pair.token0.id, amount, dex1, dex2, profit);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error detecting arbitrage:', error);
  }
}

// Function to execute flash loan and arbitrage trade
async function executeFlashLoanAndTrade(tokenAddress, amount, dex1, dex2, expectedProfit) {
  // Recheck the profit potential before executing the transaction
  const prices = await getPriceData(tokenAddress, 'ETH'); // Example with ETH as the second token
  const price1 = prices[dex1];
  const price2 = prices[dex2];
  const profit = await calculateProfit(price1, price2, amount);
  if (profit < 0.5) {
    console.log('Profit potential decreased, transaction aborted.');
    return;
  }

  // Flash loan logic using Aave protocol
  const lendingPoolAddressProvider = new web3.eth.Contract(
    AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI,
    AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS
  );
  const lendingPoolAddress = await lendingPoolAddressProvider.methods.getLendingPool().call();
  const lendingPool = new web3.eth.Contract(AAVE_LENDING_POOL_ABI, lendingPoolAddress);
  
  const flashLoanParams = web3.eth.abi.encodeParameters(
    ['address', 'address', 'uint256', 'address', 'bytes'],
    [
      dex1, // DEX 1 address
      dex2, // DEX 2 address
      amount,
      tokenAddress,
      web3.eth.abi.encodeParameters(
        ['address', 'address', 'uint256'],
        [dex1, dex2, amount]
      )
    ]
  );

  const flashLoanTx = lendingPool.methods.flashLoan(
    myAccount.address,
    [tokenAddress],
    [amount],
    [0], // no debt
    myAccount.address,
    flashLoanParams,
    0
  );

  const gas = await flashLoanTx.estimateGas({ from: myAccount.address });
  const gasPrice = await web3.eth.getGasPrice();
  const tx = {
    from: myAccount.address,
    to: lendingPoolAddress,
    data: flashLoanTx.encodeABI(),
    gas,
    gasPrice
  };

  const receipt = await web3.eth.sendTransaction(tx);
  console.log('Flash loan executed', receipt);
}

// Function to detect sandwich opportunities
async function detectSandwich() {
  web3.eth.subscribe('pendingTransactions', async (error, txHash) => {
    if (error) console.error('Error subscribing to pending transactions:', error);
    try {
      const tx = await web3.eth.getTransaction(txHash);
      if (tx && tx.to && tx.value && tx.input && tx.input !== '0x') {
        // Decode transaction input data to identify token trade
        const inputData = web3.eth.abi.decodeParameters(['address', 'address', 'uint256'], tx.input.slice(10));
        const tokenAddress = inputData[1].toLowerCase();
        // Fetch price data before and after the transaction
        const preTxPrice = await fetchPriceFromGraphAPI('uniswapV2', tokenAddress, 'ETH'); // Example DEX
        const postTxPrice = await fetchPriceFromGraphAPI('uniswapV2', tokenAddress, 'ETH'); // Example DEX
        // Check if price impact is significant (e.g., more than 1%)
        if ((postTxPrice - preTxPrice) / preTxPrice > 0.01) {
          console.log('Potential sandwich opportunity detected');
          // Execute front-run and back-run trades
          await executeSandwichTrade(tx, preTxPrice, postTxPrice);
        }
      }
    } catch (error) {
      console.error('Error detecting sandwich:', error);
    }
  });
}

// Enhanced front-run and back-run trade logic
async function executeSandwichTrade(tx, preTxPrice, postTxPrice) {
  const amount = 10; // Example amount to trade

  // Front-run trade logic
  const frontRunProfit = await calculateProfit(postTxPrice, preTxPrice, amount);
  if (frontRunProfit < 5) {
    console.log('Front-run profit potential too low, skipping trade');
    return;
  }
  console.log('Executing front-run trade...');
  // Implement the front-run trade logic here
  try {
    // Example front-run trade logic
    const frontRunTx = {
      from: myAccount.address,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      gas: 21000,
      gasPrice: await web3.eth.getGasPrice()
    };
    await web3.eth.sendTransaction(frontRunTx);
    console.log('Front-run trade executed successfully');
  } catch (error) {
    console.error('Error executing front-run trade:', error);
  }

  // Back-run trade logic
  const backRunProfit = await calculateProfit(preTxPrice, postTxPrice, amount);
  if (backRunProfit < 5) {
    console.log('Back-run profit potential too low, skipping trade');
    return;
  }
  console.log('Executing back-run trade...');
  // Implement the back-run trade logic here
  try {
    // Example back-run trade logic
    const backRunTx = {
      from: myAccount.address,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      gas: 21000,
      gasPrice: await web3.eth.getGasPrice()
    };
    await web3.eth.sendTransaction(backRunTx);
    console.log('Back-run trade executed successfully');
  } catch (error) {
    console.error('Error executing back-run trade:', error);
  }
}

// Real-time monitoring using WebSocket
function monitorArbitrage() {
  Object.keys(WEBSOCKET_ENDPOINTS).forEach(dex => {
    setupWebSocket(dex, (price) => {
      console.log(`Real-time price update from ${dex}:`, price);
      // Update price data and detect arbitrage in real-time
      detectArbitrage();
    });
  });
}

// Initial data fetch and regular interval checks
detectArbitrage();
setInterval(detectArbitrage, 1000); // Check every 1 second

// Start real-time monitoring for arbitrage
monitorArbitrage();

// Start real-time monitoring for sandwich opportunities
detectSandwich();

// Function to view balance in USDT/USDC value
async function viewBalanceInUSDT() {
  const balance = await web3.eth.getBalance(myAccount.address);
  const usdtContract = new web3.eth.Contract(USDT_ABI, USDT_ADDRESS);
  const usdtDecimals = await usdtContract.methods.decimals().call();
  const usdtPrice = await fetchPriceFromGraphAPI('uniswapV2', USDT_ADDRESS, 'ETH');
  const usdtBalance = (balance / Math.pow(10, 18)) * usdtPrice * Math.pow(10, usdtDecimals);
  console.log(`Balance in USDT value: ${usdtBalance}`);
}

// Withdrawal function to withdraw profit from the contract
const withdrawalFunction = async () => {
  if (web3.eth.defaultAccount !== process.env.OWNER_ADDRESS) {
    throw new Error('Only the owner can withdraw profits.');
  }
  const balance = await web3.eth.getBalance(myAccount.address);
  const tx = {
    from: myAccount.address,
    to: process.env.OWNER_ADDRESS,
    value: balance - web3.utils.toWei('0.01', 'ether'), // Keep some ETH for gas fees
    gas: 21000,
    gasPrice: await web3.eth.getGasPrice()
  };
  const receipt = await web3.eth.sendTransaction(tx);
  console.log('Profit withdrawn:', receipt);
};
