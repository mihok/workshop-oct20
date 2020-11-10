const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const ecdsa = require('elliptic');

const { Application } = require('@curveball/core');
const { NotFound } = '@curveball/http-errors';
const accessLog = require('@curveball/accesslog').default;
const halBrowser  = require('@curveball/browser').default;
const problem = require('@curveball/problem').default;
const bodyParser = require('@curveball/bodyparser').default;
const router = require('@curveball/router').default;

const VERSION = require('./package.json').version;

const ec = new ecdsa.ec('secp256k1');

const hexToBinary = (s) => {
    let result = '';
    const lookupTable = {
        '0': '0000', '1': '0001', '2': '0010', '3': '0011', '4': '0100',
        '5': '0101', '6': '0110', '7': '0111', '8': '1000', '9': '1001',
        'a': '1010', 'b': '1011', 'c': '1100', 'd': '1101',
        'e': '1110', 'f': '1111'
    };
    for (let i = 0; i < s.length; i = i + 1) {
        if (lookupTable[s[i]]) {
            result += lookupTable[s[i]];
        } else {
            return null;
        }
    }
    return result;
};



class Transaction {
  id;
  in = [];
  out = [];

  static COINBASE_AMOUNT = 50;

  static isValid(transaction, unspentOutputs = []) {
    if (Transaction.generateId(transaction) !== transaction.id) {
      console.error('TransactionError: invalid id');

      return false;
    }

    const hasValidInputs = transaction.in
      .map(input => TxInput.isValid(input, transaction, unspentOuputs))
      .reduce((a, b) => a && b, true);

    if (!hasValidInputs) {
      console.error('TransactionError: invalid inputs');

      return false;
    }

    const totalInputValues = transaction.in
      .map(input => TxInput.getAmount(input, unspentOutputs))
      .reduce((a, b) => (a + b), 0);

    const totalOutputValues = transaction.out
      .map(output => output.amount)
      .reduce((a, b) => (a + b), 0);

    if (totalTxOutValues !== totalTxInValues) {
      console.error('TransactionError: mistmatch input and output amounts');

      return false;
    }
  }

  static isValidCoinBase(transaction, index) {
    if (!transaction) {
      console.error('TransactionError: no coinbase transaction');
      
      return false;
    } else if (transaction.in.length !== 1) {
      console.error(`TransactionError: coinbase transaction must have only one input, got '${transaction.in.length}'`);

      return false;
    } else if (transaction.in.length === 1
      && transaction.in[0].outputIndex !== index) {
      console.error(`TransactionError: invalid coinbase index, expected '${index}', got '${transaction.in[0].outputIndex}'`);

      return false;
    } else if (transaction.out.length !== 1) {
      console.error(`TransactionError: coinbase transaction must have only one output, got '${transaction.out.length}'`);

      return false;
    } else if (transaction.out.length === 1
      && transaction.out[0].amount !== Transaction.COINBASE_AMOUNT) {
      console.error(`TransactionError: invalid coinbase amount, expected '${Transaction.COINBASE_AMOUNT}', got '${transaction.out[0].amount}'`);

      return false;
    }

    return true;
  }

