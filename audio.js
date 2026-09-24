// Microphone capture (16 kHz Int16, 200 ms frames), playback of relayed
// audio, and screen wake lock.
const FRAME = 3200;
const Ctx = window.AudioContext || window.webkitAudioContext;

class Downsampler {  // same as the worklet, for browsers without it
  constructor(rate, emit) {
    this.ratio = rate / 16000;
    this.emit = emit;
    this.frame = new Int16Array(FRAME);
    this.n = 0;
    this.acc = 0;
    this.cnt = 0;
    this.pos = 0;
  }

  push(ch) {
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.round((this.acc / this.cnt) * 32767);
        this.acc = 0;
        this.cnt = 0;
        this.frame[this.n++] = Math.max(-32768, Math.min(32767, v));
        if (this.n === FRAME) {
          this.emit(this.frame.buffer);
          this.frame = new Int16Array(FRAME);
          this.n = 0;
        }
      }
    }
  }
}

export class Mic {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.ctx = null;
    this.stream = null;
    this.nodes = [];
  }

  get ready() {
    return !!(this.stream && this.stream.active && this.ctx &&
              this.ctx.state !== "closed");
  }

  async open() {  // call from a tap
    if (this.ready) {
      await this.ctx.resume();
      return;
    }
    this.close();
    const ctx = new Ctx();       // created inside the tap (needed on iOS)
    const resumed = ctx.resume();
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true,
                 noiseSuppression: true, autoGainControl: true },
      });
      const src = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      let node;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule(
          new URL("./capture-worklet.js", import.meta.url).href);
        node = new AudioWorkletNode(ctx, "capture", {
          channelCount: 1, channelCountMode: "explicit" });
        node.port.onmessage = (e) => this.onFrame(e.data);
      } else {
        const ds = new Downsampler(ctx.sampleRate, (b) => this.onFrame(b));
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => ds.push(e.inputBuffer.getChannelData(0));
      }
      src.connect(node);
      node.connect(sink);
      await resumed;
      this.ctx = ctx;
      this.stream = stream;
      this.nodes = [src, node, sink];
    } catch (e) {
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      ctx.close();
      throw e;
    }
  }

  close() {
    if (this.stream) this.stream.getTracks().forEach((tr) => tr.stop());
    this.nodes.forEach((n) => n.disconnect());
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.nodes = [];
  }
}

export class Player {  // plays relayed 16 kHz Int16 frames
  constructor() {
    this.ctx = null;
    this.next = 0;
    this.enabled = false;
  }

  async enable() {
    this.enabled = true;
    if (!this.ctx) this.ctx = new Ctx();
    await this.ctx.resume();
  }

  disable() {
    this.enabled = false;
  }

  reset() {
    this.next = 0;
  }

  play(data) {
    if (!this.enabled || !this.ctx || this.ctx.state !== "running") return;
    const pcm = new Int16Array(data);
    if (!pcm.length) return;
    const now = this.ctx.currentTime;
    if (this.next > now + 1.0) return;  // too far behind: drop a frame
    if (this.next < now + 0.05) this.next = now + 0.25;  // jitter buffer
    const buf = this.ctx.createBuffer(1, pcm.length, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(this.next);
    this.next += buf.duration;
  }
}

let wakeLock = null;
export async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock &&
        document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) {
    // not supported or not allowed: ignore
  }
}
