const WebSocket = require('ws');
const crypto = require('crypto');

const { Application } = require('@curveball/core');
const { NotFound } = '@curveball/http-errors';
const accessLog = require('@curveball/accesslog').default;
const halBrowser  = require('@curveball/browser').default;
const problem = require('@curveball/problem').default;
const bodyParser = require('@curveball/bodyparser').default;
const router = require('@curveball/router').default;

const VERSION = require('./package.json').version;

class Block {
  index;
  hash;
  previousHash;
  timestamp;
  data;

  constructor({ index, hash, previousHash, timestamp, data }) {
    this.index = index;
    this.hash = hash;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.data = data;
  }

  static calculateHash({ index, previousHash, timestamp, data }) {
    return crypto.createHash('sha256').update(index + previousHash + timestamp + data).digest('hex');i
  }

  static isValidBlock(block) {
    return typeof block.index === 'number'
      && typeof block.hash === 'string'
      && typeof block.previousHash === 'string'
      && typeof block.timestamp === 'number'
      && typeof block.data === 'string';
  };
}

class BlockChain {
  _sequence = [];

  get genesisBlock() {
    return this._sequence.sort(BlockChain.orderByIndex)[0];
  }

  get lastBlock() {
    return this._sequence.sort(BlockChain.orderByIndex)[this.sequence.length - 1];
  }

  get sequence() {
    return this._sequence.sort(BlockChain.orderByIndex);
  }

  get length() {
    return this._sequence.length;
  }

  set nextBlock(value) {
    this.sequence.push(value);
  }


  static orderByIndex(a, b) {
    if (a.index < b.index) {
      return -1;
    }

    if (a.index > b.index) {
      return 1;
    }

    return 0;
  }


  static isValidNewBlock(newBlock, previousBlock) {
    if (previousBlock.index + 1 !== newBlock.index) {
      console.error('BlockChainError: invalid index.');

      return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
      console.error('BlockChainError: invalid previoushash.');

      return false;
    } else if (Block.calculateHash(newBlock) !== newBlock.hash) {
      console.error(`BlockChainError: invalid hash, '${calculateHashForBlock(newBlock)}' and '${newBlock.hash}' dont match.`);

      return false;
    }
    return true;
  }

  isValidNewBlock(newBlock) {
    const previousBlock = this.lastBlock;

    return BlockChain.isValidNewBlock(newBlock, previousBlock);
  };

  isValidChain(blockChainToValidate) {
    if (!this.isValidGenesis(blockChainToValidate.genesisBlock)) {
      return false;
    }

    for (let i = 1; i < blockChainToValidate.sequence.length; i++) {
      if (!BlockChain.isValidNewBlock(blockChainToValidate.sequence[i], blockChainToValidate.sequence[i - 1])) {
        return false;
      }
    }
    return true;
  }

  isValidGenesis(block) {
    return JSON.stringify(block) === JSON.stringify(this.genesisBlock);
  };

  
  constructor() {
    // Create our genesis block
    const genesis = new Block({
      index: 0,
      hash: '83e3b2380a90a44ea5d5ac53dad809eca44f1da55ff3fdf5490d23a6f0a44da0',
      previousHash: null,
      timestamp: 1602196200,
      data: 'Welcome to JS Workshop!',
    });
   
    // Assign our genesis block to the blockChain sequence.
    this.nextBlock = genesis;
  }

  replaceBlockChain(newBlockChain) {
    if (isValidChain(newBlockChain) && newBlockChain.length > this.length) {

      console.info('Received blockChain is valid. Replacing current blockChain with received blockChain.');

      this._sequence = newBlockChain.sequence;

      this.broadcastLatest();

    } else {

      console.error('BlockChainError: received BlockChain invalid.');

    }
  }

  generateBlock({ data }) {
    const previousBlock = this.lastBlock;

    const previousHash = previousBlock.hash;
    const index = previousBlock.index + 1;
    const timestamp = Date.now() / 1000; // Proper unix timestamp is in seconds
    const hash = Block.calculateHash({ index, previousHash, timestamp, data });
   
    const newBlock = new Block({ index, hash, previousHash, timestamp, data });

    this.nextBlock = newBlock;

    return newBlock;
  }

  addBlock(newBlock) {
    if (!this.isValidNewBlock(newBlock)) {
      return;
    }

    this.nextBlock = newBlock;

    return newBlock;
  }
}

class BlockChainPeerSocket {
  socket = null;
  node = null

  onMessage(message) {
    const { type, data } = JSON.parse(message);

    console.info(`BlockChainPeerSocket: received message '${message}'`);

    switch (type) {
      case 'request-lastblock':
        this.onRequestLastBlock();
        break;
      case 'request-blockchain':
        this.onRequestBlockChain();
        break;
      case 'response':
        this.onReceiveBlockChain(data);
        break;
    }
  }

