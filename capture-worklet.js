// Audio thread: downsample the mic to 16 kHz mono Int16 and post 200 ms
// frames. Averaging over each output interval acts as a simple
// anti-aliasing filter.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.frame = new Int16Array(3200);
    this.n = 0;
    this.acc = 0;
    this.cnt = 0;
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
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
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(3200);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", Capture);
