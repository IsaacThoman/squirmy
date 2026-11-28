/**
 * Power spectrum of a real frame, for a fixed power-of-two size. The frame is packed into
 * a complex FFT of half the size (even samples real, odd samples imaginary) and the halves
 * are separated afterwards, which halves the work of a plain complex transform.
 */
export class RealFft {
  readonly size: number
  private readonly half: number
  private readonly re: Float64Array
  private readonly im: Float64Array
  /** cos and sin of 2πj / half, for the complex transform. */
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  /** cos and sin of 2πk / size, for separating the halves. */
  private readonly splitCos: Float64Array
  private readonly splitSin: Float64Array
  private readonly reversed: Uint32Array

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
    this.size = size
    this.half = size >> 1
    this.re = new Float64Array(this.half)
    this.im = new Float64Array(this.half)
    this.cos = new Float64Array(this.half >> 1)
    this.sin = new Float64Array(this.half >> 1)
    for (let j = 0; j < this.half >> 1; j++) {
      this.cos[j] = Math.cos((2 * Math.PI * j) / this.half)
      this.sin[j] = Math.sin((2 * Math.PI * j) / this.half)
    }
    this.splitCos = new Float64Array(this.half + 1)
    this.splitSin = new Float64Array(this.half + 1)
    for (let k = 0; k <= this.half; k++) {
      this.splitCos[k] = Math.cos((2 * Math.PI * k) / size)
      this.splitSin[k] = Math.sin((2 * Math.PI * k) / size)
    }
    const bits = Math.log2(this.half)
    this.reversed = new Uint32Array(this.half)
    for (let i = 0; i < this.half; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reversed[i] = r
    }
  }

  /** Writes |X[k]|² for k = 0..size/2 into `out` (length size/2 + 1). */
  power(input: Float64Array, out: Float64Array): void {
    const { half, re, im, reversed } = this
    for (let i = 0; i < half; i++) {
      const j = reversed[i]!
      re[j] = input[2 * i]!
      im[j] = input[2 * i + 1]!
    }
    for (let span = 2; span <= half; span <<= 1) {
      const halfSpan = span >> 1
      const step = half / span
      for (let start = 0; start < half; start += span) {
        for (let k = 0; k < halfSpan; k++) {
          const wr = this.cos[k * step]!
          const wi = -this.sin[k * step]!
          const a = start + k
          const b = a + halfSpan
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
    for (let k = 0; k <= half; k++) {
      const zr = re[k % half]!
      const zi = im[k % half]!
      const yr = re[(half - k) % half]!
      const yi = im[(half - k) % half]!
      // Even samples' spectrum, and the odd samples' one rotated by e^(-2πik/size).
      const er = (zr + yr) / 2
      const ei = (zi - yi) / 2
      const or = (zi + yi) / 2
      const oi = -(zr - yr) / 2
      const c = this.splitCos[k]!
      const s = this.splitSin[k]!
      const xr = er + c * or + s * oi
      const xi = ei + c * oi - s * or
      out[k] = xr * xr + xi * xi
    }
  }
}
