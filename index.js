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
    return crypto.createHash('sha256').update(index + previousHash + timestamp + data).digest('hex');
  }
}

class BlockChain {
  _sequence = [];

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

  set nextBlock(value) {
    this._sequence.push(value);
  }

  constructor() {
    const genesis = new Block({
      index: 0,
      hash: '3f1771dc40f915328af772397688c02f7f4a1e7f371b18fce8deb8e0a853aeb3',
      previousHash: null,
      timestamp: (new Date('2020-10-08')).getTime() / 1000,
      data: JSON.stringify({ message: "Welcome to JS Workshop" }),
    });

    this.nextBlock = genesis;
  }


  static isValidNewBlock(newBlock, previousBlock) {
    console.log('VALID', newBlock, previousBlock);
    if (previousBlock.index + 1 !== newBlock.index) {
      console.error('BlockChainError: invalid index');

      return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
      console.error('BlockChainError: invalid previous hash');

      return false;
    } else if (Block.calculateHash(newBlock) !== newBlock.hash) {
      console.error(`BlockChainError: invalid hash, '${Block.calculateHash(newBlock)}' and '${newBlock.hash}' do not match`);

      return false;
    }

    return true;
  }

  isValidNewBlock(newBlock) {
    const previousBlock = this.lastBlock;

    return BlockChain.isValidNewBlock(newBlock, previousBlock);
  }

  isValidGenesis(block) {
    return JSON.stringify(block) === JSON.stringify(this.genesisBlock);
  }

  isValidChain(sequenceToValidate) {
    if (!this.isValidGenesis(sequenceToValidate[0])) {
      return false;
    }

    console.log('VALIDATE CHAIN', sequenceToValidate);

    for(let i = 1; i < sequenceToValidate.length; i++) {
      if (!BlockChain.isValidNewBlock(sequenceToValidate[i], sequenceToValidate[i - 1])) {
        return false;
      }
    }

    return true;
  }

  replaceBlockChain(newSequence) {
    if (this.isValidChain(newSequence) && newSequence.length > this.length) {
      this._sequence = newSequence;
    }
  }

  generateBlock({ data }) {
    const previousBlock = this.lastBlock;

    const previousHash = previousBlock.hash;
    const index = previousBlock.index + 1;
    const timestamp = Date.now() / 1000;
    const hash = Block.calculateHash({ index, previousHash, timestamp, data });

    const newBlock = new Block({ index, hash, previousHash, timestamp, data });

    this.addBlock(newBlock);

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






module.exports = {
  Block,
  BlockChain,
};






class BlockChainNode {
  name = '';

  httpPort = parseInt(process.env.PORT, 10) || 8000;
  webSocketPort = parseInt(process.env.WS_PORT, 10) || 3000;

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
            // mine: { href: '/blocks/mine', title: ``, hints: { method: 'POST'  } },
            'peers-collection': { href: '/peers', title: `Peers connected to the Blockchain Node '${this.name}'.` },
            // 'add-peer': { href: '/peers/add', title: ``, hints: { method: 'POST' } },
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

    mineBlock: ctx => {
      const data = JSON.stringify(ctx.request.body);

      const block = this.blockchain.generateBlock({ data });

      this.peers.forEach(peer => peer.write({
        type: 'response',
        message: 'Sending the latest new block',
        data: [this.blockchain.lastBlock],
      }));

      ctx.response.type = 'application/hal+json';
      ctx.response.headers.set('Location', `/blocks/${block.hash}`);
      ctx.response.status = 201;
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


const node = new BlockChainNode(process.env.NODE || 'test');

node.listen();
