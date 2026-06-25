// ============================================================================
//  webrtc.js — 1:1 audio/video call manager (browser). Peer-to-peer WebRTC;
//  signaling (offer/answer/ICE) is relayed by the server over the SSE stream.
//  Public STUN for NAT traversal — no TURN, so very restrictive/symmetric-NAT
//  networks may not connect (that needs a relay server). The store provides the
//  `signal(to, msg)` sender and subscribes to `onChange` for the UI.
// ============================================================================

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function callsSupported() {
  return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export class CallManager {
  constructor(signal, onChange) {
    this.signal = signal;          // (toUsername, msg) => void
    this.onChange = onChange;      // (snapshot) => void
    this.reset();
  }

  reset() {
    this.pc = null;
    this.local = null;
    this.remote = null;
    this.peer = null;              // { username, name }
    this.state = 'idle';           // idle | calling | ringing | connected | ended
    this.video = false;
    this.muted = false;
    this.cameraOff = false;
    this._offer = null;
    this._pendingIce = [];
  }

  snapshot() {
    return { state: this.state, peer: this.peer, local: this.local, remote: this.remote, video: this.video, muted: this.muted, cameraOff: this.cameraOff };
  }
  _emit() { if (this.onChange) this.onChange(this.snapshot()); }

  async _media(video) {
    this.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
    return this.local;
  }
  _peerConn(peerUsername) {
    const pc = new RTCPeerConnection(ICE);
    pc.onicecandidate = (e) => { if (e.candidate) this.signal(peerUsername, { type: 'ice', candidate: e.candidate }); };
    pc.ontrack = (e) => { this.remote = e.streams[0]; this._emit(); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && this.state === 'connected') this._end();
    };
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local));
    return pc;
  }

  // Place an outgoing call.
  async call(peer, video) {
    if (this.state !== 'idle') return;
    this.peer = peer; this.video = !!video; this.state = 'calling'; this._emit();
    try {
      await this._media(video);
      this.pc = this._peerConn(peer.username);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signal(peer.username, { type: 'offer', sdp: offer.sdp, video: !!video });
      this._emit();
    } catch (e) { this._cleanup(); this.reset(); this._emit(); throw e; }
  }

  // Handle a relayed signaling message from the peer.
  async handleSignal(msg) {
    try {
      if (msg.type === 'offer') {
        if (this.state !== 'idle') { this.signal(msg.from, { type: 'decline' }); return; }   // busy
        this.peer = { username: msg.from, name: msg.fromName };
        this.video = !!msg.video; this._offer = msg.sdp; this.state = 'ringing'; this._emit();
      } else if (msg.type === 'answer') {
        if (this.pc) { await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); await this._flushIce(); }
        this.state = 'connected'; this._emit();
      } else if (msg.type === 'ice') {
        if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) await this.pc.addIceCandidate(msg.candidate).catch(() => {});
        else this._pendingIce.push(msg.candidate);
      } else if (msg.type === 'decline') {
        this.state = 'ended'; this._emit(); this._cleanup(); setTimeout(() => { this.reset(); this._emit(); }, 1400);
      } else if (msg.type === 'end') {
        this._end();
      }
    } catch { /* swallow signaling races */ }
  }
  async _flushIce() { for (const c of this._pendingIce) await this.pc.addIceCandidate(c).catch(() => {}); this._pendingIce = []; }

  // Accept an incoming (ringing) call.
  async accept() {
    if (this.state !== 'ringing') return;
    try {
      await this._media(this.video);
      this.pc = this._peerConn(this.peer.username);
      await this.pc.setRemoteDescription({ type: 'offer', sdp: this._offer });
      await this._flushIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signal(this.peer.username, { type: 'answer', sdp: answer.sdp });
      this.state = 'connected'; this._emit();
    } catch (e) { this.decline(); throw e; }
  }

  decline() { if (this.peer) this.signal(this.peer.username, { type: 'decline' }); this._cleanup(); this.reset(); this._emit(); }
  hangup() { if (this.peer) this.signal(this.peer.username, { type: 'end' }); this._end(); }

  toggleMute() { this.muted = !this.muted; if (this.local) this.local.getAudioTracks().forEach((t) => { t.enabled = !this.muted; }); this._emit(); }
  toggleCamera() { this.cameraOff = !this.cameraOff; if (this.local) this.local.getVideoTracks().forEach((t) => { t.enabled = !this.cameraOff; }); this._emit(); }

  _end() { this.state = 'ended'; this._emit(); this._cleanup(); setTimeout(() => { this.reset(); this._emit(); }, 800); }
  _cleanup() {
    try { if (this.pc) this.pc.close(); } catch { /* ignore */ }
    this.pc = null;
    if (this.local) this.local.getTracks().forEach((t) => t.stop());
    this.local = null; this.remote = null;
  }
}
