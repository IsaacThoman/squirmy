import { StringDecoder } from 'node:string_decoder'

const COMMA = 44
const QUOTE = 34
const LF = 10
const CR = 13

const State = { FieldStart: 0, Unquoted: 1, Quoted: 2, QuoteInQuoted: 3 } as const

/**
 * Parses RFC 4180 CSV from a byte stream: quoted fields may hold commas, line breaks
 * and doubled quotes; lines end in LF or CRLF; blank lines are skipped. Yields the
 * rows completed by each input chunk, so a caller handles batches rather than single
 * rows. State carries across chunks, so memory stays bounded by the longest row.
 */
export async function* parseCsv(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string[][]> {
  const decoder = new StringDecoder('utf8')
  let state: number = State.FieldStart
  let field = ''
  let row: string[] = []
  let rows: string[][] = []

  const endRow = () => {
    rows.push(row)
    row = []
  }

  const consume = (text: string) => {
    let start = 0
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i)
      switch (state) {
        case State.FieldStart:
          if (char === QUOTE) {
            state = State.Quoted
            start = i + 1
          } else if (char === COMMA) {
            row.push('')
          } else if (char === LF) {
            // A line break right after a comma ends an empty last field; on its own it is a blank line.
            if (row.length > 0) {
              row.push('')
              endRow()
            }
          } else if (char !== CR) {
            state = State.Unquoted
            start = i
          }
          break
        case State.Unquoted:
          if (char === COMMA || char === LF) {
            let value = field + text.slice(start, i)
            if (char === LF && value.endsWith('\r')) value = value.slice(0, -1)
            row.push(value)
            field = ''
            state = State.FieldStart
            if (char === LF) endRow()
          }
          break
        case State.Quoted:
          if (char === QUOTE) {
            field += text.slice(start, i)
            state = State.QuoteInQuoted
          }
          break
        case State.QuoteInQuoted:
          if (char === QUOTE) {
            field += '"'
            start = i + 1
            state = State.Quoted
          } else if (char === COMMA || char === LF) {
            row.push(field)
            field = ''
            state = State.FieldStart
            if (char === LF) endRow()
          } else if (char !== CR) {
            throw new Error(`Malformed CSV: unexpected character after a closing quote near "${text.slice(Math.max(0, i - 40), i + 1)}"`)
          }
          break
      }
    }
    if (state === State.Unquoted || state === State.Quoted) field += text.slice(start)
  }

  for await (const chunk of chunks) {
    consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    if (rows.length > 0) {
      yield rows
      rows = []
    }
  }
  consume(decoder.end())
  if (state === State.Quoted) throw new Error('Malformed CSV: the input ended inside a quoted field')
  if (state !== State.FieldStart || row.length > 0) {
    row.push(state === State.Unquoted && field.endsWith('\r') ? field.slice(0, -1) : field)
    endRow()
  }
  if (rows.length > 0) yield rows
}
