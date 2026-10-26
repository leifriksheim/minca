import type { PeerTransportEvents, SignalledTransport } from './transport.js';
import { createEmitter } from '../utils/events.js';
import { bufferSource } from '../utils/guards.js';

interface RTCTransportConfig {
  /** Fixed, or asked for each new connection — TURN passwords a relay hands out change */
  readonly iceServers?: ReadonlyArray<RTCIceServer> | (() => ReadonlyArray<RTCIceServer>);
}

interface PeerConnectionData {
  readonly connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

/** The DTLS certificate fingerprint a session description commits to */
function fingerprintOf(description: RTCSessionDescription | null): string | null {
  const match = description?.sdp?.match(/^a=fingerprint:\s*(\S+)\s+(\S+)/im);
  return match ? `${match[1]!.toLowerCase()} ${match[2]!.toUpperCase()}` : null;
}

/** How long to gather ICE candidates before handing a description over with what there is */
const GATHER_MS = 2000;

/** The description once ICE gathering is done, or has had its time: its candidates travel inside it */
function gathered(connection: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', check);
      const description = connection.localDescription;
      if (description) resolve({ type: description.type, sdp: description.sdp });
      else reject(new Error('The connection has no description to send'));
    };
    const check = () => {
      if (connection.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_MS);
    connection.addEventListener('icegatheringstatechange', check);
    check();
  });
}

export const DEFAULT_ICE_SERVERS: ReadonlyArray<RTCIceServer> = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** WebRTC data channels: a transport whose connections start with an offer. */
export function createRTCTransport(config?: RTCTransportConfig): SignalledTransport {
  const configured = config?.iceServers ?? DEFAULT_ICE_SERVERS;
  const iceServers = () => (typeof configured === 'function' ? configured() : configured);
  const connections = new Map<string, PeerConnectionData>();

  const { on, off, emit } = createEmitter<PeerTransportEvents>();

  const setupDataChannel = (peerId: string, channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';
    const peerData = connections.get(peerId);
    if (peerData) peerData.channel = channel;
    channel.onopen = () => emit('connected', peerId);
    channel.onclose = () => {
      emit('disconnected', peerId);
      close(peerId);
    };
    channel.onerror = (ev) => emit('error', peerId, ev.error || new Error('Data channel error'));
    // Only binary is ever sent.
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) emit('data', peerId, new Uint8Array(event.data));
    };
  };

  const createConnection = (peerId: string): RTCPeerConnection => {
    close(peerId);
    const connection = new RTCPeerConnection({ iceServers: [...iceServers()] });
    connections.set(peerId, { connection, channel: null });
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        emit('disconnected', peerId);
        close(peerId);
      }
    };
    return connection;
  };

  const createOffer = async (peerId: string): Promise<RTCSessionDescriptionInit> => {
    const connection = createConnection(peerId);
    setupDataChannel(peerId, connection.createDataChannel('data', { ordered: true }));
    await connection.setLocalDescription(await connection.createOffer());
    return gathered(connection);
  };

  const handleOffer = async (
    peerId: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> => {
    const connection = createConnection(peerId);
    connection.ondatachannel = (event) => setupDataChannel(peerId, event.channel);
    await connection.setRemoteDescription(offer);
    await connection.setLocalDescription(await connection.createAnswer());
    return gathered(connection);
  };

  const connectionOf = (peerId: string): RTCPeerConnection => {
    const peerData = connections.get(peerId);
    if (!peerData) throw new Error(`No connection found for peer ${peerId}`);
    return peerData.connection;
  };

  const send = (peerId: string, data: Uint8Array): void => {
    const channel = connections.get(peerId)?.channel;
    if (channel?.readyState !== 'open') throw new Error(`Data channel not open for peer ${peerId}`);
    // The whole buffer, not just the view: callers pass bytes that fill theirs.
    channel.send(bufferSource(data).buffer);
  };

  const close = (peerId: string): void => {
    const peerData = connections.get(peerId);
    if (!peerData) return;
    peerData.channel?.close();
    peerData.connection.close();
    connections.delete(peerId);
  };

  const binding = (peerId: string) => {
    const connection = connections.get(peerId)?.connection;
    const local = fingerprintOf(connection?.localDescription ?? null);
    const remote = fingerprintOf(connection?.remoteDescription ?? null);
    return local && remote ? { local, remote } : null;
  };

  return Object.freeze({
    createOffer,
    handleOffer,
    handleAnswer: async (peerId: string, answer: RTCSessionDescriptionInit) =>
      connectionOf(peerId).setRemoteDescription(answer),
    send,
    close,
    closeAll: () => [...connections.keys()].forEach(close),
    binding,
    on,
    off,
  });
}
