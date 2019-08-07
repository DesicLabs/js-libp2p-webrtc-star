'use strict'

const config = require('../config');
const log = config.log;
const SocketIO = require('socket.io');
const client = require('prom-client');
const jwt = require('jsonwebtoken');

const fake = {
  gauge: {
    set: () => {}
  },
  counter: {
    inc: () => {}
  }
}

module.exports = (http, hasMetrics) => {
  const io = new SocketIO(http.listener)
  io.on('connection', handle)

  const peers = {}

  const peersMetric = hasMetrics ? new client.Gauge({ name: 'signalling_peers', help: 'peers online now' }) : fake.gauge
  const dialsSuccessTotal = hasMetrics ? new client.Counter({ name: 'signalling_dials_total_success', help: 'sucessfully completed dials since server started' }) : fake.counter
  const dialsFailureTotal = hasMetrics ? new client.Counter({ name: 'signalling_dials_total_failure', help: 'failed dials since server started' }) : fake.counter
  const dialsTotal = hasMetrics ? new client.Counter({ name: 'signalling_dials_total', help: 'all dials since server started' }) : fake.counter
  const joinsSuccessTotal = hasMetrics ? new client.Counter({ name: 'signalling_joins_total_success', help: 'sucessfully completed joins since server started' }) : fake.counter
  const joinsFailureTotal = hasMetrics ? new client.Counter({ name: 'signalling_joins_total_failure', help: 'failed joins since server started' }) : fake.counter
  const joinsTotal = hasMetrics ? new client.Counter({ name: 'signalling_joins_total', help: 'all joins since server started' }) : fake.counter

  const refreshMetrics = () => peersMetric.set(Object.keys(peers).length)

  this.peers = () => {
    return peers
  }

  function safeEmit (addr, event, arg) {
    const peer = peers[addr]
    if (!peer) {
      log('trying to emit %s but peer is gone', event)
      return
    }

    peer.emit(event, arg)
  }

  function authenticate(socket, callback) {
    const authHeader = socket.handshake.headers['Authorization'];
    if (!authHeader) {
      callback("No authorization header", null);
    }
    headerParts = authHeader.split(' ').filter(p => p.length > 0);
    
    if (headerParts.length != 2) {
      callback ("Malformed auth header", null);
      return;
    }

    const authType = headerParts[0].toLocaleLowercase();
    if (authType !== 'bearer') {
      callback (`Auth type ${authType} not recognized`, null);
      return;
    }

    jwt.verify(headerParts[1], 'dsfdasfads', {
      audience: 'privacypal',
      issuer: 'privacypal',
    }, function (err, decoded) {
      if (err) {
        callback("Error validating jwt: " + err, null);
      } else {
        callback(null, decoded.id);
      }
    });
  }

  function handle (socket) {
    authenticate(socket, (err, user) => {
      if(err) {
        socket.disconnect();
      } else {
        socket.on('ss-join', join.bind(socket))
        socket.on('ss-leave', leave.bind(socket))
        socket.on('disconnect', disconnect.bind(socket)) // socket.io own event
        socket.on('ss-handshake', forwardHandshake)
      }
    });
  }

  // join this signaling server network
  function join (multiaddr) {
    joinsTotal.inc()
    if (!multiaddr) { return joinsFailureTotal.inc() }
    const socket = peers[multiaddr] = this // socket
    let refreshInterval = setInterval(sendPeers, config.refreshPeerListIntervalMS)

    socket.once('ss-leave', stopSendingPeers)
    socket.once('disconnect', stopSendingPeers)

    sendPeers()

    function sendPeers () {
      Object.keys(peers).forEach((mh) => {
        if (mh === multiaddr) {
          return
        }
        safeEmit(mh, 'ws-peer', multiaddr)
      })
    }

    function stopSendingPeers () {
      if (refreshInterval) {
        clearInterval(refreshInterval)
        refreshInterval = null
      }
    }

    joinsSuccessTotal.inc()
    refreshMetrics()
  }

  function leave (multiaddr) {
    if (!multiaddr) { return }
    if (peers[multiaddr]) {
      delete peers[multiaddr]
      refreshMetrics()
    }
  }

  function disconnect () {
    Object.keys(peers).forEach((mh) => {
      if (peers[mh].id === this.id) {
        delete peers[mh]
      }
      refreshMetrics()
    })
  }

  // forward an WebRTC offer to another peer
  function forwardHandshake (offer) {
    dialsTotal.inc()
    if (offer == null || typeof offer !== 'object' || !offer.srcMultiaddr || !offer.dstMultiaddr) { return dialsFailureTotal.inc() }
    if (offer.answer) {
      dialsSuccessTotal.inc()
      safeEmit(offer.srcMultiaddr, 'ws-handshake', offer)
    } else {
      if (peers[offer.dstMultiaddr]) {
        safeEmit(offer.dstMultiaddr, 'ws-handshake', offer)
      } else {
        dialsFailureTotal.inc()
        offer.err = 'peer is not available'
        safeEmit(offer.srcMultiaddr, 'ws-handshake', offer)
      }
    }
  }

  return this
}