  onRequestLastBlock() {
    this.write({
      type: 'response',
      message: '',
      data: [this.node.blockchain.lastBlock],
    });
  }

  onRequestBlockChain() {
    this.write({
      type: 'response',
      message: '',
      data: [this.node.blockchain.sequence],
    });
  }

  onReceiveBlockChain(receivedSequence = []) {
    if (receivedSequence.length === 0) {
      console.error('BlockChainNodeError: received block chain size of 0');
      return;
    }

    const lastBlockReceived = receivedSequence[receivedSequence.length - 1];
    if (!Block.isValidBlock(lastBlockReceived)) {
      console.error('BlockChainNodeError: block structuture not valid');
      return;
    }

    const lastBlockHeld = this.node.blockchain.lastBlock;
    if (lastBlockReceived.index > lastBlockHeld.index) {
      console.warn(`BlockChainNodeWarning: blockchain possibly behind. We got: '${lastBlockHeld.index}', and peer had: '${lastBlockReceived.index}'`);

      if (lastBlockHeld.hash === lastBlockReceived.previousHash) {
        if (this.node.blockchain.addBlock(lastBlockReceived)) {
          this.broadcast({
            type: 'response',
            message: 'Sending latest new block.',
            data: [this.node.blockchain.lastBlock],
          });
        } else {
          console.error('BlockChainNodeError: unable to add block to blockchain.');
        }
      } else if (receivedSequence.length === 1) {
        this.broadcast({
          type: 'request-blockchain',
          message: 'Request blockchain.',
        });
      } else {
        console.info('BlockChainNodeWarning: received blockchain is longer than current blockchain.');

        this.node.blockchain.replaceChain(receivedBlocks);
      }
    }
  }

  constructor(socket, node) {
    this.socket = socket;
    this.node = node;

    this.socket.on('message', this.onMessage.bind(this));

    this.write({
      type: 'hello',
      message: `You are now peering with BlockChain Node '${this.node.name}'`,
    });
  }

  write(message) {
    if (this.socket) {
      const json = JSON.stringify(message);

      console.info(`BlockChainPeerSocket: writing message '${json}'`);

      this.socket.send(json);
    }
  }

  broadcast(message) {
    this.node.peers.forEach(socket => socket.write(message));
  }
}

class BlockChainNode {
  name = '';

  httpPort = parseInt(process.env.PORT, 10) || 8000;

  websocketPort = parseInt(process.env.WEBSOCKET_PORT, 10) || 3000;
  websocketHost = process.env.WEBSOCKET_HOST || 'localhost';

  blockchain = new BlockChain();
  peers = [];
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
            socket: { href: `ws://${this.websocketHost}:${this.websocketPort}`, title: `WebSocket connection for BlockChain Node '${this.name}'.` },
            'blocks-collection': { href: '/blocks', title: `Blocks in the Blockchain Node '${this.name}'.` },
            mine: { href: '/blocks/mine', title: ``, hints: { method: 'POST'  } },
            'peers-collection': { href: '/peers', title: `Peers connected to the Blockchain Node '${this.name}'.` },
          },
          version: VERSION,
        };
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

    mineBlock: ctx => {
      const data = JSON.stringify(ctx.request.body);

      const block = this.blockchain.generateBlock({ data });

      this.peers.forEach(peer => peer.write({
        type: 'response',
        message: 'Sending latest new block.',
        data: [this.blockchain.lastBlock],
      }));

      ctx.response.type = 'application/hal+json';
      ctx.response.headers.set('Location', `/blocks/${block.hash}`);
      ctx.response.status = 201;
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
      router('/blocks').get(this.routes.getBlocks),
      router('/blocks/mine').post(this.routes.mineBlock),
      router('/blocks/:hash').get(this.routes.getBlock),
      router('/peers').get(this.routes.getPeers),
      router('/peers/add').post(this.routes.addPeer),
    ]);
  }

  listen() {
    console.info(`Blockchain v${VERSION}`);

    this.server.listen(this.httpPort);
    this.server.listenWs(this.websocketPort);

    console.log(`Listening on port http://0.0.0.0:${this.httpPort}`);
    console.log(`Listening on port ws://0.0.0.0:${this.websocketPort}`);
  }

  connect(peerAddress) {
    const ws = new WebSocket(peerAddress);

    ws.on('open', () => {
      console.info(`BlockChainNode: socket connecction established with '${ws._socket.remoteAddress}:${ws._socket.remotePort}'`);

      this.peers.push(new BlockChainPeerSocket(ws, this));
    });

    ws.on('error', () => {
        console.error('BlockChainNodeError: connection failed');
    });
  }
}

const node = new BlockChainNode(process.env.NODE || 'test');

node.listen();
