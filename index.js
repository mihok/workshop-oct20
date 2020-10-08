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


class BlockChainNode {
  name = '';

  httpPort = parseInt(process.env.PORT, 10) || 8000;

  peers = [];
  server = new Application();

  routes = {
    default: ctx => {
      if (ctx.webSocket) {
        // this.peers.push(new BlockChainPeerSocket(ctx.webSocket, this));
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
      router('/blocks/:hash').get(this.routes.getBlock),
      router('/peers').get(this.routes.getPeers),
    ]);
  }

  listen() {
    console.info(`Blockchain v${VERSION}`);

    this.server.listen(this.httpPort);

    console.log(`Listening on port http://0.0.0.0:${this.httpPort}`);
  }
}

const node = new BlockChainNode(process.env.NODE || 'test');

node.listen();