  sign(privateKey) {
    const privateKeyHex = ec.keyFromPrivate(this.privateKey, 'hex');
    const publicKey = privateKeyHex.getPublic().encode('hex');
    const signature = Array.from(privateKeyHex.sign(this.id).toDER(), (byte) => {
        return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('');

    for (input of this.in) {
      // TODO: Ensure the output is the publickKey here.
      input.signature = signature;
    }
  }

  static generateId(transaction) {
    const inputs = transaction.in
      .map(input => input.outputId + input.outputIndex)
      .reduce((a, b) => a + b);

    const outputs = transaction.out
      .map(output => output.address + output.amount)
      .reduce((a, b) => a + b);

    return crypto.createHash('sha256').update(inputs + outputs).digest('hex');
  }

  static generateCoinBase(address, index) {
    const input = new TxInput();
    input.signature = '';
    input.outputId = '';
    input.outputIndex = index;

    const transaction = new Transaction();
    transaction.in = [input];
    transaction.out = [new TxOutput({ address, amount: Transaction.COINBASE_AMOUNT })];
    transaction.id = Transaction.generateId(transaction);

    return transaction;
  }
}

class TxOutput {
  address;
  amount;

  constructor({ address, amount }) {
    this.address = address;
    this.amount = amount;
  }
}

class TxInput {
  outputId;
  outputIndex;
  signature;
}

class UnspentTxOutput {
  _outputId;
  _outputIndex;
  _address;
  _amount;

  get outputId() { return this._outputId; }
  get outputIndex() { return this._outputIndex; }
  get address() { return this._address; }
  get amount() { return this._amount; }

  constructor(outputId, outputIndex, address, amount) {
      this._outputId = outputId;
      this._outputIndex = outputIndex;
      this._address = address;
      this._amount = amount;
  }
}


class Block {
  index;
  hash;
  previousHash;
  timestamp;
  // data;
  data = [];

  difficulty;
  nonce;

  constructor({ index, hash, previousHash, timestamp, data, difficulty, nonce }) {
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.data = data;

    this.difficulty = difficulty;
    this.nonce = nonce;
  }

  static calculateHash({ index, previousHash, timestamp, data, difficulty, nonce }) {
    // return crypto.createHash('sha256').update(index + previousHash + timestamp + data).digest('hex');
    return crypto.createHash('sha256').update(index + previousHash + timestamp + data + difficulty + nonce).digest('hex');
  }

  static matchesDifficulty({ hash }, difficulty) {
    const binary = hexToBinary(hash);
    const requiredPrefix = '0'.repeat(difficulty);

    return binary.startsWith(requiredPrefix);
  }
}

class BlockChain {
  _sequence = [];
  _coins = []; // Active coins in circulation (unspent)

  static BLOCK_GENERATION_INTERVAL = 10; // Seconds
  static DIFFICULTY_ADJUSTMENT_INTERVAL = 10; // Blocks

  get genesisBlock() {
    return this._sequence[0];
  }

  get lastBlock() {
    return this._sequence[this._sequence.length - 1];
  }

  get length() {
    return this._sequence.length;
  }

  get sequence() {
    return this._sequence;
  }


  get accumulatedDifficulty() {
    return BlockChain.calculateAccumulatedDifficulty(this._sequence);
  }

  get currentDifficulty() {
    if (this.lastBlock.index % BlockChain.DIFFICULTY_ADJUSTMENT_INTERVAL === 0
      && this.lastBlock.index !== 0) {
      
      const lastAdjustedBlock = this._sequence[this.sequence.length - BlockChain.DIFFICULTY_ADJUSTMENT_INTERVAL];
      const timeExpected = BlockChain.BLOCK_GENERATION_INTERVAL * BlockChain.DIFFICULTY_ADJUSTMENT_INTERVAL;
      const timeTaken = this.lastBlock.timestamp - lastAdjustedBlock.timestamp;

      if (timeTaken < timeExpected / 2) return lastAdjustedBlock.difficulty + 1;
      else if (timeTaken > timeExpected * 2) return lastAdjustedBlock.difficulty - 1;
      else return lastAdjustedBlock.difficulty;

    } else {
      return this.lastBlock.difficulty;
    }
  }


  set nextBlock(value) {
    this._sequence.push(value);
  }



  constructor() {
    const genesis = new Block({
      index: 0,
      hash: '3f1771dc40f915328af772397688c02f7f4a1e7f371b18fce8deb8e0a853aeb3',
      previousHash: null,
      timestamp: (new Date('2020-10-08')).getTime() / 1000,
      //data: JSON.stringify({ message: "Welcome to JS Workshop" }),
      data: [],

      difficulty: 0,
      nonce: 0,
    });

    this.nextBlock = genesis;
  }



  static calculateAccumulatedDifficulty(sequence) {
    return sequence
      .map(block => Math.pow(2, block.difficulty))
      .reduce((a, b) => a + b);
  }



  isValidTransactions(transactions = [], index) {
    const coinbase = transactions[0];

    if (!Transaction.isValidCoinBase(coinbase, index)) {
      return false;
    }

    // TODO: Check for duplicate transaction inputs
    
    return transactions
      .slice(1)
      .map(transaction => Transaction.isValid(transaction))
      .reduce((a, b) => a && b, true);
  }

  static isValidNewBlock(newBlock, previousBlock) {
    if (previousBlock.index + 1 !== newBlock.index) {
      console.error('BlockChainError: invalid index');

      return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
      console.error('BlockChainError: invalid previous hash');

      return false;
    } else if (!BlockChain.isValidTimestamp(newBlock, previousBlock)) {
      console.error(`BlockChainError: invalid timestamp`);

      return false;
    } else if (Block.calculateHash(newBlock) !== newBlock.hash) {
      console.error(`BlockChainError: invalid hash, '${Block.calculateHash(newBlock)}' and '${newBlock.hash}' do not match`);

      return false;
    // }
    } else if (!Block.matchesDifficulty(newBlock, newBlock.difficulty)) {
      console.warn(`BlockChainWarning: block difficulty not satisfied, got: '${newBlock.difficulty}'`);
    }

    return true;
  }

  isValidNewBlock(newBlock) {
    const previousBlock = this.lastBlock;

    return BlockChain.isValidNewBlock(newBlock, previousBlock);
  }

  static isValidTimestamp(newBlock, previousBlock) {
    return previousBlock.timestamp - 60 < newBlock.timestamp
      && newBlock.timestamp - 60 < Math.round(Date.now() / 1000);
  }

  isValidGenesis(block) {
    return JSON.stringify(block) === JSON.stringify(this.genesisBlock);
  }

  isValidChain(sequenceToValidate) {
    if (!this.isValidGenesis(sequenceToValidate[0])) {
      return false;
    }

    for(let i = 1; i < sequenceToValidate.length; i++) {
      if (!BlockChain.isValidNewBlock(sequenceToValidate[i], sequenceToValidate[i - 1])) {
        return false;
      }
    }

    return true;
  }



  replaceBlockChain(newSequence) {
    // if (this.isValidChain(newSequence) && newSequence.length > this.length) {
    if (this.isValidChain(newSequence)
      && BlockChain.calculateAccumulatedDifficulty(newSequence) > this.accumulatedDifficulty) {
      this._sequence = newSequence;
    }
  }


  generateBlock(privateKey) {
    const nodeAddress = ec.keyFromPrivate(privateKey, 'hex').getPublic().encode('hex');

    const coinbase = Transaction.generateCoinBase(nodeAddress, this.lastBlock.index + 1);
    const data = [coinbase];

    return this.generateRawBlock({ data });
  }

  generateTransactionBlock(privateKey, receiverAddress, amount) {
    const nodeAddress = ec.keyFromPrivate(privateKey, 'hex').getPublic().encode('hex');

    const coinbase = Transaction.generateCoinBase(nodeAddress, this.lastBlock.index + 1);
    const transaction = this.createTransaction(receiverAddress, amount);
    const data = [coinbase, transaction];

    return this.generateRawBlock({ data });
  }

  generateRawBlock({ data }) {
    const previousBlock = this.lastBlock;

    const previousHash = previousBlock.hash;
    const index = previousBlock.index + 1;
    // const timestamp = Date.now() / 1000;
    const timestamp = Math.round(Date.now() / 1000);
    // const hash = Block.calculateHash({ index, previousHash, timestamp, data });
    const difficulty = this.currentDifficulty;

    // const newBlock = new Block({ index, hash, previousHash, timestamp, data });
    const newBlock = this.findBlock(index, previousHash, timestamp, data, difficulty);

    this.addBlock(newBlock);

    return newBlock;
  }

  addBlock(newBlock) {
    if (!this.isValidNewBlock(newBlock)) {
      return;
    }

    if (this.processBlockTransactions(newBlock)) {
      this.nextBlock = newBlock;

      return newBlock;
    }
  }

  findBlock(index, previousHash, timestamp, data, difficulty) {
    let nonce = 0;

    while (true) {
      const hash = Block.calculateHash({ index, previousHash, timestamp, data, difficulty, nonce });
      console.info(`BlockChainInfo: looking for hash with appropriate difficulty, hash: '${hash}', difficulty: '${difficulty}' nonce: '${nonce}'`);
      if (Block.matchesDifficulty({ hash }, difficulty)) {
        return new Block({ index, hash, previousHash, timestamp, data, difficulty, nonce });
      }

      nonce++;
    }
  }
  
  processBlockTransactions({ data, index }) {
    if (!this.isValidTransactions(data, index)) {
      return false;
    }

    const newUnspentOutputs = data
      .map(transaction => transaction.out.map((output, i) => new UnspentTxOutput(transaction.id, i, output.address, output.amount)))
      .reduce((a, b) => a.concat(b), []);

    const newSpentOutputs = data
      .map(transaction => transaction.in)
      .reduce((a, b) => a.concat(b), [])
      .map(input => new UnspentTxOutput(input.outputId, input.outputIndex, '', 0));

    const unspentOutputs = this._coins
      .filter(unspentOutput => !BlockChain.findUnspentCoinsByIdAndIndex(newSpentOutputs, unspentOutput.outputId, unspentOutput.outputIndex))
      .concat(newUnspentOutputs);

    this._coins = unspentOutputs;

    return true;
  }


  static findUnspentCoinsByIdAndIndex(coins, id, index) {
    return coins.find(unspentOutput => unspentOutput.outputId === id && unspentOutput.outputIndex === index);
  }

  static findUnspentCoinsByAmount(coins, targetAmount) {
    let result = [];
    let currentAmount = 0;
 
    for (unspentOutput of coins) {
      result.push(unspentOutput);
      currentAmount += unspentOutput.amount;

      if (currentAmount >= targetAmount) {
        break;
      }
    }

    return [result, currentAmount - targetAmount];
  }

  static findUnspentCoinsByAddress(coins, address) {
    return coins.filter(unspentOutput => unspentOutput.address === address);
  }

  createTransaction(receiverAddress, amount) {
    const nodeAddress = ec.keyFromPrivate(this.privateKey, 'hex').getPublic().encode('hex');
    const nodeCoins = this._coins.filter(unspentOutput => unspentOutput.address === nodeAddress);

    const [ coins, remainingAmount ] = BlockChain.findUnspentCoinsByAmount(nodeCoins, amount);

    const unsignedTxInputs = coins.map(unspentOutput => {
      const input = new TxInput();
      input.outputId = unspentOutput.outputId;
      input.outputIndex = unspentOutput.outputIndex;

      return input;
    });

    const transaction = new Transaction();
    transaction.in = unsignedTxInputs;
    transaction.out = remainingAmount === 0
      ? [new TxOutput({ address: receiverAddress, amount })]
      : [
        new TxOutput({ address: receiverAddress, amount }),
        new TxOutput({ address: nodeAddress, remainingAmount }),
      ];
    transaction.id = Transaction.generateId(transaction);
    transaction.sign(this.privateKey, this._coins);

    return transaction;
  }
}

class BlockChainNode {
  name = '';

  httpPort = parseInt(process.env.PORT, 10) || 8000;
  webSocketPort = parseInt(process.env.WS_PORT, 10) || 3000;

  privateKey = fs.readFileSync(process.env.PRIVATE_KEY || 'private.key', 'utf8').toString();

  // walletPublicKeyPath = process.env.PUBLIC_KEY || 'pub.key';
  // walletPrivateKeyPath = process.env.PRIVATE_KEY || 'priv.key';

  peers = [];
  blockchain = new BlockChain();
  server = new Application();

  routes = {
    default: ctx => {
      if (ctx.webSocket) {
        this.peers.push(new BlockChainPeerSocket(ctx.webSocket, this));
      } else {
        ctx.response.type = 'application/hal+json';
        ctx.response.body = {
          '_links': {
            self: { href: '/', title: `Blockchain Node ${this.name}.` },
            // socket: { href: `ws://${this.websocketHost}:${this.websocketPort}`, title: `WebSocket connection for BlockChain Node '${this.name}'.` },
            'blocks-collection': { href: '/blocks', title: `Blocks in the Blockchain Node '${this.name}'.` },
            mine: { href: '/blocks/mine', title: `Mine for blocks`, hints: { method: 'POST'  } },
            'peers-collection': { href: '/peers', title: `Peers connected to the Blockchain Node '${this.name}'.` },
            'add-peer': { href: '/peers/add', title: `Connect to a Peer`, hints: { method: 'POST' } },
          },
          version: VERSION,
        };
      }
    },

    getBalances: ctx => {
      ctx.response.type = 'application/hal+json';
    },

    getBalance: ctx => {
      const balanceAddress = ctx.state.params.address;

      const filteredCoins = BlockChain.findUnspentCoinsByAddress(this.blockchain._coins, balanceAddress);
      const balance = filteredCoins
        .map(unspentOutput => unspentOutput.amount)
        .reduce((a, b) => a + b, 0);

      ctx.response.type = 'application/hal+json';
      ctx.response.body = {
        '_links': {
          self: { href: '/blocks', title: `Blocks in the Blockchain Node '${this.name}'.`},
          node: { href: '/', title: `Blockchain Node ${this.name}.` },
        },
        '_embedded': {
          // item: filteredCoins.
        },
        balance,
      }

    },

    getBlocks: ctx => {
      ctx.response.type = 'application/hal+json';
      ctx.response.body = {
        '_links': {
          self: { href: '/blocks', title: `Blocks in the Blockchain Node '${this.name}'.`},
          node: { href: '/', title: `Blockchain Node ${this.name}.` },
          item: this.blockchain.sequence.map(block => ({
            href: `/blocks/${block.hash}`,
            title: `Block ${block.index} in BlockChain Node '${this.name}'.`,
          })),
        },
        length: this.blockchain.length,
      }
    },

    mineRawBlock: ctx => {
      const data = JSON.stringify(ctx.request.body);

      const block = this.blockchain.generateRawBlock({ data });

      this.peers.forEach(peer => peer.write({
        type: 'response',
        message: 'Sending the latest new block',
        data: [this.blockchain.lastBlock],
      }));

      ctx.response.type = 'application/hal+json';
      ctx.response.headers.set('Location', `/blocks/${block.hash}`);
      ctx.response.status = 201;
    } ,

    mineBlock: ctx => {
      const data = JSON.stringify(ctx.request.body);

      const block = this.blockchain.generateBlock(this.privateKey);

      this.peers.forEach(peer => peer.write({
        type: 'response',
        message: 'Sending the latest new block',
        data: [this.blockchain.lastBlock],
      }));

      ctx.response.type = 'application/hal+json';
      ctx.response.headers.set('Location', `/blocks/${block.hash}`);
      ctx.response.status = 201;
    } ,

    getBlock: ctx => {
      const hash = ctx.state.params.hash;

      const filteredBlocks = this.blockchain.sequence.filter(block => block.hash === hash);

      if (filteredBlocks.length) {
        const block = filteredBlocks[0];

        block.data = JSON.parse(block.data);

        ctx.response.type = 'application/hal+json';
        ctx.response.body = {
          '_links': {
            self: { href: `/blocks/${block.hash}`, title: `Block ${block.index} in BlockChain Node '${this.name}'.` },
            'blocks-collection': { href: '/blocks', title: `Blocks in the Blockchain Node '${this.name}'.` },
          },
          ...block,
        };
      } else {
        throw new NotFound('Block not found');
      }
    },

    getPeers: ctx => {
      ctx.response.type = 'application/hal+json';
      ctx.response.body = {
        '_links': {
          self: { href: `/peers`, title: `Peers connected to the Blockchain Node '${this.name}'.` },
          item: this.peers.map(peer => ({
            href: `ws://${peer.socket._socket.remoteAddress}:${peer.socket._socket.remotePort}`,
          })),
        },
      };

    },

    addPeer: ctx => {
      const data = ctx.request.body;

      this.connect(data.address);

      ctx.response.type = 'application/hal+json';
      ctx.response.headers.set('Location', `/peers`);
      ctx.response.status = 201;
    },
  }; 

  constructor(name) {
    this.name = name;

    const publicKey = ec.keyFromPrivate(this.privateKey, 'hex').getPublic().encode('hex');
    console.log('Using public key', publicKey);

    // The accesslog middleware shows all requests and responses on the cli.
    this.server.use(accessLog());

    // The HAL browser middleware gives us a frontend data explorer UI for free
    this.server.use(halBrowser());

    // The problem middleware turns exceptions into application/problem+json error
    // responses.
    this.server.use(problem());

    // The bodyparser middleware is responsible for parsing JSON and url-encoded
    // request bodies, and populate ctx.request.body.
    this.server.use(bodyParser());

    this.server.use(...[
      router('/', this.routes.default),
      router('/balances').get(this.routes.getBalances),
      router('/balances/:address').get(this.routes.getBalance),
      router('/blocks').get(this.routes.getBlocks),
      router('/blocks/mine/raw').post(this.routes.mineRawBlock),
      router('/blocks/mine').post(this.routes.mineBlock),
      router('/blocks/:hash').get(this.routes.getBlock),
      router('/peers').get(this.routes.getPeers),
      router('/peers/add').post(this.routes.addPeer),
    ]);
  }

  listen() {
    console.info(`Blockchain v${VERSION}`);

    this.server.listen(this.httpPort);
    this.server.listenWs(this.webSocketPort);

    console.log(`Listening on port http://0.0.0.0:${this.httpPort}`);
    console.log(`Listening on port http://0.0.0.0:${this.webSocketPort}`);
  }

  connect(peerAddress) {
    const ws = new WebSocket(peerAddress);

    ws.on('open', () => {
      console.info(`BlockChainNode: socket connection established with '${ws._socket.remoteAddress}:${ws._socket.remotePort}'`);

      this.peers.push(new BlockChainPeerSocket(ws, this));
    });

    ws.on('error', () => {
      console.error('BlockChainNodeError: connection failed');
    });
  }
}

class BlockChainPeerSocket {
  socket = null;
  node = null;

  onMessage(message) {
    const { type, data } = JSON.parse(message);

    console.info(`BlockChainPeerSocket: received message '${message}'`);

    switch(type) {
      case 'request-lastblock':
        this.onRequestLastBlock();
        break;
      case 'request-blockchain':
        this.onRequestBlockChain();
        break;
      case 'response': 
        this.onReceiveBlockChain(data);
        break;
    };
  }

  onRequestLastBlock() {
    this.write({
      type: 'response',
      message: 'Sending last block',
      data: [this.node.blockchain.lastBlock],
    });
  }

  onRequestBlockChain() {
    this.write({
      type: 'response',
      message: 'Sending whole blockchain',
      data: this.node.blockchain.sequence,
    });
  }

  onReceiveBlockChain(receivedSequence = []) {
    if (receivedSequence.length === 0) {
      console.error('BlockChainNodeError: received block chain size of 0');

      return;
    }

    const lastBlockReceived = receivedSequence[receivedSequence.length - 1];
    const lastBlockHeld = this.node.blockchain.lastBlock;

    if (lastBlockReceived.index > lastBlockHeld.index) {
      if (lastBlockHeld.hash === lastBlockReceived.previousHash) {
        if (this.node.blockchain.addBlock(lastBlockReceived)) {
          this.broadcast({
            type: 'response',
            message: 'Received new block',
            data: [this.node.blockchain.lastBlock],
          });
        }
      } else if (receivedSequence.length === 1) {
         this.broadcast({
          type: 'request-blockchain',
          message: 'Requesting whole blockchain',
        });
      } else {
        if (this.node.blockchain.replaceBlockChain(receivedSequence)) {
          this.broadcast({
            type: 'response',
            message: 'Sending latest new block',
            data: [this.node.blockchain.lastBlock],
          });
        }
      }
    }
  }

  constructor(ws, node) {
    this.socket = ws;
    this.node = node;

    this.socket.on('message', this.onMessage.bind(this));

    this.write({
      type: 'hello',
      message: `You are now peering with BlockChain Node '${this.node.name}'`,
    });
  }

  broadcast(message) {
    this.node.peers.forEach(socket => socket.write(message));
  }

  write(message) {
    if (this.socket) {
      const json = JSON.stringify(message);

      console.info(`BlockChainPeerSocket: writing message '${json}'`);

      this.socket.send(json);
    }
  }
}

if (!fs.existsSync(process.env.PRIVATE_KEY || 'private.key')) {
  const keyPair = ec.genKeyPair();
  const privateKey = keyPair.getPrivate();

  fs.writeFileSync(process.env.PRIVATE_KEY || 'private.key', privateKey.toString(16));
}

const node = new BlockChainNode(process.env.NODE || 'test');

node.listen();

module.exports = {
  Block,
  BlockChain,
};
