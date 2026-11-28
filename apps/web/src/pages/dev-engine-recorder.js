// AudioWorklet processor of the /dev/engine page: passes its input through and, while asked
// to, sends it to the page in blocks, so scripts/e2e-engine.mjs can compare what the engine
// played with what it was given, sample by sample. A file of its own, as the server's
// Content-Security-Policy loads worklets from the server only.
const BLOCK_FRAMES = 4096

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.left = new Float32Array(BLOCK_FRAMES)
    this.right = new Float32Array(BLOCK_FRAMES)
    this.filled = 0
    this.port.onmessage = ({ data }) => {
      if (data === 'start') {
        this.recording = true
        this.filled = 0
      } else if (data === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage('stopped')
      }
    }
  }

  flush() {
    if (!this.filled) return
    this.port.postMessage([this.left.slice(0, this.filled), this.right.slice(0, this.filled)])
    this.filled = 0
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? []
    const output = outputs[0] ?? []
    const frames = output[0]?.length ?? 128
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] ?? input[0]
      if (source) output[channel].set(source)
      else output[channel].fill(0)
    }
    if (!this.recording) return true
    for (let frame = 0; frame < frames; frame += 1) {
      this.left[this.filled] = input[0]?.[frame] ?? 0
      this.right[this.filled] = (input[1] ?? input[0])?.[frame] ?? 0
      this.filled += 1
      if (this.filled === BLOCK_FRAMES) this.flush()
    }
    return true
  }
}

registerProcessor('squirmy-recorder', Recorder)
