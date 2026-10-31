// Peer-to-peer networking with PeerJS (WebRTC data channels).
// The host's browser is the game server: it owns the state, runs the timers
// and sends each player their own redacted view. Other devices connect to the
// host using the room code, so the whole game deploys as a static site.

/* global Peer */

const PREFIX = 'tinyparl-v1-';
const HEARTBEAT_MS = 3000;
const TIMEOUT_MS = 11000;

export function peerIdFor(code) {
  return PREFIX + code.toUpperCase();
}

function peerOptions() {
  return { debug: 0 };
}

// ---------- host ----------

export class HostNet {
  constructor(code, handlers) {
    this.code = code;
    this.h = handlers; // { onHello(conn, msg) -> {ok,error}, onAction(pid, action), onReact(pid, emoji), onDrop(pid) }
    this.conns = new Map(); // conn.connectionId -> { conn, pid, lastSeen }
    this.peer = null;
    this.watchdog = null;
  }

  // Resolves when the room id is registered with the signalling server.
  open() {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerIdFor(this.code), peerOptions());
      this.peer = peer;
      let settled = false;
      peer.on('open', () => {
        settled = true;
        resolve();
      });
      peer.on('error', (err) => {
        if (!settled) {
          settled = true;
          peer.destroy();
          reject(err);
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          // Lost the signalling server; existing data channels keep working.
          setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 2000);
        }
      });
      peer.on('disconnected', () => {
        setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
      });
      peer.on('connection', (conn) => this._accept(conn));
    }).then(() => {
      this.watchdog = setInterval(() => this._sweep(), 2000);
    });
  }

  _accept(conn) {
    const entry = { conn, pid: null, lastSeen: Date.now() };
    this.conns.set(conn.connectionId, entry);
    conn.on('data', (msg) => {
      entry.lastSeen = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        const res = this.h.onHello(msg);
        if (res.ok) {
          // A player re-opening the game replaces their old connection.
          for (const [id, e] of this.conns) {
            if (e.pid === msg.id && id !== conn.connectionId) {
              e.pid = null;
              e.conn.close();
              this.conns.delete(id);
            }
          }
          entry.pid = msg.id;
          this._send(conn, { t: 'welcome', id: msg.id });
          this.h.onJoined(msg.id);
        } else {
          this._send(conn, { t: 'reject', error: res.error });
          setTimeout(() => conn.close(), 500);
        }
      } else if (!entry.pid) {
        // ignore anything before hello
      } else if (msg.t === 'act') {
        this.h.onAction(entry.pid, msg.action);
      } else if (msg.t === 'react') {
        this.h.onReact(entry.pid, msg.emoji);
      }
    });
    conn.on('close', () => this._drop(conn.connectionId));
    conn.on('error', () => this._drop(conn.connectionId));
  }

  _drop(connectionId) {
    const e = this.conns.get(connectionId);
    if (!e) return;
    this.conns.delete(connectionId);
    if (e.pid && ![...this.conns.values()].some((x) => x.pid === e.pid)) this.h.onDrop(e.pid);
  }

  _sweep() {
    const now = Date.now();
    for (const [id, e] of this.conns) {
      if (now - e.lastSeen > TIMEOUT_MS) {
        try {
          e.conn.close();
        } catch {
          /* already closed */
        }
        this._drop(id);
      } else {
        this._send(e.conn, { t: 'ping' });
      }
    }
  }

  _send(conn, msg) {
    try {
      if (conn.open) conn.send(msg);
    } catch {
      /* channel closing */
    }
  }

  sendTo(pid, msg) {
    for (const e of this.conns.values()) if (e.pid === pid) this._send(e.conn, msg);
  }

  // makeMsg(pid) builds the message for each connected player.
  broadcast(makeMsg) {
    for (const e of this.conns.values()) if (e.pid) this._send(e.conn, makeMsg(e.pid));
  }

  close() {
    clearInterval(this.watchdog);
    for (const e of this.conns.values()) {
      this._send(e.conn, { t: 'closed' });
    }
    setTimeout(() => this.peer && this.peer.destroy(), 300);
  }
}

// ---------- client ----------

export class ClientNet {
  constructor(code, hello, handlers) {
    this.code = code;
    this.hello = hello; // { id, name }
    this.h = handlers; // { onMessage(msg), onStatus(status) }
    this.peer = null;
    this.conn = null;
    this.stopped = false;
    this.welcomed = false;
    this.lastSeen = 0;
    this.attempt = 0;
    this.beat = null;
  }

  start() {
    this.peer = new Peer(peerOptions());
    this.peer.on('open', () => this._connect());
    this.peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        this.h.onStatus(this.welcomed ? 'reconnecting' : 'no-room');
        this._retry();
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.h.onStatus('reconnecting');
        setTimeout(() => !this.stopped && this.peer.disconnected && this.peer.reconnect(), 2000);
      }
    });
    this.peer.on('disconnected', () => {
      setTimeout(() => !this.stopped && this.peer.disconnected && this.peer.reconnect(), 1500);
    });
    this.beat = setInterval(() => {
      if (this.conn?.open) this._send({ t: 'ping' });
      if (this.welcomed && this.lastSeen && Date.now() - this.lastSeen > TIMEOUT_MS) {
        this.lastSeen = 0;
        this.h.onStatus('reconnecting');
        try {
          this.conn?.close();
        } catch {
          /* ignore */
        }
        this._retry();
      }
    }, HEARTBEAT_MS);
  }

  _connect() {
    if (this.stopped) return;
    this.attempt += 1;
    const conn = this.peer.connect(peerIdFor(this.code), { reliable: true, serialization: 'json' });
    this.conn = conn;
    const timer = setTimeout(() => {
      if (!conn.open) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        this._retry();
      }
    }, 9000);
    conn.on('open', () => {
      clearTimeout(timer);
      this.attempt = 0;
      this.lastSeen = Date.now();
      this._send({ t: 'hello', ...this.hello });
    });
    conn.on('data', (msg) => {
      this.lastSeen = Date.now();
      if (msg?.t === 'welcome') {
        this.welcomed = true;
        this.h.onStatus('connected');
      }
      if (msg?.t === 'closed') {
        this.stopped = true;
        this.h.onStatus('closed');
        return;
      }
      if (msg?.t === 'reject') this.stopped = true;
      this.h.onMessage(msg);
    });
    conn.on('close', () => {
      if (this.conn !== conn || this.stopped) return;
      this.h.onStatus('reconnecting');
      this._retry();
    });
  }

  _retry() {
    if (this.stopped || this._retrying) return;
    this._retrying = true;
    const wait = Math.min(1000 + this.attempt * 700, 4000);
    setTimeout(() => {
      this._retrying = false;
      if (this.stopped) return;
      if (this.peer.disconnected) this.peer.reconnect();
      this._connect();
    }, wait);
  }

  _send(msg) {
    try {
      if (this.conn?.open) this.conn.send(msg);
    } catch {
      /* closing */
    }
  }

  act(action) {
    this._send({ t: 'act', action });
  }

  react(emoji) {
    this._send({ t: 'react', emoji });
  }

  close() {
    this.stopped = true;
    clearInterval(this.beat);
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.peer?.destroy();
  }
}
