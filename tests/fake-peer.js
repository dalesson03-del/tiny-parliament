// Test-only stand-in for PeerJS. Tabs in one browser talk over BroadcastChannel,
// with the same API surface Tiny Parliament uses (open/connection/error events,
// connect(), send(), close()). Injected by tests/e2e.mjs; never shipped to players.
(() => {
  class Emitter {
    constructor() {
      this._h = {};
    }
    on(ev, fn) {
      (this._h[ev] ||= []).push(fn);
      return this;
    }
    emit(ev, ...a) {
      (this._h[ev] || []).forEach((fn) => fn(...a));
    }
  }
  const fresh = (id) => {
    const t = Number(localStorage.getItem('fp-' + id) || 0);
    return Date.now() - t < 2500;
  };
  const rid = () => Math.random().toString(36).slice(2, 10);

  class Conn extends Emitter {
    constructor(peer, cid, other) {
      super();
      this.peer = peer;
      this.connectionId = cid;
      this.peerId = other;
      this.open = false;
      this.ch = new BroadcastChannel('fp-conn-' + cid);
      this.ch.onmessage = (e) => {
        const m = e.data;
        if (m.from === peer.id) return;
        if (m.k === 'open' && !this.open) {
          this.open = true;
          this.ch.postMessage({ from: peer.id, k: 'open' });
          this.emit('open');
        } else if (m.k === 'data' && this.open) this.emit('data', JSON.parse(m.d));
        else if (m.k === 'close') this._closed();
      };
    }
    send(d) {
      if (this.open) this.ch.postMessage({ from: this.peer.id, k: 'data', d: JSON.stringify(d) });
    }
    close() {
      if (!this.ch) return;
      this.ch.postMessage({ from: this.peer.id, k: 'close' });
      this._closed();
    }
    _closed() {
      if (!this.ch) return;
      const was = this.open;
      this.open = false;
      this.ch.close();
      this.ch = null;
      if (was || true) this.emit('close');
    }
  }

  class Peer extends Emitter {
    constructor(id, opts) {
      super();
      if (typeof id !== 'string') id = 'anon-' + rid();
      this.id = id;
      this.destroyed = false;
      this.disconnected = false;
      this.conns = [];
      setTimeout(() => {
        if (fresh(id)) {
          const err = new Error('id taken');
          err.type = 'unavailable-id';
          this.emit('error', err);
          return;
        }
        localStorage.setItem('fp-' + id, Date.now());
        this.beat = setInterval(() => localStorage.setItem('fp-' + id, Date.now()), 800);
        this.ch = new BroadcastChannel('fp-' + id);
        this.ch.onmessage = (e) => {
          if (e.data.k !== 'connect') return;
          const c = new Conn(this, e.data.cid, e.data.from);
          this.conns.push(c);
          this.emit('connection', c);
          c.ch.postMessage({ from: this.id, k: 'open' });
        };
        this.emit('open', id);
      }, 30);
      addEventListener('pagehide', () => this.destroy());
    }
    connect(target) {
      const c = new Conn(this, rid(), target);
      setTimeout(() => {
        if (!fresh(target)) {
          const err = new Error('unavailable');
          err.type = 'peer-unavailable';
          this.emit('error', err);
          return;
        }
        new BroadcastChannel('fp-' + target).postMessage({ k: 'connect', cid: c.connectionId, from: this.id });
      }, 20);
      this.conns.push(c);
      return c;
    }
    reconnect() {}
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      clearInterval(this.beat);
      localStorage.removeItem('fp-' + this.id);
      this.conns.forEach((c) => c.close());
      this.ch?.close();
    }
  }
  window.Peer = Peer;
})();
