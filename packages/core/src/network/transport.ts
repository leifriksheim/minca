/**
 * What the mesh and network managers need from any way of moving bytes
 * between peers.
 *
 * Two kinds exist. A **signalled** transport (WebRTC) cannot open a connection
 * on its own: an offer and an answer have to be carried to the other side by
 * something else — a relay, or a peer already connected to both. An
 * **unsignalled** one (a WebSocket to an always-on node, an in-memory fake in
 * tests) just dials. The first kind is the mesh's (`mesh.ts`); the second, a
 * network manager's (`network-manager.ts`).
 */

export type PeerTransportEvents = {
  data: (peerId: string, data: Uint8Array) => void;
  connected: (peerId: string) => void;
  disconnected: (peerId: string) => void;
  error: (peerId: string, error: Error) => void;
};

export interface PeerTransport {
  /**
   * Starts dialling, for a transport that reaches out on its own. Called by
   * the network manager's `connect()`. A signalled transport has nothing to
   * start — its connections begin with an offer.
   */
  readonly connect?: () => Promise<void>;
  readonly send: (peerId: string, data: Uint8Array) => void;
  readonly close: (peerId: string) => void;
  /** Closes every connection. Deliberate: a transport must not reconnect after it. */
  readonly closeAll: () => void;
  readonly on: <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) => void;
  readonly off: <K extends keyof PeerTransportEvents>(event: K, callback: PeerTransportEvents[K]) => void;
  /**
   * The certificates of one open connection's two ends, for binding the peer
   * handshake to it (`peer-auth.ts`). Absent where the connection has none.
   */
  readonly binding?: (peerId: string) => { readonly local: string; readonly remote: string } | null;
}

/**
 * A transport whose connections start with an offer and an answer. Each
 * carries its ICE candidates inside it, gathered before it is handed over, so
 * a connection takes one message each way and nothing trickles after.
 */
export interface SignalledTransport extends PeerTransport {
  /** Opens a connection and returns the offer to carry to the peer. */
  readonly createOffer: (peerId: string) => Promise<RTCSessionDescriptionInit>;
  /** Accepts a peer's offer and returns the answer to carry back. */
  readonly handleOffer: (
    peerId: string,
    offer: RTCSessionDescriptionInit,
  ) => Promise<RTCSessionDescriptionInit>;
  readonly handleAnswer: (peerId: string, answer: RTCSessionDescriptionInit) => Promise<void>;
}
